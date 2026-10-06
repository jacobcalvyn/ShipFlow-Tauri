import { spawnSync } from 'node:child_process';
import { root } from '../prepare-release.mjs';
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'electron/main/docker-runtime.integration.test.ts'], {
  cwd: root, stdio: 'inherit', shell: false,
  env: { ...process.env, SHIPFLOW_TEST_DOCKER: '1' },
});
if (result.error || result.status !== 0) process.exit(result.status || 1);
