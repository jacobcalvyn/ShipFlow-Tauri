// @vitest-environment node
import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DOCKER_CONFIG } from '../../src/backend/docker-contract';
import { createDockerRunner, dockerExecutable, type DockerRun } from './docker-command-runner';
import { DockerDeploymentManager } from './docker-deployment-manager';

it.skipIf(process.env.SHIPFLOW_TEST_DOCKER !== '1')('deploys, restarts, redeploys, and rolls back an isolated real Docker service', async () => {
  const namespace = `shipflow-test-${randomBytes(8).toString('hex')}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ShipFlow Docker ü '));
  const release = JSON.parse(await readFile('build/release.json', 'utf8'));
  const run = createDockerRunner(process.env.CI ? '/usr/bin/docker' : await dockerExecutable());
  let rejectNextStart = false;
  const injectedRun: DockerRun = async (args, options) => {
    if (rejectNextStart && args[0] === 'container' && args[1] === 'start') {
      rejectNextStart = false;
      throw new Error('Injected candidate startup failure');
    }
    return run(args, options);
  };
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // Ephemeral fixture credentials only. Production uses Electron safeStorage.
  const options = { directory, bundleDirectory: path.resolve('build/docker'), release, publicKey: '', allowUnsigned: true,
    supported: true, run: injectedRun, testNamespace: namespace, seal: (value: string) => value, unseal: (value: string) => value };
  const manager = new DockerDeploymentManager(options);
  try {
    await manager.save({ ...DEFAULT_DOCKER_CONFIG, port });
    await manager.action('deploy');
    expect((await manager.status()).synchronized).toBe(true);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/readiness`);
    expect(unauthorized.status).toBe(401);
    await run(['exec', namespace, '/usr/local/bin/shipflow-service', '--healthcheck']);
    await run(['exec', namespace, '/bin/sh', '-c', 'test -s /data/lookup-store.sqlite3 && test -s /data/contact-store.sqlite3 && test -s /data/bag-route-store.sqlite3 && printf durable > /data/integration-marker']);
    await manager.action('restart');
    expect(await run(['exec', namespace, 'cat', '/data/integration-marker'])).toBe('durable');
    await manager.action('deploy');
    expect((await manager.status()).synchronized).toBe(true);
    expect(await run(['exec', namespace, 'cat', '/data/integration-marker'])).toBe('durable');
    const before = JSON.parse(await run(['container', 'inspect', namespace]))[0].Id;
    rejectNextStart = true;
    await expect(manager.action('deploy')).rejects.toThrow('previous deployment was restored');
    expect(JSON.parse(await run(['container', 'inspect', namespace]))[0].Id).toBe(before);
    expect((await manager.status()).apiReady).toBe(true);
    expect(await run(['exec', namespace, 'cat', '/data/integration-marker'])).toBe('durable');
    // Recreating the application-side manager leaves the independently running service healthy.
    expect((await new DockerDeploymentManager(options).status()).synchronized).toBe(true);
    await manager.action('stop');
    expect(JSON.parse(await run(['container', 'inspect', namespace]))[0].State.ExitCode).toBe(0);
    expect((await manager.status()).apiReady).toBe(false);
    await manager.action('start');
    expect((await manager.status()).apiReady).toBe(true);
  } catch (error) {
    const detail = await manager.logs().catch(() => 'Container diagnostics unavailable.');
    throw new Error(`${(error as Error).message}\n${detail}`);
  } finally {
    // Delete only resources created under this cryptographically random test namespace.
    for (const suffix of ['', '-next', '-previous', '-maintenance']) {
      const ids = await run(['container', 'ls', '-a', '--filter', `name=^/${namespace}${suffix}$`, '--format', '{{.ID}}']);
      if (ids) await run(['container', 'rm', '--force', ids]);
    }
    for (const suffix of ['-data', '-backup']) {
      const names = await run(['volume', 'ls', '--filter', `name=^${namespace}${suffix}$`, '--format', '{{.Name}}']);
      if (names) await run(['volume', 'rm', names]);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 600000);
