import { createHash, sign, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prepareRelease, root } from '../prepare-release.mjs';

const platform = process.env.SHIPFLOW_DOCKER_PLATFORM || 'linux/amd64';
if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('Unsupported Docker target platform.');
const privateKey = process.env.SHIPFLOW_BUNDLE_SIGNING_KEY;
const publicKey = process.env.SHIPFLOW_BUNDLE_PUBLIC_KEY;
if (process.env.SHIPFLOW_REQUIRE_BUNDLE_SIGNATURE === 'true' && !privateKey) throw new Error('The release Docker bundle requires an Ed25519 signing key.');
if (privateKey) {
  const challenge = Buffer.from('ShipFlow Docker signing key preflight');
  if (!publicKey || createPublicKey(privateKey).asymmetricKeyType !== 'ed25519' || !verify(null, challenge, publicKey, sign(null, challenge, privateKey))) throw new Error('Docker release requires matching Ed25519 signing keys.');
}
const release = prepareRelease();
const folder = path.join(root, 'build/docker');
await mkdir(folder, { recursive: true });
const imageTag = `shipflow-service:${release.releaseId}-${platform.split('/')[1]}`;
function run(args, capture = false) {
  const result = spawnSync('docker', args, { cwd: root, shell: false, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Docker ${args[0]} failed.`);
  return result.stdout?.trim();
}
run(['build', '--platform', platform, '--build-arg', `SHIPFLOW_RELEASE_ID=${release.releaseId}`, '-f', 'docker/service/Dockerfile', '-t', imageTag, '.']);
const image = JSON.parse(run(['image', 'inspect', imageTag], true))[0];
if (`${image.Os}/${image.Architecture}` !== platform || image.Config.Labels['io.shipflow.release'] !== release.releaseId) throw new Error('Image identity mismatch.');
run(['image', 'save', '--output', path.join(folder, 'service-image.tar'), image.Id]);
const hash = createHash('sha256');
for await (const chunk of createReadStream(path.join(folder, 'service-image.tar'))) hash.update(chunk);
const manifest = { schemaVersion: 1, ...release, platform, imageId: image.Id, archive: 'service-image.tar', archiveSha256: hash.digest('hex') };
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(folder, 'manifest.json'), bytes);
if (privateKey) {
  if (!publicKey) throw new Error('SHIPFLOW_BUNDLE_PUBLIC_KEY is required with the signing key.');
  const signature = sign(null, bytes, privateKey);
  if (createPublicKey(privateKey).asymmetricKeyType !== 'ed25519' || !verify(null, bytes, publicKey, signature)) throw new Error('Docker release signing keys do not match.');
  await writeFile(path.join(folder, 'manifest.sig'), signature);
} else {
  await rm(path.join(folder, 'manifest.sig'), { force: true });
  if (process.env.SHIPFLOW_REQUIRE_BUNDLE_SIGNATURE === 'true') throw new Error('The release Docker bundle requires an Ed25519 signing key.');
}
console.log(`Docker bundle prepared: ${release.releaseId} (${platform})`);
