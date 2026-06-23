import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [target, platform, kind, outputPath] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function collectFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }

    return entry.isFile() ? [entryPath] : [];
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sha256String(value) {
  const hash = crypto.createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function runVerification(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    shell: false,
  });

  const invocation = [command, ...args].join(" ");
  if (result.status !== 0) {
    fail(
      `Release artifact verification failed: ${invocation}\n${result.stdout ?? ""}${result.stderr ?? ""}`
    );
  }

  return {
    command: invocation,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function relativeArtifactPath(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function targetBundleRoot() {
  if (target === "desktop") {
    return path.join(rootDir, "target", "release", "bundle");
  }

  if (target === "service") {
    return path.join(rootDir, "apps/service", "target", "release", "bundle");
  }

  fail("Usage: node scripts/generate-release-evidence.mjs <desktop|service> <macos|windows> <distribution|updater> <output.json>");
}

function distributionArtifacts() {
  if (platform === "macos") {
    return collectFiles(targetBundleRoot()).filter((filePath) => {
      const normalizedPath = filePath.split(path.sep).join("/");
      return filePath.endsWith(".dmg") || normalizedPath.endsWith("-macos-app.zip");
    });
  }

  if (platform === "windows") {
    const releaseRoot = path.join(rootDir, "target", "release");
    const artifactNames =
      target === "desktop"
        ? ["shipflow3-tauri.exe", "ShipFlow-Desktop-Setup.exe"]
        : ["shipflow-service.exe", "ShipFlow-Service-Setup.exe"];

    return artifactNames
      .map((artifactName) => path.join(releaseRoot, artifactName))
      .filter((filePath) => fs.existsSync(filePath));
  }

  return [];
}

function updaterArtifacts() {
  return collectFiles(targetBundleRoot()).filter((filePath) => {
    const normalizedPath = filePath.split(path.sep).join("/");

    if (platform === "macos") {
      return (
        normalizedPath.includes("/macos/") ||
        normalizedPath.includes("/dmg/") ||
        filePath.endsWith(".app.tar.gz") ||
        filePath.endsWith(".dmg") ||
        filePath.endsWith(".app.tar.gz.sig") ||
        filePath.endsWith(".dmg.sig")
      );
    }

    if (platform === "windows") {
      return (
        normalizedPath.includes("/nsis/") ||
        normalizedPath.includes("/msi/") ||
        filePath.endsWith(".exe") ||
        filePath.endsWith(".msi") ||
        filePath.endsWith(".msi.zip") ||
        filePath.endsWith(".nsis.zip") ||
        filePath.endsWith(".exe.sig") ||
        filePath.endsWith(".msi.sig") ||
        filePath.endsWith(".msi.zip.sig") ||
        filePath.endsWith(".nsis.zip.sig")
      );
    }

    return false;
  });
}

function findMacosAppBundle() {
  const bundleRoot = path.join(targetBundleRoot(), "macos");
  if (!fs.existsSync(bundleRoot)) {
    fail(`macOS app bundle root is missing: ${path.relative(rootDir, bundleRoot)}`);
  }

  const appBundle = fs
    .readdirSync(bundleRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appBundle) {
    fail(`No macOS .app bundle found in ${path.relative(rootDir, bundleRoot)}.`);
  }

  return path.join(bundleRoot, appBundle.name);
}

function findWindowsSigntool() {
  if (process.env.SIGNTOOL_PATH && fs.existsSync(process.env.SIGNTOOL_PATH)) {
    return process.env.SIGNTOOL_PATH;
  }

  const kitsRoot = process.env["ProgramFiles(x86)"]
    ? path.join(process.env["ProgramFiles(x86)"], "Windows Kits", "10", "bin")
    : "";
  const candidates = [];

  function scan(dirPath) {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scan(entryPath);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase() === "signtool.exe" &&
        entryPath.toLowerCase().includes(`${path.sep}x64${path.sep}`)
      ) {
        candidates.push(entryPath);
      }
    }
  }

  scan(kitsRoot);
  candidates.sort().reverse();
  if (candidates.length === 0) {
    fail("Unable to find Windows SDK signtool.exe for release evidence verification.");
  }

  return candidates[0];
}

