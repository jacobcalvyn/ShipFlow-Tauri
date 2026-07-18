import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const packageRoot = path.resolve(process.argv[2] ?? "release");
const errors = [];
const requireWindowsSignature =
  process.env.SHIPFLOW_REQUIRE_WINDOWS_SIGNATURE?.trim().toLowerCase() === "true";

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function verifyPackagedFileMatchesSource(fileName, packagedPath) {
  const sourcePath = path.resolve("target", "release", fileName);
  if (!existsSync(sourcePath)) {
    errors.push(`Missing native build provenance source: ${sourcePath}.`);
    return;
  }
  if (sha256(packagedPath) !== sha256(sourcePath)) {
    errors.push(`Packaged native resource does not match its build output: ${fileName}.`);
  }
}

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
    if (
      process.platform === "win32" &&
      (!requireWindowsSignature || !fileName.toLowerCase().endsWith(".exe"))
    ) {
      verifyPackagedFileMatchesSource(fileName, filePath);
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

if (process.platform === "win32" && requireWindowsSignature) {
  const executablePaths = entries.filter(
    (entry) => statSync(entry).isFile() && entry.toLowerCase().endsWith(".exe"),
  );
  const nativeExecutables = executablePaths.filter((entry) =>
    entry.split(path.sep).join("/").toLowerCase().includes("/resources/native/"),
  );
  const installers = executablePaths.filter(
    (entry) => path.dirname(entry) === packageRoot,
  );
  const requiredSignedPaths = [...new Set([...nativeExecutables, ...installers])];
  if (nativeExecutables.length < 2 || installers.length === 0) {
    errors.push("Missing Windows executables required for Authenticode verification.");
  } else {
    const verification = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$paths = ConvertFrom-Json $env:SHIPFLOW_SIGNATURE_PATHS; " +
          "$invalid = @($paths | ForEach-Object { " +
          "$signature = Get-AuthenticodeSignature -LiteralPath $_; " +
          "if ($signature.Status -ne 'Valid') { \"$_ => $($signature.Status)\" } }); " +
          "if ($invalid.Count -gt 0) { $invalid | Write-Error; exit 1 }",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SHIPFLOW_SIGNATURE_PATHS: JSON.stringify(requiredSignedPaths),
        },
      },
    );
    if (verification.status !== 0) {
      const detail = `${verification.stdout ?? ""}${verification.stderr ?? ""}`.trim();
      errors.push(`Invalid Windows Authenticode signature: ${detail || "verification failed"}.`);
    }
  }
}

if (errors.length > 0) {
  errors.forEach((error) => console.error(error));
  process.exit(1);
}

console.log(`ShipFlow Electron package verified at ${packageRoot}.`);
