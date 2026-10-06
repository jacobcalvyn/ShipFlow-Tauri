import { createHash, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseIdentity, root } from '../prepare-release.mjs';
export async function verifyDockerBundle(directory, identity = releaseIdentity(), requireSignature = process.env.SHIPFLOW_REQUIRE_BUNDLE_SIGNATURE === 'true') {
  const bytes = await readFile(path.join(directory, 'manifest.json'));
  if (bytes.length > 16384) throw new Error('Docker bundle manifest is too large.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.archive !== 'service-image.tar' || !['linux/amd64', 'linux/arm64'].includes(manifest.platform) || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId)) throw new Error('Invalid Docker bundle.');
  for (const field of ['version', 'commit', 'sourceHash', 'releaseId', 'apiVersion', 'storageVersion']) {
    if (manifest[field] !== identity[field]) throw new Error(`Docker bundle ${field} differs from this build.`);
  }
  const file = path.join(directory, manifest.archive);
  if ((await stat(file)).size === 0) throw new Error('Empty Docker image archive.');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.archiveSha256) throw new Error('Docker archive checksum mismatch.');
  if (requireSignature) {
    const publicKey = process.env.SHIPFLOW_BUNDLE_PUBLIC_KEY;
    const signature = await readFile(path.join(directory, 'manifest.sig'));
    if (!publicKey || signature.length !== 64 || !verify(null, bytes, publicKey, signature)) throw new Error('Docker release signature verification failed.');
  }
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyDockerBundle(path.resolve(process.argv[2] || path.join(root, 'build/docker')));
  console.log('Docker bundle verified.');
}
