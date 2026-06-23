import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [expectedTarget, expectedPlatform, expectedKind, evidencePath] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveArtifactPath(relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
    fail(`Evidence artifact path must be repo-relative: ${relativePath}`);
  }

  return path.resolve(rootDir, relativePath);
}

function normalizeEvidencePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isSafeRepoRelativePath(filePath) {
  return (
    typeof filePath === "string" &&
    filePath.trim() !== "" &&
    !path.isAbsolute(filePath) &&
    !filePath.split(/[\\/]+/).includes("..")
  );
}

function hasArtifactEnding(artifacts, suffix) {
  return artifacts.some((artifact) => artifact.path.endsWith(suffix));
}

function hasSignatureForEnding(artifacts, suffix) {
  return artifacts.some(
    (artifact) => artifact.path.endsWith(`${suffix}.sig`) && artifact.signatureFor?.endsWith(suffix)
  );
}

function artifactVerification(artifact) {
  if (!isPlainObject(artifact.verification)) {
    return undefined;
  }

  return artifact.verification;
}

function successfulVerificationCheck(verification, checkName) {
  if (!Array.isArray(verification.checks)) {
    return undefined;
  }

  return verification.checks.find(
    (check) =>
      isPlainObject(check) &&
      check.name === checkName &&
      check.exitCode === 0 &&
      typeof check.command === "string" &&
      check.command.trim() !== ""
  );
}

function checkCombinedOutput(check) {
  return `${check.stdout ?? ""}${check.stderr ?? ""}`;
}

function requireSuccessfulVerificationCheck(artifact, verification, checkName) {
  const check = successfulVerificationCheck(verification, checkName);
  if (!check) {
    fail(`Artifact ${artifact.path} must include successful ${checkName} verification.`);
  }

  return check;
}

function requireCheckCommandContains(artifact, check, expectedToken) {
  if (!check.command.includes(expectedToken)) {
    fail(
      `Artifact ${artifact.path} ${check.name} command must include ${expectedToken}.`
    );
  }
}

function requireCheckOutputContains(artifact, check, expectedToken) {
  if (!checkCombinedOutput(check).includes(expectedToken)) {
    fail(
      `Artifact ${artifact.path} ${check.name} output must include ${expectedToken}.`
    );
  }
}

function validateMacosArtifactVerification(artifact) {
  const verification = artifactVerification(artifact);
  if (!verification) {
    fail(`macOS artifact ${artifact.path} must include verification metadata.`);
  }

  if (verification.platform !== "macos") {
    fail(`macOS artifact ${artifact.path} verification.platform must be macos.`);
  }

  if (verification.signed !== true) {
    fail(`macOS artifact ${artifact.path} verification.signed must be true.`);
  }

  if (verification.notarized !== true) {
    fail(`macOS artifact ${artifact.path} verification.notarized must be true.`);
  }

  if (!isSafeRepoRelativePath(verification.sourcePath)) {
    fail(`macOS artifact ${artifact.path} must include a safe repo-relative verification.sourcePath.`);
  }

  if (
    (artifact.path.endsWith("-macos-app.zip") || artifact.path.endsWith(".app.tar.gz")) &&
    !verification.sourcePath.endsWith(".app")
  ) {
    fail(`macOS app archive ${artifact.path} verification.sourcePath must point to a .app bundle.`);
  }

  if (artifact.path.endsWith(".dmg") && verification.sourcePath !== artifact.path) {
    fail(`macOS DMG artifact ${artifact.path} verification.sourcePath must match the DMG artifact path.`);
  }

  const codesignVerify = requireSuccessfulVerificationCheck(
    artifact,
    verification,
    "codesignVerify"
  );
  requireCheckCommandContains(artifact, codesignVerify, "codesign --verify");

  const codesignDetails = requireSuccessfulVerificationCheck(
    artifact,
    verification,
    "codesignDetails"
  );
  requireCheckCommandContains(artifact, codesignDetails, "codesign -dv");
  requireCheckOutputContains(artifact, codesignDetails, "Authority=");
  if (checkCombinedOutput(codesignDetails).includes("Signature=adhoc")) {
    fail(`macOS artifact ${artifact.path} must not be ad-hoc signed.`);
  }

  const spctlAssess = requireSuccessfulVerificationCheck(
    artifact,
    verification,
    "spctlAssess"
  );
  requireCheckCommandContains(artifact, spctlAssess, "spctl --assess");
  requireCheckOutputContains(artifact, spctlAssess, "accepted");

  const staplerValidate = requireSuccessfulVerificationCheck(
    artifact,
    verification,
    "staplerValidate"
  );
  requireCheckCommandContains(artifact, staplerValidate, "xcrun stapler validate");
  requireCheckOutputContains(artifact, staplerValidate, "The validate action worked!");
}