function buildMacosArtifactVerification(filePath) {
  if (process.platform !== "darwin") {
    fail("macOS release evidence must be generated on macOS so signing and notarization can be verified.");
  }

  const relativePath = relativeArtifactPath(filePath);
  const sourcePath =
    relativePath.endsWith("-macos-app.zip") || relativePath.endsWith(".app.tar.gz")
      ? findMacosAppBundle()
      : filePath;
  const isAppBundle = sourcePath.endsWith(".app");

  const checks = [
    {
      name: "codesignVerify",
      ...runVerification("codesign", [
        "--verify",
        ...(isAppBundle ? ["--deep", "--strict"] : []),
        "--verbose=2",
        sourcePath,
      ]),
    },
    {
      name: "codesignDetails",
      ...runVerification("codesign", ["-dv", "--verbose=4", sourcePath]),
    },
    {
      name: "spctlAssess",
      ...runVerification("spctl", [
        "--assess",
        "--type",
        isAppBundle ? "execute" : "open",
        ...(isAppBundle ? [] : ["--context", "context:primary-signature"]),
        "--verbose",
        sourcePath,
      ]),
    },
    {
      name: "staplerValidate",
      ...runVerification("xcrun", ["stapler", "validate", sourcePath]),
    },
  ];

  const codesignDetails = checks.find((check) => check.name === "codesignDetails");
  if (`${codesignDetails.stdout}${codesignDetails.stderr}`.includes("Signature=adhoc")) {
    fail(`macOS artifact must not be ad-hoc signed: ${relativePath}`);
  }

  return {
    platform: "macos",
    signed: true,
    notarized: true,
    sourcePath: relativeArtifactPath(sourcePath),
    checks,
  };
}

function buildWindowsArtifactVerification(filePath) {
  if (process.platform !== "win32") {
    fail("Windows release evidence must be generated on Windows so Authenticode signatures can be verified.");
  }

  const signtoolPath = findWindowsSigntool();
  return {
    platform: "windows",
    signed: true,
    checks: [
      {
        name: "signtoolVerify",
        ...runVerification(signtoolPath, ["verify", "/pa", "/v", filePath]),
      },
    ],
  };
}

function buildArtifactVerification(filePath) {
  const relativePath = relativeArtifactPath(filePath);

  if (
    platform === "macos" &&
    (relativePath.endsWith("-macos-app.zip") ||
      relativePath.endsWith(".app.tar.gz") ||
      relativePath.endsWith(".dmg"))
  ) {
    return buildMacosArtifactVerification(filePath);
  }

  if (
    platform === "windows" &&
    (relativePath.endsWith(".exe") || relativePath.endsWith(".msi"))
  ) {
    return buildWindowsArtifactVerification(filePath);
  }

  return undefined;
}

function parseUpdaterEndpointsFromEnv() {
  const rawValue = process.env.TAURI_UPDATER_ENDPOINTS?.trim();
  if (!rawValue) {
    fail("TAURI_UPDATER_ENDPOINTS is required to generate release evidence.");
  }

  const endpoints = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (endpoints.length === 0) {
    fail("TAURI_UPDATER_ENDPOINTS must include at least one HTTPS endpoint.");
  }

  const seenEndpoints = new Set();
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

    if (seenEndpoints.has(endpoint)) {
      fail(`Duplicate updater endpoint: ${endpoint}`);
    }
    seenEndpoints.add(endpoint);
  }

  return endpoints;
}

function buildUpdaterConfigEvidence() {
  const publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
  if (!publicKey) {
    fail("TAURI_UPDATER_PUBLIC_KEY is required to generate release evidence.");
  }

  return {
    publicKeySha256: sha256String(publicKey),
    endpoints: parseUpdaterEndpointsFromEnv(),
  };
}

function artifactRecords(filePaths) {
  return filePaths
    .map((filePath) => {
      const relativePath = relativeArtifactPath(filePath);
      const stats = fs.statSync(filePath);
      const record = {
        path: relativePath,
        bytes: stats.size,
        sha256: sha256File(filePath),
      };

      if (relativePath.endsWith(".sig")) {
        record.signatureFor = relativePath.slice(0, -".sig".length);
      }

      const verification = buildArtifactVerification(filePath);
      if (verification) {
        record.verification = verification;
      }

      return record;
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

if (
  !["desktop", "service"].includes(target) ||
  !["macos", "windows"].includes(platform) ||
  !["distribution", "updater"].includes(kind) ||
  !outputPath
) {
  fail("Usage: node scripts/generate-release-evidence.mjs <desktop|service> <macos|windows> <distribution|updater> <output.json>");
}

const artifacts = artifactRecords(
  kind === "updater" ? updaterArtifacts() : distributionArtifacts()
);

if (artifacts.length === 0) {
  fail(`No ${kind} artifacts found for ${target} ${platform}.`);
}

const evidence = {
  schemaVersion: 1,
  target,
  platform,
  kind,
  generatedAt: new Date().toISOString(),
  updaterConfig: buildUpdaterConfigEvidence(),
  artifacts,
};

if (kind === "updater") {
  evidence.updaterEndpoints = evidence.updaterConfig.endpoints;
}

const resolvedOutputPath = path.resolve(rootDir, outputPath);
fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Wrote release evidence manifest: ${path.relative(rootDir, resolvedOutputPath)}`);
