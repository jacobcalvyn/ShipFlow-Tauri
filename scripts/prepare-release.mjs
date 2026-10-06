import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function releaseIdentity() {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
  const hash = createHash('sha256');
  for (const name of [...new Set(files)].filter(name => /^(apps\/|crates\/|src\/|electron\/|scripts\/|docker\/|Cargo\.|package|electron[.-]|tsconfig|vite\.)/.test(name)).sort()) {
    try { hash.update(name + '\0').update(readFileSync(path.join(root, name)).toString('utf8').replace(/\r\n/g, '\n')).update('\0'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const sourceHash = hash.digest('hex');
  return { version, commit, sourceHash, releaseId: `${version}-${commit.slice(0, 12)}-${sourceHash.slice(0, 12)}`, apiVersion: 'v1', storageVersion: 1 };
}
export function prepareRelease() {
  const identity = releaseIdentity();
  mkdirSync(path.join(root, 'build'), { recursive: true });
  writeFileSync(path.join(root, 'build/release.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Prepared release ${prepareRelease().releaseId}`);
}
