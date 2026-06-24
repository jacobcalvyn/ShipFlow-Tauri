import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required to build signed updater artifacts.`);
    process.exit(1);
  }

  return value;
}

function parseUpdaterEndpoints(rawValue) {
  const endpoints = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (endpoints.length === 0) {
    console.error("TAURI_UPDATER_ENDPOINTS must include at least one HTTPS endpoint.");
    process.exit(1);
  }

  const seenEndpoints = new Set();
  for (const endpoint of endpoints) {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      console.error(`Invalid TAURI_UPDATER_ENDPOINTS entry: ${endpoint}`);
      process.exit(1);
    }

    if (parsed.protocol !== "https:") {
      console.error(`Updater endpoint must use HTTPS: ${endpoint}`);
      process.exit(1);
    }

    if (seenEndpoints.has(endpoint)) {
      console.error(`Duplicate updater endpoint: ${endpoint}`);
      process.exit(1);
    }
    seenEndpoints.add(endpoint);
  }

  return endpoints;
}

function createWindowsSignCommand() {
  if (process.platform !== "win32") {
    return undefined;
  }

  requireEnv("WINDOWS_CERTIFICATE");
  requireEnv("WINDOWS_CERTIFICATE_PASSWORD");

  const scriptPath = path.join(
    rootDir,
    "scripts",
    "windows",
    "sign-windows-artifact-from-env.ps1"
  );

  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -ArtifactPath "%1"`;
}

function windowsInstallerHooksPath(appName) {
  if (appName === "desktop") {
    return path.join(rootDir, "scripts", "windows", "desktop-installer-hooks.nsh");
  }

  if (appName === "service") {
    return path.join(rootDir, "scripts", "windows", "service-installer-hooks.nsh");
  }

  throw new Error(`Unknown Windows installer hook target: ${appName}`);
}

function createUpdaterConfigOverlay({
  appName,
  pubkey,
  endpoints,
  macosSigningIdentity,
  windowsSignCommand,
}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipflow-updater-"));
  const configPath = path.join(tempDir, `${appName}.updater.conf.json`);
  const bundle = {
    createUpdaterArtifacts: true,
  };

  if (macosSigningIdentity) {
    bundle.macOS = {
      signingIdentity: macosSigningIdentity,
    };
  }

  if (windowsSignCommand) {
    bundle.windows = {
      signCommand: windowsSignCommand,
      nsis: {
        installerHooks: windowsInstallerHooksPath(appName),
      },
    };
  }

  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        $schema: "https://schema.tauri.app/config/2",
        bundle,
        plugins: {
          updater: {
            pubkey,
            endpoints,
            windows: {
              installMode: "passive",
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  return configPath;
}

function targetBundleRoot(targetName) {
  if (targetName === "desktop") {
    return path.join(rootDir, "target", "release", "bundle");
  }

  if (targetName === "service") {
    return path.join(rootDir, "apps", "service", "target", "release", "bundle");
  }

  throw new Error(`Unknown updater target: ${targetName}`);
}

function cleanTargetBundleRoot(targetName) {
  fs.rmSync(targetBundleRoot(targetName), { recursive: true, force: true });
}

if (target !== "desktop" && target !== "service") {
  console.error("Usage: node scripts/build-updater-artifacts.mjs <desktop|service>");
  process.exit(1);
}

requireEnv("TAURI_SIGNING_PRIVATE_KEY");
const updaterPublicKey = requireEnv("TAURI_UPDATER_PUBLIC_KEY");
const updaterEndpoints = parseUpdaterEndpoints(requireEnv("TAURI_UPDATER_ENDPOINTS"));
const macosSigningIdentity =
  process.platform === "darwin" ? requireEnv("APPLE_SIGNING_IDENTITY") : undefined;
const windowsSignCommand = createWindowsSignCommand();
const updaterConfigPath = createUpdaterConfigOverlay({
  appName: target,
  pubkey: updaterPublicKey,
  endpoints: updaterEndpoints,
  macosSigningIdentity,
  windowsSignCommand,
});
cleanTargetBundleRoot(target);

if (target === "desktop") {
  run(tauriCommand, [
    "build",
    "--config",
    updaterConfigPath,
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
      updaterConfigPath,
      "--ci",
    ],
    { cwd: path.join(rootDir, "apps", "service") }
  );
}
