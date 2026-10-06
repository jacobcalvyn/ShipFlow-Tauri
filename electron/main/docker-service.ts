import { app, safeStorage } from 'electron';
import path from 'node:path';
import { DockerDeploymentManager } from './docker-deployment-manager';
import { createDockerRunner, dockerExecutable } from './docker-command-runner';
import type { ReleaseIdentity } from '../../src/backend/docker-contract';

declare const __SHIPFLOW_RELEASE__: ReleaseIdentity;
declare const __SHIPFLOW_BUNDLE_PUBLIC_KEY__: string;
let manager: DockerDeploymentManager | undefined;
export function dockerService(): DockerDeploymentManager {
  if (manager) return manager;
  const seal = (value: string) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is required for Docker deployment.');
    return `encrypted:v1:${safeStorage.encryptString(value).toString('base64')}`;
  };
  const unseal = (value: string) => {
    if (!value.startsWith('encrypted:v1:') || !safeStorage.isEncryptionAvailable()) throw new Error('Docker credentials cannot be decrypted.');
    return safeStorage.decryptString(Buffer.from(value.slice('encrypted:v1:'.length), 'base64'));
  };
  manager = new DockerDeploymentManager({
    directory: path.join(app.getPath('userData'), 'docker-service'),
    bundleDirectory: app.isPackaged ? path.join(process.resourcesPath, 'docker') : path.resolve(app.getAppPath(), 'build/docker'),
    release: __SHIPFLOW_RELEASE__, publicKey: __SHIPFLOW_BUNDLE_PUBLIC_KEY__,
    allowUnsigned: !app.isPackaged && process.env.SHIPFLOW_ALLOW_UNSIGNED_DOCKER_BUNDLE === '1',
    supported: process.platform === 'win32' || (!app.isPackaged && process.env.SHIPFLOW_DOCKER_DEVELOPMENT === '1'),
    seal, unseal, run: async (args, options) => createDockerRunner(await dockerExecutable())(args, options),
  });
  return manager;
}
