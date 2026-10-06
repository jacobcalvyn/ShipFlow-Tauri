// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DOCKER_CONFIG, validateDockerConfig, type ReleaseIdentity } from '../../src/backend/docker-contract';
import { DockerDeploymentManager, configArchive } from './docker-deployment-manager';
import { verifyBundle } from './docker-bundle';
import { assertLocalLinuxDocker, type DockerRun } from './docker-command-runner';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const release: ReleaseIdentity = { version: '1.2.3', commit: 'a'.repeat(40), sourceHash: 'b'.repeat(64), releaseId: 'release-a', apiVersion: 'v1', storageVersion: 1 };
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ShipFlow Docker ü ')); folders.push(directory);
  const archive = Buffer.from('test image content');
  await writeFile(path.join(directory, 'service-image.tar'), archive);
  const manifest = { schemaVersion: 1, ...release, platform: 'linux/arm64', imageId: `sha256:${'c'.repeat(64)}`, archive: 'service-image.tar', archiveSha256: createHash('sha256').update(archive).digest('hex') };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await writeFile(path.join(directory, 'manifest.json'), bytes);
  await writeFile(path.join(directory, 'manifest.sig'), sign(null, bytes, keys.privateKey));
  return { directory, manifest, publicKey };
}
class FakeDocker {
  calls: string[][] = [];
  containers = new Map<string, any>();
  configs = new Map<string, any>();
  volumes = new Map<string, any>();
  failure = '';
  logText = '';
  nextId = 1;
  run: DockerRun = async (args, options) => {
    this.calls.push(args);
    const [group, command] = args;
    if (group === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///docker.sock' } } }]);
    if (group === 'info') return args.at(-1) === '{{.ID}}' ? 'local-engine' : JSON.stringify({ OSType: 'linux', Architecture: 'aarch64' });
    if (group === 'image') {
      if (command === 'load') return 'Loaded';
      return JSON.stringify([{ Id: `sha256:${'c'.repeat(64)}`, Os: 'linux', Architecture: 'arm64', Config: { Labels: { 'io.shipflow.release': 'release-a' } } }]);
    }
    if (group === 'volume') {
      const name = args.at(-1)!;
      if (command === 'ls') { const filter = args[args.indexOf('--filter') + 1].slice(6, -1); return this.volumes.has(filter) ? filter : ''; }
      if (command === 'create') { const label = args[args.indexOf('--label') + 1].split('='); this.volumes.set(name, { Labels: { [label[0]]: label[1] } }); return name; }
      return JSON.stringify([this.volumes.get(name)]);
    }
    if (command === 'ls') {
      const filter = args[args.indexOf('--filter') + 1];
      return [...this.containers.values()].filter(c => filter.startsWith('id=') ? c.Id === filter.slice(3) : c.Name === filter.slice(6, -1)).map(c => c.Id).join('\n');
    }
    if (command === 'inspect') return JSON.stringify([this.containers.get(args[2])]);
    if (command === 'create') {
      const id = (this.nextId++).toString(16).padStart(64, '0');
      const labels: Record<string, string> = {};
      args.forEach((arg, index) => { if (arg === '--label') { const [key, ...rest] = args[index + 1].split('='); labels[key] = rest.join('='); } });
      this.containers.set(id, { Id: id, Name: '/' + args[args.indexOf('--name') + 1], Image: args.at(-1), Config: { Labels: labels }, State: { Running: false, ExitCode: 0 } });
      return id;
    }
    if (command === 'cp') { const id = args.at(-1)!.split(':')[0]; const input = options!.input!; const size = Number.parseInt(input.subarray(124, 135).toString(), 8); this.configs.set(id, JSON.parse(input.subarray(512, 512 + size).toString())); return ''; }
    if (command === 'run') return '';
    if (command === 'start') {
      const item = this.containers.get(args[2]);
      if (this.failure === 'start' && item.Name.endsWith('-next')) { this.failure = ''; throw new Error('Injected start failure'); }
      item.State.Running = true; return item.Id;
    }
    if (command === 'stop') { this.containers.get(args.at(-1)!).State.Running = false; return ''; }
    if (command === 'rename') { this.containers.get(args[2]).Name = '/' + args[3]; return ''; }
    if (command === 'rm') { this.containers.delete(args[2]); return ''; }
    if (command === 'logs') return this.logText;
    throw new Error(`Unexpected command ${group} ${command}`);
  };
  probe = async () => {
    const item = [...this.containers.values()].find(c => c.State.Running);
    if (!item) throw new Error('Not running');
    const config = this.configs.get(item.Id);
    return { product: 'shipflow-service', ready: true, storageHealthy: true, persistenceRequired: true, configId: config.runtime.configId, build: release, cacheMetrics: { hits: 0, misses: 0, coalesced: 0, errors: 0 } };
  };
}
async function setup() {
  const file = await fixture(); const docker = new FakeDocker();
  const options = { directory: path.join(file.directory, 'state'), bundleDirectory: file.directory, release, publicKey: file.publicKey, supported: true, run: docker.run, seal: (s: string) => s, unseal: (s: string) => s, probe: docker.probe, wait: async () => {} };
  return { ...file, docker, options, manager: new DockerDeploymentManager(options) };
}
describe('managed Docker deployments', () => {
  it('detects Docker independently of deployment platform support without creating credentials', async () => {
    const { options, docker } = await setup();
    const manager = new DockerDeploymentManager({ ...options, supported: false, seal: () => { throw new Error('Detection must not create credentials.'); } });
    const status = await manager.status();
    expect(status.dockerReady).toBe(true);
    expect(status.supported).toBe(false);
    expect(status.phase).toBe('unsupported');
    expect(status.bundleReady).toBe(false);
    expect(status.error).toBeNull();
    expect(docker.calls.map(args => args[0])).toEqual(['context', 'info']);
    await expect(readFile(path.join(options.directory, 'deployment.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.action('deploy')).rejects.toThrow('supported on Windows');
  });
  it('reports a Docker connection failure even on an unsupported deployment platform', async () => {
    const { options } = await setup();
    const manager = new DockerDeploymentManager({ ...options, supported: false, run: async () => { throw new Error('Docker Desktop is stopped.'); } });
    const status = await manager.status();
    expect(status.dockerReady).toBe(false);
    expect(status.error).toBe('Docker Desktop is stopped.');
  });
  it('verifies publisher, installation identity, and archive integrity independently', async () => {
    const { directory, publicKey } = await fixture();
    expect((await verifyBundle(directory, release, publicKey)).releaseId).toBe(release.releaseId);
    await expect(verifyBundle(directory, { ...release, sourceHash: 'different' }, publicKey)).rejects.toThrow('sourceHash');
    await expect(verifyBundle(directory, release, '')).rejects.toThrow('trusted');
    await writeFile(path.join(directory, 'service-image.tar'), 'corrupted');
    await expect(verifyBundle(directory, release, publicKey)).rejects.toThrow('checksum');
  });
  it('rejects a remote context before querying the remote daemon', async () => {
    let calls = 0;
    await expect(assertLocalLinuxDocker(async () => { calls++; return JSON.stringify([{ Endpoints: { docker: { Host: 'tcp://remote:2375' } } }]); })).rejects.toThrow('local');
    expect(calls).toBe(1);
  });
  it('accepts the Windows Docker Desktop Linux named pipe', async () => {
    expect(await assertLocalLinuxDocker(async args => args[0] === 'context' ? JSON.stringify([{ Endpoints: { docker: { Host: 'npipe:////./pipe/dockerDesktopLinuxEngine' } } }]) : JSON.stringify({ OSType: 'linux', Architecture: 'x86_64' }))).toBe('linux/amd64');
  });
  it('deploys from a path containing spaces and Unicode and preserves a single deployment on redeploy', async () => {
    const { manager, docker } = await setup();
    await manager.action('deploy');
    expect((await manager.status()).synchronized).toBe(true);
    await manager.action('deploy');
    expect([...docker.containers.values()].filter(c => c.State.Running)).toHaveLength(1);
    expect(docker.volumes.size).toBe(2);
    expect(docker.calls.some(args => args.includes('prune') || args.includes('--privileged'))).toBe(false);
  });
  it('restores the previous container and data snapshot after a startup failure', async () => {
    const { manager, docker } = await setup();
    await manager.action('deploy');
    const old = [...docker.containers.keys()][0];
    docker.failure = 'start';
    await expect(manager.action('deploy')).rejects.toThrow('previous deployment was restored');
    expect(docker.containers.get(old).State.Running).toBe(true);
    expect([...docker.containers.values()].filter(c => c.State.Running)).toHaveLength(1);
    expect(docker.calls.some(args => args.includes('run') && args.some(arg => arg.includes('tar -xpf')))).toBe(true);
  });
  it('does not modify containers or volumes owned by another application', async () => {
    const { manager, docker } = await setup();
    docker.containers.set('d'.repeat(64), { Id: 'd'.repeat(64), Name: '/shipflow-service-api', Config: { Labels: {} }, State: { Running: true } });
    await expect(manager.action('deploy')).rejects.toThrow('another deployment');
    expect(docker.calls.some(args => ['stop', 'rm', 'rename', 'create'].includes(args[1]))).toBe(false);
  });
  it('recovers an interrupted deployment using its journal after application restart', async () => {
    const { manager, docker, options } = await setup();
    await manager.action('deploy');
    const journalPath = path.join(options.directory, 'deployment.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.pending = { id: '12345678-abcd-abcd-abcd-123456789abc', phase: 'creating', backup: false };
    const old = docker.containers.get(journal.active.id); old.State.Running = false; old.Name = '/shipflow-service-api-previous';
    await writeFile(journalPath, JSON.stringify(journal));
    const recovered = new DockerDeploymentManager(options);
    expect((await recovered.status()).phase).toBe('interrupted');
    await recovered.action('recover');
    expect((await recovered.status()).synchronized).toBe(true);
  });
  it('rejects invalid settings without losing the saved configuration', async () => {
    const { manager } = await setup();
    await expect(manager.save({ ...DEFAULT_DOCKER_CONFIG, trackingSource: 'externalApi' })).rejects.toThrow('token');
    expect((await manager.status()).config.trackingSource).toBe('default');
    expect(() => validateDockerConfig({ ...DEFAULT_DOCKER_CONFIG, performance: { ...DEFAULT_DOCKER_CONFIG.performance, publicConcurrency: 100 } })).toThrow('capacity');
  });
  it('retains redacted startup diagnostics after removing a failed first candidate', async () => {
    const { manager, docker, options } = await setup();
    await manager.save(DEFAULT_DOCKER_CONFIG, 'fixture-upstream-secret');
    const journal = JSON.parse(await readFile(path.join(options.directory, 'deployment.json'), 'utf8'));
    docker.logText = `Startup failed: ${journal.token} fixture-upstream-secret Bearer fixture-header-secret`;
    docker.failure = 'start';
    await expect(manager.action('deploy')).rejects.toThrow('failed candidate was removed');
    const logs = await manager.logs();
    expect(logs).toContain('Startup failed:');
    expect(logs).not.toContain(journal.token);
    expect(logs).not.toContain('fixture-upstream-secret');
    expect(logs).not.toContain('fixture-header-secret');
    expect(docker.containers.size).toBe(0);
  });
  it('leaves the old service running when the bundled archive is corrupt', async () => {
    const { manager, docker, directory } = await setup();
    await manager.action('deploy');
    const before = docker.calls.length;
    await writeFile(path.join(directory, 'service-image.tar'), 'broken');
    await expect(manager.action('deploy')).rejects.toThrow('checksum');
    expect(docker.calls.slice(before).some(args => ['stop', 'rm', 'rename', 'create'].includes(args[1]))).toBe(false);
    expect([...docker.containers.values()].filter(c => c.State.Running)).toHaveLength(1);
  });
  it('rejects a concurrent operation before either can modify the journal', async () => {
    const { manager } = await setup();
    const first = manager.action('deploy');
    await expect(manager.action('deploy')).rejects.toThrow('in progress');
    await expect(manager.save(DEFAULT_DOCKER_CONFIG)).rejects.toThrow('active Docker');
    await first;
  });
  it('keeps an originally stopped service stopped after failed redeployment', async () => {
    const { manager, docker } = await setup();
    await manager.action('deploy');
    await manager.action('stop');
    docker.failure = 'start';
    await expect(manager.action('deploy')).rejects.toThrow('previous deployment was restored');
    expect([...docker.containers.values()].filter(c => c.State.Running)).toHaveLength(0);
  });
  it.each(['build', 'storage'])('rolls back when candidate %s readiness is invalid', async failure => {
    const { manager, docker, options } = await setup();
    await manager.action('deploy');
    const before = [...docker.containers.keys()][0];
    const original = options.probe;
    options.probe = async () => {
      const value = await original();
      const current = [...docker.containers.values()].find(c => c.State.Running);
      if (current.Id !== before) return failure === 'build' ? { ...value, build: { ...release, releaseId: 'wrong' } } : { ...value, storageHealthy: false };
      return value;
    };
    await expect(manager.action('deploy')).rejects.toThrow('previous deployment was restored');
    expect(docker.containers.get(before).State.Running).toBe(true);
  });
  it('puts credentials in a bounded owner-readable container file rather than command arguments', () => {
    const tar = configArchive({ token: 'fixture-token' });
    expect(tar.subarray(100, 107).toString()).toBe('0000400');
    expect(Number.parseInt(tar.subarray(108, 115).toString(), 8)).toBe(10001);
    expect(() => configArchive({ token: 'x'.repeat(70000) })).toThrow('64 KiB');
  });
});
