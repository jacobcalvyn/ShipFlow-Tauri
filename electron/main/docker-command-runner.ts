import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export type DockerRun = (args: string[], options?: { input?: Buffer; timeoutMs?: number; maxBytes?: number; includeStderr?: boolean }) => Promise<string>;
export class DockerCommandError extends Error {
  constructor(readonly operation: string, readonly exitCode: number | null) { super(`Docker ${operation} failed (exit ${exitCode ?? 'unavailable'}). Check Docker Desktop and the ShipFlow deployment log.`); }
}
export async function dockerExecutable(): Promise<string> {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')]
    : ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* Try the next supported Docker Desktop location. */ } }
  throw new Error('Docker Desktop CLI was not found. Install or start Docker Desktop.');
}
export function createDockerRunner(executable: string): DockerRun {
  return (args, options = {}) => new Promise((resolve, reject) => {
    // Explicit local context ignores accidental remote daemon selection from the shell.
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('DOCKER_') || name.startsWith('COMPOSE_')) delete env[name];
    const child = spawn(executable, ['--context', 'desktop-linux', ...args], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let bytes = 0; let failed = false;
    const fail = (error: Error) => { if (failed) return; failed = true; child.kill(); reject(error); };
    const timer = setTimeout(() => fail(new Error(`Docker ${args[0]} timed out. Inspect deployment status before retrying.`)), options.timeoutMs ?? 30000);
    const append = (chunk: Buffer) => { bytes += chunk.length; if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) fail(new Error('Docker output exceeded the operation limit.')); else chunks.push(chunk); };
    child.stdout.on('data', append);
    // Errors may include user-supplied source URLs or credentials: do not propagate raw stderr.
    child.stderr.on('data', (chunk: Buffer) => { if (options.includeStderr) { append(chunk); return; } bytes += chunk.length; if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) fail(new Error('Docker error output exceeded the operation limit.')); });
    child.on('error', () => { clearTimeout(timer); fail(new Error('Unable to start Docker Desktop CLI.')); });
    child.on('close', code => { clearTimeout(timer); if (failed) return; if (code !== 0) reject(new DockerCommandError(args[0], code)); else resolve(Buffer.concat(chunks).toString('utf8').trim()); });
    child.stdin.on('error', () => { /* The exit handler reports early process termination. */ });
    child.stdin.end(options.input);
  });
}
export async function assertLocalLinuxDocker(run: DockerRun) {
  const context = JSON.parse(await run(['context', 'inspect', 'desktop-linux']));
  const endpoint = context[0]?.Endpoints?.docker?.Host;
  if (typeof endpoint !== 'string' || !(endpoint.startsWith('unix:///') || endpoint.toLowerCase() === 'npipe:////./pipe/dockerdesktoplinuxengine')) throw new Error('ShipFlow only manages the local Docker Desktop Linux engine.');
  const info = JSON.parse(await run(['info', '--format', '{{json .}}']));
  if (info.OSType !== 'linux' || !['x86_64', 'amd64', 'aarch64', 'arm64'].includes(info.Architecture)) throw new Error('A supported Linux Docker engine is required.');
  return ['x86_64', 'amd64'].includes(info.Architecture) ? 'linux/amd64' : 'linux/arm64';
}
