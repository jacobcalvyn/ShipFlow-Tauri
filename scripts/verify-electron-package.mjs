import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const packageRoot = path.resolve(process.argv[2] ?? "release");
const errors = [];

function walk(directory, depth = 0) {
  if (!existsSync(directory) || depth > 7) {
    return [];
  }
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    entries.push(absolutePath);
    if (entry.isDirectory()) {
      entries.push(...walk(absolutePath, depth + 1));
    }
  }
  return entries;
}

const entries = walk(packageRoot);
const nativeDirectory = entries.find((entry) => {
  const normalized = entry.split(path.sep).join("/").toLowerCase();
  return (
    statSync(entry).isDirectory() &&
    (normalized.endsWith("/contents/resources/native") ||
      normalized.endsWith("/resources/native"))
  );
});

if (!nativeDirectory) {
  errors.push(`Missing packaged native resource directory below ${packageRoot}.`);
} else {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const requiredNativeFiles = [
    `shipflow-service${suffix}`,
    `shipflow-workspace-host${suffix}`,
    ...(process.platform === "win32" ? ["duckdb.dll"] : []),
  ];
  for (const fileName of requiredNativeFiles) {
    const filePath = path.join(nativeDirectory, fileName);
    if (!existsSync(filePath) || statSync(filePath).size === 0) {
      errors.push(`Missing or empty packaged native resource: ${fileName}.`);
      continue;
    }
    if (process.platform !== "win32" && (statSync(filePath).mode & 0o111) === 0) {
      errors.push(`Packaged native resource is not executable: ${fileName}.`);
    }
  }
}

const appArchive = entries.find((entry) => entry.endsWith(`${path.sep}app.asar`));
if (!appArchive || statSync(appArchive).size === 0) {
  errors.push("Missing packaged Electron app.asar.");
}

if (process.platform === "darwin") {
  const infoPlist = entries.find((entry) => entry.endsWith("ShipFlow Desktop.app/Contents/Info.plist"));
  if (!infoPlist) {
    errors.push("Missing macOS ShipFlow Desktop.app Info.plist.");
  } else {
    const appBundle = infoPlist.slice(0, -"/Contents/Info.plist".length);
    const verification = spawnSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", appBundle],
      { encoding: "utf8" },
    );
    if (verification.status !== 0) {
      const detail = `${verification.stdout ?? ""}${verification.stderr ?? ""}`.trim();
      errors.push(`Invalid macOS application signature: ${detail || "codesign failed"}.`);
    }
  }
}

if (errors.length > 0) {
  errors.forEach((error) => console.error(error));
  process.exit(1);
}

console.log(`ShipFlow Electron package verified at ${packageRoot}.`);
