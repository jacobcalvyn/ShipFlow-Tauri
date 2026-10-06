import { createHash, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ReleaseIdentity } from '../../src/backend/docker-contract';

export interface DockerBundle extends ReleaseIdentity {
  schemaVersion: 1;
  platform: 'linux/amd64' | 'linux/arm64';
  imageId: string;
  archiveSha256: string;
  archive: 'service-image.tar';
}
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}
export function validateBundleManifest(value: unknown, installed: ReleaseIdentity): DockerBundle {
  const m = value as DockerBundle;
  if (!m || m.schemaVersion !== 1 || m.archive !== 'service-image.tar' || !['linux/amd64', 'linux/arm64'].includes(m.platform)
    || !/^sha256:[a-f0-9]{64}$/.test(m.imageId) || !/^[a-f0-9]{64}$/.test(m.archiveSha256)) throw new Error('Invalid Docker bundle manifest.');
  for (const field of ['releaseId', 'version', 'commit', 'sourceHash', 'apiVersion', 'storageVersion'] as const) {
    if (m[field] !== installed[field]) throw new Error(`Docker bundle ${field} does not match this installation.`);
  }
  return m;
}
export async function readBundleManifest(directory: string, installed: ReleaseIdentity, publicKey: string, allowUnsigned = false): Promise<DockerBundle> {
  const manifestPath = path.join(directory, 'manifest.json');
  if ((await stat(manifestPath)).size > 16384) throw new Error('Docker manifest is too large.');
  const bytes = await readFile(manifestPath);
  if (!allowUnsigned || publicKey) {
    if (!publicKey) throw new Error('This installation does not contain a trusted Docker release key.');
    const signature = await readFile(path.join(directory, 'manifest.sig'));
    if (signature.length !== 64 || !verify(null, bytes, publicKey, signature)) throw new Error('Docker release signature is invalid.');
  }
  return validateBundleManifest(JSON.parse(bytes.toString('utf8')), installed);
}
export async function verifyBundle(directory: string, installed: ReleaseIdentity, publicKey: string, allowUnsigned = false): Promise<DockerBundle> {
  const manifest = await readBundleManifest(directory, installed, publicKey, allowUnsigned);
  if (await sha256File(path.join(directory, manifest.archive)) !== manifest.archiveSha256) throw new Error('Docker image archive checksum does not match the release.');
  return manifest;
}
