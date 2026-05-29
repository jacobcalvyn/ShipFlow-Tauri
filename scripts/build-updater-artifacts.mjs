import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const tauriCommand = path.join(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri"
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    stdio: "inherit",
    shell: false,
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (target !== "desktop" && target !== "service") {
  console.error("Usage: node scripts/build-updater-artifacts.mjs <desktop|service>");
  process.exit(1);
}

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.error(
    "TAURI_SIGNING_PRIVATE_KEY is required to build signed updater artifacts."
  );
  process.exit(1);
}

if (target === "desktop") {
  run(tauriCommand, [
    "build",
    "--config",
    "src-tauri/tauri.updater.conf.json",
    "--ci",
  ]);
} else {
  run(npmCommand, ["run", "build"]);
  run(
    tauriCommand,
    [
      "build",
      "--features",
      "custom-protocol",
      "--config",
      "tauri.updater.conf.json",
      "--ci",
    ],
    { cwd: path.join(rootDir, "apps", "service") }
  );
}
