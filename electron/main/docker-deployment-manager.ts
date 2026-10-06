import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { DEFAULT_DOCKER_CONFIG, validateDockerConfig, type DockerAction, type DockerDeploymentStatus, type DockerServiceConfig, type ReleaseIdentity } from '../../src/backend/docker-contract';
import { readBundleManifest, verifyBundle, type DockerBundle } from './docker-bundle';
import { assertLocalLinuxDocker, type DockerRun } from './docker-command-runner';

const NAME = 'shipflow-service-api';
const VOLUME = 'shipflow-service-api-data';
const BACKUP = 'shipflow-service-api-backup';
const OWNER = 'io.shipflow.deployment';
const ROLE = 'io.shipflow.role';
interface Deployment {
  id: string;
  imageId: string;
  build: ReleaseIdentity;
  config: DockerServiceConfig;
  configId: string;
  token: string;
  externalToken: string;
}
interface Journal {
  schemaVersion: 1;
  owner: string;
  daemonId?: string;
  config: DockerServiceConfig;
  token: string;
  externalToken: string;
  active: Deployment | null;
  pending: { id: string; phase: string; backup: boolean; wasRunning?: boolean } | null;
  error: string | null;
  failureLog?: string;
}
interface Container {
  Id: string;
  Image: string;
  Name: string;
  Config: { Labels: Record<string, string>; Image: string };
  State: { Running: boolean; ExitCode: number };
}
export interface DockerManagerOptions {
  directory: string;
  bundleDirectory: string;
  release: ReleaseIdentity;
  publicKey: string;
  allowUnsigned?: boolean;
  supported: boolean;
  run: DockerRun;
  seal: (value: string) => string;
  unseal: (value: string) => string;
  probe?: (port: number, token: string) => Promise<any>;
  wait?: (ms: number) => Promise<void>;
  testNamespace?: string;
}
export function configArchive(config: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(config));
  if (payload.length > 65536) throw new Error('Service configuration exceeds 64 KiB.');
  const header = Buffer.alloc(512);
  header.write('config.json', 0, 100, 'utf8');
  const octal = (n: number, offset: number, length: number) => header.write(n.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  octal(0o400, 100, 8); octal(10001, 108, 8); octal(10001, 116, 8); octal(payload.length, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  const checksum = header.reduce((sum, n) => sum + n, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512 + 1024)]);
}
export function probeApi(port: number, token: string, route = '/v1/readiness'): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: route, method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeout: 25000 }, res => {
      const parts: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) req.destroy(new Error('API response is too large.')); else parts.push(chunk); });
      res.on('error', () => reject(new Error('Service API connection failed.')));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Service readiness returned HTTP ${res.statusCode}.`));
        try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8')).data); } catch { reject(new Error('Invalid service readiness response.')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Service API timed out.')));
    req.on('error', () => reject(new Error('Service API is unavailable.')));
    req.end();
  });
}
export class DockerDeploymentManager {
  private busy = false;
  private readonly name: string;
  private readonly volumeName: string;
  private readonly backupName: string;
  private stage = 'idle';
  private journalPromise?: Promise<Journal>;
  private readonly run: DockerRun;
  constructor(private readonly options: DockerManagerOptions) {
    this.run = options.run;
    if (options.testNamespace && !/^shipflow-test-[a-f0-9]{8,32}$/.test(options.testNamespace)) throw new Error('Invalid test namespace.');
    this.name = options.testNamespace ?? NAME;
    this.volumeName = options.testNamespace ? `${this.name}-data` : VOLUME;
    this.backupName = options.testNamespace ? `${this.name}-backup` : BACKUP;
  }
  private journal(): Promise<Journal> {
    return this.journalPromise ??= (async () => {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      try {
        const state = JSON.parse(await readFile(path.join(this.options.directory, 'deployment.json'), 'utf8')) as Journal;
        if (state.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(state.owner)) throw new Error('Invalid deployment journal.');
        state.config = validateDockerConfig(state.config);
        return state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const state: Journal = { schemaVersion: 1, owner: randomUUID(), config: structuredClone(DEFAULT_DOCKER_CONFIG), token: this.options.seal(`sf_${randomBytes(32).toString('hex')}`), externalToken: '', active: null, pending: null, error: null };
        await this.persist(state); return state;
      }
    })();
  }
  private async persist(state: Journal) {
    const file = path.join(this.options.directory, 'deployment.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }
  private requireSupported() { if (!this.options.supported) throw new Error('Managed Docker deployment is supported on Windows Docker Desktop.'); }
  private async engine(state: Journal, pin = true) {
    const platform = await assertLocalLinuxDocker(this.run);
    const id = (await this.run(['info', '--format', '{{.ID}}'])).trim();
    if (!id) throw new Error('Docker engine identity is unavailable.');
    if (state.daemonId && state.daemonId !== id) throw new Error('The local Docker engine has changed. Restore the original deployment before continuing.');
    if (pin && !state.daemonId) { state.daemonId = id; await this.persist(state); }
    return platform;
  }
  private async container(nameOrId: string, state: Journal, role = 'service'): Promise<Container | null> {
    const ids = await this.run(['container', 'ls', '-a', '--no-trunc', '--filter', /^[a-f0-9]{64}$/.test(nameOrId) ? `id=${nameOrId}` : `name=^/${nameOrId}$`, '--format', '{{.ID}}']);
    if (!ids) return null;
    if (ids.includes('\n')) throw new Error('Ambiguous ShipFlow container identity.');
    const item = JSON.parse(await this.run(['container', 'inspect', ids]))[0] as Container;
    if (item.Config.Labels?.[OWNER] !== state.owner || item.Config.Labels?.[ROLE] !== role) throw new Error('A container with this name belongs to another deployment.');
    return item;
  }
  private async volume(name: string, state: Journal) {
    const existing = await this.run(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']);
    if (!existing) await this.run(['volume', 'create', '--label', `${OWNER}=${state.owner}`, name]);
    const volume = JSON.parse(await this.run(['volume', 'inspect', name]))[0];
    if (volume.Labels?.[OWNER] !== state.owner) throw new Error('A persistent volume belongs to another deployment.');
  }
  private async mark(state: Journal, phase: string) {
    this.stage = phase;
    if (state.pending) state.pending.phase = phase;
    await this.persist(state);
  }
  private async ready(active: Deployment) {
    const info = await (this.options.probe ?? probeApi)(active.config.port, this.options.unseal(active.token));
    if (info?.product !== 'shipflow-service' || info.ready !== true || info.storageHealthy !== true || info.persistenceRequired !== true || info.configId !== active.configId) throw new Error('Docker service identity, configuration, or persistence is not ready.');
    for (const key of ['releaseId', 'version', 'commit', 'sourceHash', 'apiVersion', 'storageVersion'] as const) {
      if (info.build?.[key] !== active.build[key]) throw new Error('The running Docker service does not match the expected release.');
    }
    return info;
  }
  private async waitReady(active: Deployment) {
    let error: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      try { return await this.ready(active); } catch (caught) { error = caught; }
      await (this.options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000);
    }
    throw error;
  }
  private async stop(item: Container) {
    if (item.State.Running) await this.run(['container', 'stop', '--time', '180', item.Id], { timeoutMs: 200000 });
  }
  async status(): Promise<DockerDeploymentStatus> {
    const state: Journal = this.options.supported ? await this.journal() : {
      schemaVersion: 1, owner: '', config: structuredClone(DEFAULT_DOCKER_CONFIG), token: '', externalToken: '', active: null, pending: null, error: null,
    };
    const result: DockerDeploymentStatus = { supported: this.options.supported, dockerReady: false, bundleReady: false,
      busy: this.busy, phase: !this.options.supported ? 'unsupported' : this.busy ? this.stage : state.pending ? 'interrupted' : 'stopped', error: state.error,
      installedRelease: this.options.release.releaseId, runningRelease: null, synchronized: false, apiReady: false,
      storageHealthy: false, configPending: !state.active || JSON.stringify(state.config) !== JSON.stringify(state.active.config) || state.token !== state.active.token || state.externalToken !== state.active.externalToken,
      config: structuredClone(state.config), externalTokenConfigured: Boolean(state.externalToken), endpoint: null, metrics: null, activeRequests: null, queuedRequests: null };
    if (this.busy) return result;
    try {
      if (this.options.supported) await this.engine(state, false);
      else await assertLocalLinuxDocker(this.run);
      result.dockerReady = true;
      if (!this.options.supported) return result;
      if (this.busy) return result;
      // Check signature and identity on every poll; hash the image archive before deployment.
      try { await readBundleManifest(this.options.bundleDirectory, this.options.release, this.options.publicKey, this.options.allowUnsigned); result.bundleReady = true; }
      catch (error) { result.error = `Docker bundle unavailable: ${(error as Error).message}`; }
      if (state.active) {
        const item = await this.container(state.active.id, state);
        if (item?.State.Running) {
          result.runningRelease = state.active.build.releaseId;
          if (!state.pending) result.phase = 'running';
          const info = await this.ready(state.active);
          result.apiReady = true; result.storageHealthy = true; result.metrics = info.cacheMetrics ?? null;
          result.endpoint = `http://127.0.0.1:${state.active.config.port}`;
          result.synchronized = state.active.build.releaseId === this.options.release.releaseId && !result.configPending && !state.pending;
          try {
            const diagnostics = await probeApi(state.active.config.port, this.options.unseal(state.active.token), '/v1/diagnostics');
            result.activeRequests = diagnostics?.backpressure?.ingress?.active ?? null;
            result.queuedRequests = diagnostics?.backpressure?.public?.queued ?? null;
          } catch { /* Readiness remains authoritative; metrics are optional. */ }
        }
      }
    } catch (error) { result.error = (error as Error).message; if (result.phase === 'running') result.phase = 'unhealthy'; }
    return result;
  }
  async save(config: unknown, externalToken?: string) {
    this.requireSupported();
    if (this.busy) throw new Error('Wait for the active Docker operation.');
    this.busy = true; this.stage = 'saving';
    try {
      const state = await this.journal();
      if (state.pending) throw new Error('Recover the interrupted deployment before editing configuration.');
      const next = { ...state, config: validateDockerConfig(config) };
      if (externalToken !== undefined) {
        if (typeof externalToken !== 'string' || externalToken.length > 4096) throw new Error('Invalid external API token.');
        next.externalToken = externalToken ? this.options.seal(externalToken) : '';
      }
      if (next.config.trackingSource === 'externalApi' && !next.externalToken) throw new Error('An external API token is required.');
      next.error = null;
      await this.persist(next); Object.assign(state, next);
    } finally { this.busy = false; this.stage = 'idle'; }
  }
  async publicToken() { this.requireSupported(); const state = await this.journal(); return this.options.unseal(state.active?.token ?? state.token); }
  async logs() {
    this.requireSupported();
    const state = await this.journal();
    if (state.error && state.failureLog) return state.failureLog;
    await this.engine(state, false);
    if (!state.active) return 'No Docker service has been deployed.';
    const item = await this.container(state.active.id, state);
    if (!item) return 'The managed container is missing.';
    return this.containerLogs(item, state);
  }
  private async containerLogs(item: Container, state: Journal) {
    const text = await this.run(['container', 'logs', '--tail', '100', item.Id], { maxBytes: 256 * 1024, includeStderr: true });
    return [state.token, state.externalToken, state.active?.token ?? '', state.active?.externalToken ?? ''].filter(Boolean)
      .reduce((log, cipher) => log.split(this.options.unseal(cipher)).join('[REDACTED]'), text)
      .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
  }
  async action(action: DockerAction): Promise<void> {
    this.requireSupported();
    if (this.busy) throw new Error('Another Docker operation is in progress.');
    this.busy = true; this.stage = 'preflight';
    let state: Journal | undefined;
    try {
      state = await this.journal();
      const platform = await this.engine(state);
      if (action === 'recover') { await this.recover(state); state.error = null; await this.persist(state); return; }
      if (state.pending) throw new Error('Recover the interrupted deployment before starting another operation.');
      if (action === 'deploy') { await this.deploy(state, platform); return; }
      if (!state.active) throw new Error('Deploy the Docker service first.');
      const item = await this.container(state.active.id, state);
      if (!item) throw new Error('The managed container is missing. Restore the original container and deployment journal.');
      if (action === 'stop' || action === 'restart') { this.stage = 'stopping'; await this.stop(item); }
      if (action === 'start' || action === 'restart') {
        this.stage = 'starting'; await this.run(['container', 'start', item.Id]); await this.waitReady(state.active);
      }
      state.error = null; await this.persist(state);
    } catch (error) {
      if (state) { state.error = (error as Error).message; await this.persist(state); } throw error;
    } finally { this.busy = false; this.stage = 'idle'; }
  }
  private async deploy(state: Journal, platform: string) {
    const bundle: DockerBundle = await verifyBundle(this.options.bundleDirectory, this.options.release, this.options.publicKey, this.options.allowUnsigned);
    if (bundle.platform !== platform) throw new Error('The bundled image architecture does not match Docker Desktop.');
    if (state.active && state.active.build.storageVersion !== bundle.storageVersion) throw new Error('This release requires a storage migration. Automatic redeployment across storage versions is disabled.');
    const config = validateDockerConfig(state.config);
    const old = state.active ? await this.container(state.active.id, state) : null;
    if (state.active && !old) throw new Error('The managed container is missing. Restore the original container and deployment journal.');
    const current = await this.container(this.name, state);
    if (current && current.Id !== old?.Id) throw new Error('The container name is already occupied.');
    const orphan = await this.container(`${this.name}-next`, state);
    if (orphan) throw new Error('An earlier candidate container still exists. Recover it before deploying.');
    const previous = await this.container(`${this.name}-previous`, state);
    if (previous) {
      if (previous.State.Running) throw new Error('The previous service is unexpectedly running.');
      await this.run(['container', 'rm', previous.Id]);
    }
    await this.volume(this.volumeName, state); await this.volume(this.backupName, state);
    this.stage = 'loading-image';
    await this.run(['image', 'load', '--input', path.join(this.options.bundleDirectory, bundle.archive)], { timeoutMs: 600000 });
    const image = JSON.parse(await this.run(['image', 'inspect', bundle.imageId]))[0];
    if (image.Id !== bundle.imageId || `${image.Os}/${image.Architecture}` !== bundle.platform || image.Config?.Labels?.['io.shipflow.release'] !== bundle.releaseId) throw new Error('Loaded Docker image does not match the release manifest.');
    state.pending = { id: randomUUID(), phase: 'prepared', backup: false, wasRunning: old?.State.Running ?? false }; state.error = null; state.failureLog = ''; await this.persist(state);
    try {
      if (old) {
        await this.mark(state, 'draining'); await this.stop(old);
        const stopped = await this.container(old.Id, state);
        if (old.State.Running && stopped?.State.ExitCode !== 0) throw new Error('The previous service did not stop cleanly. Restore it before redeploying.');
        await this.mark(state, 'backing-up');
        await this.copyVolume(state, bundle.imageId, false);
        state.pending.backup = true; await this.persist(state);
        await this.run(['container', 'rename', old.Id, `${this.name}-previous`]);
      }
      await this.mark(state, 'creating');
      const deployment: Deployment = { id: '', imageId: bundle.imageId, build: this.options.release, config,
        configId: createHash('sha256').update(JSON.stringify(config)).update(state.token).update(state.externalToken).digest('hex'), token: state.token, externalToken: state.externalToken };
      const id = await this.run(['container', 'create', '--name', `${this.name}-next`, '--label', `${OWNER}=${state.owner}`, '--label', `${ROLE}=service`,
        '--label', `io.shipflow.release=${bundle.releaseId}`, '--restart', 'unless-stopped', '--stop-timeout', '180',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', `${config.memoryMiB}m`, '--cpus', String(config.cpus),
        '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2', '--mount', `type=volume,src=${this.volumeName},dst=/data`,
        '--publish', `${config.bindAddress}:${config.port}:18422`, bundle.imageId]);
      deployment.id = id;
      const launch = { schemaVersion: 1, service: { mode: 'lan', port: 18422, authToken: this.options.unseal(state.token),
        internalAuthToken: '', internalIpcEndpoint: null, trackingSource: { trackingSource: config.trackingSource,
          externalApiBaseUrl: config.externalApiBaseUrl, externalApiAuthToken: state.externalToken ? this.options.unseal(state.externalToken) : '',
          allowInsecureExternalApiHttp: config.allowInsecureExternalApiHttp } },
        runtime: { ...config.performance, requirePersistence: true, dataDirectory: '/data', configId: deployment.configId } };
      await this.run(['container', 'cp', '--archive', '-', `${id}:/run/shipflow/`], { input: configArchive(launch) });
      await this.mark(state, 'verifying'); await this.run(['container', 'start', id]); await this.waitReady(deployment);
      await this.run(['container', 'rename', id, this.name]);
      const committed: Journal = { ...state, active: deployment, pending: null, error: null };
      await this.persist(committed); Object.assign(state, committed);
    } catch (error) {
      const reason = (error as Error).message;
      try {
        const failed = await this.container(`${this.name}-next`, state) ?? await this.container(this.name, state);
        if (failed && failed.Id !== old?.Id) { state.failureLog = await this.containerLogs(failed, state); await this.persist(state); }
      } catch { /* Preserve the deployment failure even when diagnostic collection is unavailable. */ }
      try { await this.recover(state); }
      catch { throw new Error(`${reason} Recovery is incomplete. Use Recover before another deployment.`); }
      throw new Error(`${reason} ${old ? 'The previous deployment was restored.' : 'The failed candidate was removed.'}`);
    }
  }
  private async copyVolume(state: Journal, imageId: string, restore: boolean) {
    if (!state.pending) throw new Error('No recoverable deployment operation exists.');
    const snapshot = `${state.pending.id}.tar`;
    // Fixed commands and owned volumes only. Backup runs after the writer container has stopped.
    const script = restore
      ? 'test -s "$1" && rm -f /data/lookup-store.sqlite3* /data/contact-store.sqlite3* /data/bag-route-store.sqlite3* && tar -xpf "$1" -C /data'
      : 'rm -f /backup/*.tar && tar -cpf "$1" -C /data .';
    await this.removeMaintenance(state);
    await this.run(['container', 'run', '--name', `${this.name}-maintenance`, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--label', `${OWNER}=${state.owner}`, '--label', `${ROLE}=backup`,
      '--mount', `type=volume,src=${this.volumeName},dst=/data${restore ? '' : ',readonly'}`,
      '--mount', `type=volume,src=${this.backupName},dst=/backup`, '--entrypoint', '/bin/sh', imageId, '-c', script, 'shipflow-backup', `/backup/${snapshot}`], { timeoutMs: 120000 });
    await this.removeMaintenance(state);
  }
  private async removeMaintenance(state: Journal) {
    const helper = await this.container(`${this.name}-maintenance`, state, 'backup');
    if (helper) { await this.stop(helper); await this.run(['container', 'rm', helper.Id]); }
  }
  private async recover(state: Journal) {
    if (!state.pending) return;
    this.stage = 'recovering';
    await this.removeMaintenance(state);
    for (const name of [`${this.name}-next`, this.name]) {
      const candidate = await this.container(name, state);
      if (candidate && candidate.Id !== state.active?.id) { await this.stop(candidate); await this.run(['container', 'rm', candidate.Id]); }
    }
    if (state.active) {
      const old = await this.container(state.active.id, state);
      if (!old) throw new Error('The previous managed container is missing; recovery requires its original data and image.');
      await this.stop(old);
      if (state.pending.backup) await this.copyVolume(state, state.active.imageId, true);
      if (old.Name !== `/${this.name}`) await this.run(['container', 'rename', old.Id, this.name]);
      if (state.pending.wasRunning !== false) { await this.run(['container', 'start', old.Id]); await this.waitReady(state.active); }
    }
    state.pending = null; await this.persist(state);
  }
}