function validateWindowsSignedArtifactVerification(artifact) {
  const verification = artifactVerification(artifact);
  if (!verification) {
    fail(`Windows signed artifact ${artifact.path} must include verification metadata.`);
  }

  if (verification.platform !== "windows") {
    fail(`Windows signed artifact ${artifact.path} verification.platform must be windows.`);
  }

  if (verification.signed !== true) {
    fail(`Windows signed artifact ${artifact.path} verification.signed must be true.`);
  }

  const signtoolVerify = requireSuccessfulVerificationCheck(
    artifact,
    verification,
    "signtoolVerify"
  );
  requireCheckCommandContains(artifact, signtoolVerify, "signtool");
  requireCheckCommandContains(artifact, signtoolVerify, "verify");
  requireCheckOutputContains(artifact, signtoolVerify, "Successfully verified:");
}

function validateRequiredArtifactVerifications(artifacts) {
  let hasWindowsSignedInstallerVerification = false;

  for (const artifact of artifacts) {
    if (expectedPlatform === "macos") {
      if (
        artifact.path.endsWith("-macos-app.zip") ||
        artifact.path.endsWith(".app.tar.gz") ||
        artifact.path.endsWith(".dmg")
      ) {
        validateMacosArtifactVerification(artifact);
      }
      continue;
    }

    if (
      expectedPlatform === "windows" &&
      (artifact.path.endsWith(".exe") || artifact.path.endsWith(".msi"))
    ) {
      validateWindowsSignedArtifactVerification(artifact);
      hasWindowsSignedInstallerVerification = true;
    }
  }

  if (expectedPlatform === "windows" && !hasWindowsSignedInstallerVerification) {
    fail("Windows release evidence must include at least one .exe or .msi artifact with successful signtoolVerify verification.");
  }
}

function validateRequiredDistributionArtifacts(artifacts) {
  if (expectedPlatform === "macos") {
    if (!hasArtifactEnding(artifacts, "-macos-app.zip")) {
      fail(`macOS ${expectedTarget} distribution evidence must include the archived .app bundle.`);
    }
    if (!hasArtifactEnding(artifacts, ".dmg")) {
      fail(`macOS ${expectedTarget} distribution evidence must include the signed DMG installer.`);
    }
    return;
  }

  if (expectedPlatform === "windows") {
    const executableName =
      expectedTarget === "desktop" ? "shipflow3-tauri.exe" : "shipflow-service.exe";
    const installerName =
      expectedTarget === "desktop" ? "ShipFlow-Desktop-Setup.exe" : "ShipFlow-Service-Setup.exe";
    if (!hasArtifactEnding(artifacts, executableName)) {
      fail(`Windows ${expectedTarget} distribution evidence must include ${executableName}.`);
    }
    if (!hasArtifactEnding(artifacts, installerName)) {
      fail(`Windows ${expectedTarget} distribution evidence must include ${installerName}.`);
    }
  }
}

function validateRequiredUpdaterArtifacts(artifacts) {
  if (expectedPlatform === "macos") {
    if (!hasArtifactEnding(artifacts, ".app.tar.gz")) {
      fail(`macOS ${expectedTarget} updater evidence must include an .app.tar.gz archive.`);
    }
    if (!hasArtifactEnding(artifacts, ".dmg")) {
      fail(`macOS ${expectedTarget} updater evidence must include a DMG artifact.`);
    }
    if (!hasSignatureForEnding(artifacts, ".app.tar.gz")) {
      fail(`macOS ${expectedTarget} updater evidence must include an .app.tar.gz signature.`);
    }
    if (!hasSignatureForEnding(artifacts, ".dmg")) {
      fail(`macOS ${expectedTarget} updater evidence must include a DMG signature.`);
    }
    return;
  }

  if (expectedPlatform === "windows") {
    const windowsInstallerArtifacts = [".exe", ".msi", ".msi.zip", ".nsis.zip"];
    const hasSignedInstaller = windowsInstallerArtifacts.some((suffix) =>
      hasSignatureForEnding(artifacts, suffix)
    );
    if (!hasSignedInstaller) {
      fail(`Windows ${expectedTarget} updater evidence must include a signed installer artifact.`);
    }
  }
}

function validateUpdaterEndpoints(endpoints, fieldName) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    fail(`Release evidence must include non-empty ${fieldName}.`);
  }

  const seenEndpoints = new Set();
  for (const endpoint of endpoints) {
    if (typeof endpoint !== "string" || endpoint.trim() === "") {
      fail(`Release evidence ${fieldName} entries must be non-empty strings.`);
    }

    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      fail(`Release evidence includes an invalid updater endpoint: ${endpoint}`);
    }

    if (parsed.protocol !== "https:") {
      fail(`Release evidence endpoint must use HTTPS: ${endpoint}`);
    }

    if (seenEndpoints.has(endpoint)) {
      fail(`Release evidence contains duplicate updater endpoint: ${endpoint}`);
    }
    seenEndpoints.add(endpoint);
  }
}

