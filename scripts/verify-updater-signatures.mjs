import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
const platform = process.argv[3];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function collectFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath);
    }
    return [entryPath];
  });
}

function targetBundleRoot(targetName) {
  if (targetName === "desktop") {
    return path.join(rootDir, "target", "release", "bundle");
  }

  if (targetName === "service") {
    return path.join(rootDir, "apps", "service", "target", "release", "bundle");
  }

  fail("Usage: node scripts/verify-updater-signatures.mjs <desktop|service> <macos|windows>");
}

function isSignatureForPlatform(signaturePath, platformName) {
  const signedArtifactPath = signaturePath.slice(0, -".sig".length);
  const normalizedPath = signedArtifactPath.split(path.sep).join("/");

  if (platformName === "macos") {
    return (
      normalizedPath.includes("/macos/") ||
      normalizedPath.includes("/dmg/") ||
      signedArtifactPath.endsWith(".app.tar.gz") ||
      signedArtifactPath.endsWith(".dmg")
    );
  }

  if (platformName === "windows") {
    return (
      normalizedPath.includes("/nsis/") ||
      normalizedPath.includes("/msi/") ||
      signedArtifactPath.endsWith(".exe") ||
      signedArtifactPath.endsWith(".msi") ||
      signedArtifactPath.endsWith(".msi.zip") ||
      signedArtifactPath.endsWith(".nsis.zip")
    );
  }

  return false;
}

function isLikelyTauriSignature(value) {
  const trimmedValue = value.trim();
  return (
    trimmedValue.length >= 64 &&
    /^[A-Za-z0-9+/=_-]+$/u.test(trimmedValue) &&
    !/\s/u.test(trimmedValue)
  );
}

if (platform !== "macos" && platform !== "windows") {
  fail("Usage: node scripts/verify-updater-signatures.mjs <desktop|service> <macos|windows>");
}

const bundleRoot = targetBundleRoot(target);
const files = collectFiles(bundleRoot);
const signatureFiles = files.filter((filePath) => filePath.endsWith(".sig"));
const platformSignatureFiles = signatureFiles.filter((signaturePath) =>
  isSignatureForPlatform(signaturePath, platform)
);

if (signatureFiles.length === 0) {
  fail(`No updater .sig files were produced for ${target} ${platform} in ${bundleRoot}.`);
}

if (platformSignatureFiles.length === 0) {
  fail(`No ${platform} updater .sig files were produced for ${target} in ${bundleRoot}.`);
}

const unexpectedPlatformSignatures = signatureFiles.filter(
  (signaturePath) => !isSignatureForPlatform(signaturePath, platform)
);

if (unexpectedPlatformSignatures.length > 0) {
  fail(
    [
      `Updater signature files from a different platform were found for ${target} ${platform}:`,
      ...unexpectedPlatformSignatures.map((signaturePath) => `- ${path.relative(rootDir, signaturePath)}`),
    ].join("\n")
  );
}

const signedArtifactPaths = signatureFiles.map((signaturePath) =>
  signaturePath.slice(0, -".sig".length)
);

if (platform === "macos") {
  const hasAppArchiveSignature = signedArtifactPaths.some((artifactPath) =>
    artifactPath.endsWith(".app.tar.gz")
  );
  const hasDmgSignature = signedArtifactPaths.some((artifactPath) =>
    artifactPath.endsWith(".dmg")
  );

  if (!hasAppArchiveSignature) {
    fail(`No macOS app archive updater signature was produced for ${target}.`);
  }

  if (!hasDmgSignature) {
    fail(`No macOS DMG updater signature was produced for ${target}.`);
  }
}

if (platform === "windows") {
  const hasWindowsInstallerSignature = signedArtifactPaths.some(
    (artifactPath) =>
      artifactPath.endsWith(".exe") ||
      artifactPath.endsWith(".msi") ||
      artifactPath.endsWith(".msi.zip") ||
      artifactPath.endsWith(".nsis.zip")
  );

  if (!hasWindowsInstallerSignature) {
    fail(`No Windows installer updater signature was produced for ${target}.`);
  }
}

const filesByPath = new Set(files);
const orphanSignatures = signatureFiles.filter((signaturePath) => {
  const signedArtifactPath = signaturePath.slice(0, -".sig".length);
  return !filesByPath.has(signedArtifactPath);
});

if (orphanSignatures.length > 0) {
  fail(
    [
      `Updater signature files without matching artifacts for ${target} ${platform}:`,
      ...orphanSignatures.map((signaturePath) => `- ${path.relative(rootDir, signaturePath)}`),
    ].join("\n")
  );
}

const emptySignatureFiles = signatureFiles.filter(
  (signaturePath) => fs.statSync(signaturePath).size === 0
);

if (emptySignatureFiles.length > 0) {
  fail(
    [
      `Updater signature files are empty for ${target} ${platform}:`,
      ...emptySignatureFiles.map((signaturePath) => `- ${path.relative(rootDir, signaturePath)}`),
    ].join("\n")
  );
}

const malformedSignatureFiles = signatureFiles.filter(
  (signaturePath) => !isLikelyTauriSignature(fs.readFileSync(signaturePath, "utf8"))
);

if (malformedSignatureFiles.length > 0) {
  fail(
    [
      `Updater signature files are not valid Tauri updater signature strings for ${target} ${platform}:`,
      ...malformedSignatureFiles.map((signaturePath) => `- ${path.relative(rootDir, signaturePath)}`),
    ].join("\n")
  );
}

const emptySignedArtifacts = signatureFiles.filter((signaturePath) => {
  const signedArtifactPath = signaturePath.slice(0, -".sig".length);
  return fs.statSync(signedArtifactPath).size === 0;
});

if (emptySignedArtifacts.length > 0) {
  fail(
    [
      `Updater artifacts with signatures are empty for ${target} ${platform}:`,
      ...emptySignedArtifacts.map((signaturePath) => {
        const signedArtifactPath = signaturePath.slice(0, -".sig".length);
        return `- ${path.relative(rootDir, signedArtifactPath)}`;
      }),
    ].join("\n")
  );
}

console.log(
  `Verified ${signatureFiles.length} updater signature artifact(s) for ${target} ${platform}.`
);
