import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capabilityRoots = [
  path.join(rootDir, "src-tauri", "capabilities"),
  path.join(rootDir, "apps", "service", "capabilities"),
];
const tauriConfigPaths = [
  path.join(rootDir, "src-tauri", "tauri.conf.json"),
  path.join(rootDir, "apps", "service", "tauri.conf.json"),
];
const updaterConfigPaths = [
  path.join(rootDir, "src-tauri", "tauri.updater.conf.json"),
  path.join(rootDir, "apps", "service", "tauri.updater.conf.json"),
];
const allowedCorePermissions = new Set([
  "core:event:allow-listen",
  "core:event:allow-unlisten",
]);
const errors = [];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getJsonFiles(dirPath) {
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return getJsonFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
    });
}

function relativePath(filePath) {
  return path.relative(rootDir, filePath);
}

for (const capabilityRoot of capabilityRoots) {
  for (const filePath of getJsonFiles(capabilityRoot)) {
    const capability = readJson(filePath);
    const permissions = Array.isArray(capability.permissions)
      ? capability.permissions
      : [];

    for (const permission of permissions) {
      const identifier =
        typeof permission === "string" ? permission : permission?.identifier;
      if (typeof identifier !== "string") {
        continue;
      }

      if (identifier === "core:default" || /^core:[^:]+:default$/.test(identifier)) {
        errors.push(
          `${relativePath(filePath)} uses broad Tauri core permission ${identifier}.`
        );
      }

      if (identifier.startsWith("core:") && !allowedCorePermissions.has(identifier)) {
        errors.push(
          `${relativePath(filePath)} uses unreviewed Tauri core permission ${identifier}.`
        );
      }
    }
  }
}

for (const filePath of tauriConfigPaths) {
  const config = readJson(filePath);
  const csp = config.app?.security?.csp;
  const beforeDevCommand = config.build?.beforeDevCommand;

  if (typeof beforeDevCommand === "string") {
    if (beforeDevCommand.includes("--host 0.0.0.0")) {
      errors.push(
        `${relativePath(filePath)} beforeDevCommand must not expose Vite on 0.0.0.0.`
      );
    }

    if (!beforeDevCommand.includes("--strictPort")) {
      errors.push(
        `${relativePath(filePath)} beforeDevCommand must pin Vite with --strictPort.`
      );
    }
  }

  if (typeof csp !== "string") {
    errors.push(`${relativePath(filePath)} must define an explicit CSP.`);
    continue;
  }

  for (const requiredDirective of [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'none'",
  ]) {
    if (!csp.includes(requiredDirective)) {
      errors.push(
        `${relativePath(filePath)} CSP must include ${requiredDirective}.`
      );
    }
  }

  if (csp.includes("default-src *")) {
    errors.push(`${relativePath(filePath)} CSP must not allow default-src *.`);
  }
}

for (const filePath of updaterConfigPaths) {
  const config = readJson(filePath);
  if (config.bundle?.createUpdaterArtifacts !== true) {
    errors.push(
      `${relativePath(filePath)} must enable signed updater artifact generation.`
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log("Security baseline passed.");