function validateUpdaterConfigEvidence() {
  if (!isPlainObject(evidence.updaterConfig)) {
    fail("Release evidence must include updaterConfig.");
  }

  if (
    typeof evidence.updaterConfig.publicKeySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(evidence.updaterConfig.publicKeySha256)
  ) {
    fail("Release evidence updaterConfig.publicKeySha256 must be a sha256 digest.");
  }

  validateUpdaterEndpoints(evidence.updaterConfig.endpoints, "updaterConfig.endpoints");
}

if (
  !["desktop", "service"].includes(expectedTarget) ||
  !["macos", "windows"].includes(expectedPlatform) ||
  !["distribution", "updater"].includes(expectedKind) ||
  !evidencePath
) {
  fail("Usage: node scripts/verify-release-evidence.mjs <desktop|service> <macos|windows> <distribution|updater> <evidence.json>");
}

const resolvedEvidencePath = path.resolve(rootDir, evidencePath);
const evidence = JSON.parse(fs.readFileSync(resolvedEvidencePath, "utf8"));

if (!isPlainObject(evidence)) {
  fail("Release evidence must be a JSON object.");
}

for (const [field, expectedValue] of [
  ["schemaVersion", 1],
  ["target", expectedTarget],
  ["platform", expectedPlatform],
  ["kind", expectedKind],
]) {
  if (evidence[field] !== expectedValue) {
    fail(`Release evidence field ${field} must be ${expectedValue}.`);
  }
}

if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length === 0) {
  fail("Release evidence must include at least one artifact.");
}

const artifactsByPath = new Map();
for (const artifact of evidence.artifacts) {
  if (!isPlainObject(artifact)) {
    fail("Release evidence artifacts must be JSON objects.");
  }

  if (typeof artifact.path !== "string" || artifact.path.trim() === "") {
    fail("Release evidence artifact path must be a non-empty string.");
  }

  if (!Number.isInteger(artifact.bytes) || artifact.bytes <= 0) {
    fail(`Release evidence artifact ${artifact.path} must include positive bytes.`);
  }

  if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
    fail(`Release evidence artifact ${artifact.path} must include a sha256 digest.`);
  }

  const resolvedArtifactPath = resolveArtifactPath(artifact.path);
  if (!fs.existsSync(resolvedArtifactPath)) {
    fail(`Release evidence artifact is missing on disk: ${artifact.path}`);
  }

  const stats = fs.statSync(resolvedArtifactPath);
  if (!stats.isFile()) {
    fail(`Release evidence artifact is not a file: ${artifact.path}`);
  }

  if (stats.size !== artifact.bytes) {
    fail(`Release evidence artifact byte count mismatch: ${artifact.path}`);
  }

  const actualSha256 = sha256File(resolvedArtifactPath);
  if (actualSha256 !== artifact.sha256) {
    fail(`Release evidence artifact sha256 mismatch: ${artifact.path}`);
  }

  const normalizedPath = normalizeEvidencePath(artifact.path);
  if (artifactsByPath.has(normalizedPath)) {
    fail(`Release evidence contains duplicate artifact path: ${artifact.path}`);
  }
  artifactsByPath.set(normalizedPath, artifact);
}

if (expectedKind === "distribution") {
  validateRequiredDistributionArtifacts(evidence.artifacts);
}

validateRequiredArtifactVerifications(evidence.artifacts);
validateUpdaterConfigEvidence();

if (expectedKind === "updater") {
  validateUpdaterEndpoints(evidence.updaterEndpoints, "updaterEndpoints");

  const signatureArtifacts = evidence.artifacts.filter((artifact) => artifact.path.endsWith(".sig"));
  if (signatureArtifacts.length === 0) {
    fail("Updater release evidence must include signature artifacts.");
  }

  for (const signatureArtifact of signatureArtifacts) {
    if (
      typeof signatureArtifact.signatureFor !== "string" ||
      signatureArtifact.signatureFor.trim() === ""
    ) {
      fail(`Updater signature evidence must include signatureFor: ${signatureArtifact.path}`);
    }

    const normalizedSignatureFor = normalizeEvidencePath(signatureArtifact.signatureFor);
    if (!artifactsByPath.has(normalizedSignatureFor)) {
      fail(
        `Updater signature evidence points to a missing artifact: ${signatureArtifact.path} -> ${signatureArtifact.signatureFor}`
      );
    }
  }

  validateRequiredUpdaterArtifacts(evidence.artifacts);
}

console.log(
  `Verified release evidence manifest for ${expectedTarget} ${expectedPlatform} ${expectedKind}: ${path.relative(rootDir, resolvedEvidencePath)}`
);
