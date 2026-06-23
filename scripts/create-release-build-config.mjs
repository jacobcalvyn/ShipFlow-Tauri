import fs from "node:fs";
import path from "node:path";

const [target, outputPath] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required to create a signed release build config.`);
  }
  return value;
}

function parseUpdaterEndpoints(rawValue) {
  const endpoints = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (endpoints.length === 0) {
    fail("TAURI_UPDATER_ENDPOINTS must include at least one HTTPS endpoint.");
  }

  const seen = new Set();
  for (const endpoint of endpoints) {
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      fail(`Invalid TAURI_UPDATER_ENDPOINTS entry: ${endpoint}`);
    }

    if (parsed.protocol !== "https:") {
      fail(`Updater endpoint must use HTTPS: ${endpoint}`);
    }

    if (seen.has(endpoint)) {
      fail(`Duplicate updater endpoint: ${endpoint}`);
    }
    seen.add(endpoint);
  }

  return endpoints;
}

function releaseBundleConfig() {
  if (process.platform !== "darwin") {
    return undefined;
  }

  return {
    macOS: {
      signingIdentity: requireEnv("APPLE_SIGNING_IDENTITY"),
    },
  };
}

if ((target !== "desktop" && target !== "service") || !outputPath) {
  fail("Usage: node scripts/create-release-build-config.mjs <desktop|service> <output.json>");
}

const bundle = releaseBundleConfig();
const config = {
  $schema: "https://schema.tauri.app/config/2",
  plugins: {
    updater: {
      pubkey: requireEnv("TAURI_UPDATER_PUBLIC_KEY"),
      endpoints: parseUpdaterEndpoints(requireEnv("TAURI_UPDATER_ENDPOINTS")),
      windows: {
        installMode: "passive",
      },
    },
  },
};

if (bundle) {
  config.bundle = bundle;
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Wrote ${target} release build config to ${outputPath}`);
