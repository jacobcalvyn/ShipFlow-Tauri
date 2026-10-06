export interface ReleaseIdentity {
  version: string;
  commit: string;
  sourceHash: string;
  releaseId: string;
  apiVersion: string;
  storageVersion: number;
}
export interface DockerPerformance {
  httpConcurrency: number;
  httpQueue: number;
  lookupConcurrency: number;
  publicConcurrency: number;
  lookupQueue: number;
  contactConcurrency: number;
  trackTtlSeconds: number;
  bagTtlSeconds: number;
  manifestTtlSeconds: number;
  cacheEntries: number;
  cacheMiB: number;
  persistentEntries: number;
}
export const DEFAULT_DOCKER_PERFORMANCE: DockerPerformance = {
  httpConcurrency: 128, httpQueue: 512, lookupConcurrency: 30, publicConcurrency: 24,
  lookupQueue: 240, contactConcurrency: 15, trackTtlSeconds: 30, bagTtlSeconds: 60,
  manifestTtlSeconds: 90, cacheEntries: 10000, cacheMiB: 128, persistentEntries: 2000,
};
export interface DockerServiceConfig {
  port: number;
  bindAddress: '127.0.0.1' | '0.0.0.0';
  memoryMiB: number;
  cpus: number;
  trackingSource: 'default' | 'externalApi';
  externalApiBaseUrl: string;
  allowInsecureExternalApiHttp: boolean;
  performance: DockerPerformance;
}
export const DEFAULT_DOCKER_CONFIG: DockerServiceConfig = {
  port: 18424, bindAddress: '127.0.0.1', memoryMiB: 1024, cpus: 2,
  trackingSource: 'default', externalApiBaseUrl: '', allowInsecureExternalApiHttp: false,
  performance: DEFAULT_DOCKER_PERFORMANCE,
};
export function validateDockerConfig(input: unknown): DockerServiceConfig {
  if (!input || typeof input !== 'object') throw new Error('Docker configuration is required.');
  const value = input as DockerServiceConfig;
  const integer = (name: string, n: number, min: number, max: number) => {
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}.`);
    return n;
  };
  integer('Port', value.port, 1024, 65535);
  integer('Memory', value.memoryMiB, 256, 16384);
  if (!Number.isFinite(value.cpus) || value.cpus < 0.5 || value.cpus > 32) throw new Error('CPU limit must be between 0.5 and 32.');
  if (!['127.0.0.1', '0.0.0.0'].includes(value.bindAddress)) throw new Error('Invalid bind address.');
  if (!['default', 'externalApi'].includes(value.trackingSource)) throw new Error('Invalid tracking source.');
  if (typeof value.externalApiBaseUrl !== 'string' || value.externalApiBaseUrl.length > 2048 || typeof value.allowInsecureExternalApiHttp !== 'boolean') throw new Error('Invalid external API configuration.');
  const limits: Record<keyof DockerPerformance, number> = {
    httpConcurrency: 512, httpQueue: 4096, lookupConcurrency: 100, publicConcurrency: 100,
    lookupQueue: 2000, contactConcurrency: 50, trackTtlSeconds: 86400, bagTtlSeconds: 86400,
    manifestTtlSeconds: 86400, cacheEntries: 100000, cacheMiB: 1024, persistentEntries: 100000,
  };
  const performance = {} as DockerPerformance;
  for (const key of Object.keys(limits) as (keyof DockerPerformance)[]) performance[key] = integer(key, value.performance?.[key], 1, limits[key]);
  if (performance.publicConcurrency > performance.lookupConcurrency || performance.httpConcurrency < performance.publicConcurrency) throw new Error('Public concurrency exceeds available upstream or HTTP capacity.');
  if (performance.cacheMiB + 128 > value.memoryMiB) throw new Error('Memory must include at least 128 MiB beyond the lookup cache.');
  return { port: value.port, bindAddress: value.bindAddress, memoryMiB: value.memoryMiB, cpus: value.cpus,
    trackingSource: value.trackingSource, externalApiBaseUrl: value.externalApiBaseUrl.trim(),
    allowInsecureExternalApiHttp: value.allowInsecureExternalApiHttp, performance };
}
export type DockerAction = 'deploy' | 'start' | 'stop' | 'restart' | 'recover';
export interface DockerDeploymentStatus {
  supported: boolean;
  dockerReady: boolean;
  bundleReady: boolean;
  phase: string;
  busy: boolean;
  error: string | null;
  installedRelease: string;
  runningRelease: string | null;
  synchronized: boolean;
  apiReady: boolean;
  storageHealthy: boolean;
  configPending: boolean;
  config: DockerServiceConfig;
  externalTokenConfigured: boolean;
  endpoint: string | null;
  metrics: { hits: number; misses: number; coalesced: number; errors: number } | null;
  activeRequests: number | null;
  queuedRequests: number | null;
}
