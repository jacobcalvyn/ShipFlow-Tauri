import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [platform, evidenceDirArg, ...flags] = process.argv.slice(2);
const requireRepeatedLaunch = flags.includes("--require-repeated-launch");
const requireTrayActions = flags.includes("--require-tray-actions");
const requireTraySingleInstance = flags.includes("--require-tray-single-instance");
const requireWindowState = flags.includes("--require-window-state");
const requireMenuActions = flags.includes("--require-menu-actions");
const requiredMacosSignatureEvidenceFiles = [
  "desktop-codesign-verify.txt",
  "desktop-codesign-details.txt",
  "desktop-spctl-assess.txt",
  "desktop-stapler-validate.txt",
  "service-codesign-verify.txt",
  "service-codesign-details.txt",
  "service-spctl-assess.txt",
  "service-stapler-validate.txt",
];
const requiredWindowsSignatureEvidenceFiles = [
  "desktop-executable-signtool-verify.txt",
  "service-executable-signtool-verify.txt",
  "desktop-installer-signtool-verify.txt",
  "service-installer-signtool-verify.txt",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  fail(
    "Usage: node scripts/verify-native-runtime-evidence.mjs <macos|windows> <evidence-dir> [--require-repeated-launch] [--require-tray-actions] [--require-tray-single-instance] [--require-window-state] [--require-menu-actions]"
  );
}

function resolveEvidencePath(relativePath) {
  if (!evidenceDirArg || path.isAbsolute(evidenceDirArg)) {
    fail("Evidence directory must be a repo-relative path.");
  }

  const resolvedPath = path.resolve(rootDir, evidenceDirArg, relativePath);
  const resolvedEvidenceDir = path.resolve(rootDir, evidenceDirArg);
  if (!resolvedPath.startsWith(`${resolvedEvidenceDir}${path.sep}`)) {
    fail(`Evidence path escapes the evidence directory: ${relativePath}`);
  }

  return resolvedPath;
}

function readRequiredText(relativePath) {
  const resolvedPath = resolveEvidencePath(relativePath);
  if (!fs.existsSync(resolvedPath)) {
    fail(`Missing native runtime evidence file: ${relativePath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile() || stats.size === 0) {
    fail(`Native runtime evidence file must be non-empty: ${relativePath}`);
  }

  return fs.readFileSync(resolvedPath, "utf8");
}

function requireFileContains(relativePath, token) {
  const text = readRequiredText(relativePath);
  if (!text.includes(token)) {
    fail(`Native runtime evidence file ${relativePath} must include ${token}.`);
  }
}

function requireFileNotContains(relativePath, token) {
  const text = readRequiredText(relativePath);
  if (text.includes(token)) {
    fail(`Native runtime evidence file ${relativePath} must not include ${token}.`);
  }
}

function matchingEvidenceLines(text, tokens) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && tokens.some((token) => line.includes(token)));
}

function matchingProcessRecordCount(text, tokens) {
  if (/^ProcessId\s*:/mu.test(text) && /^Name\s*:/mu.test(text)) {
    return text
      .split(/(?=^ProcessId\s*:)/mu)
      .filter((record) => /^ProcessId\s*:/mu.test(record))
      .filter((record) => tokens.some((token) => record.includes(token))).length;
  }

  return matchingEvidenceLines(text, tokens).length;
}

function requireExactlyOneProcessRecord(relativePath, tokens, label) {
  const text = readRequiredText(relativePath);
  const processRecordCount = matchingProcessRecordCount(text, tokens);

  if (processRecordCount !== 1) {
    fail(
      `Native runtime evidence file ${relativePath} must include exactly one ${label} process record, found ${processRecordCount}.`
    );
  }
}

function verifyMacosSignatureEvidence(label) {
  requireFileContains(
    `${label}-codesign-verify.txt`,
    "codesign --verify --deep --strict --verbose=2"
  );
  requireFileContains(`${label}-codesign-details.txt`, "Authority=");
  requireFileNotContains(`${label}-codesign-details.txt`, "Signature=adhoc");
  requireFileContains(`${label}-spctl-assess.txt`, "spctl --assess --type execute --verbose");
  requireFileContains(`${label}-spctl-assess.txt`, "accepted");
  requireFileContains(`${label}-stapler-validate.txt`, "xcrun stapler validate");
  requireFileContains(`${label}-stapler-validate.txt`, "The validate action worked!");
}

function verifyWindowsSignatureEvidence(label) {
  requireFileContains(`${label}-signtool-verify.txt`, "Successfully verified:");
}

function verifyServiceTrayActionEvidence() {
  for (const token of [
    "[ShipFlowServiceTray] open service settings succeeded",
    "[ShipFlowServiceTray] open desktop succeeded",
    "[ShipFlowServiceTray] copy endpoint succeeded",
    "[ShipFlowServiceTray] restart API succeeded",
    "[ShipFlowServiceTray] quit requested",
  ]) {
    requireFileContains("service-tray-runtime-log.txt", token);
  }
}

function verifyWindowsDesktopTrayActionEvidence() {
  for (const token of [
    "[ShipFlowDesktopTray] Windows tray ready",
    "[ShipFlowDesktopTray] main window hidden to tray",
    "[ShipFlowDesktopTray] open desktop requested",
    "[ShipFlowDesktopTray] quitting ShipFlow Desktop",
  ]) {
    requireFileContains("desktop-runtime-log.txt", token);
  }
}

function verifyMacosNativeMenuActionEvidence() {
  for (const token of [
    "[ShipFlowDesktopMenu] command show-settings emitted",
    "[ShipFlowDesktopMenu] native quit requested",
  ]) {
    requireFileContains("desktop-runtime-log.txt", token);
  }

  for (const token of [
    "[ShipFlowServiceMenu] open preferences succeeded",
    "[ShipFlowServiceMenu] quitting ShipFlow Service",
  ]) {
    requireFileContains("service-runtime-log.txt", token);
  }
}

function verifyServiceTraySingleInstanceEvidence() {
  requireExactlyOneProcessRecord(
    "service-tray-single-instance-processes.txt",
    ["--shipflow-service-tray"],
    "Service tray"
  );
  requireFileContains(
    "service-tray-runtime-log.txt",
    "[ShipFlowServiceTray] duplicate tray launch skipped"
  );
}

function verifySavedWindowStateEvidence() {
  let state;
  try {
    state = JSON.parse(readRequiredText("window-state.json"));
  } catch (error) {
    fail(`Native runtime evidence file window-state.json must be valid JSON: ${error}`);
  }

  if (state?.version !== 1 || typeof state?.windows !== "object" || state.windows === null) {
    fail("Native runtime evidence file window-state.json must include version 1 and windows.");
  }

  for (const [windowKey, label] of [
    ["desktop.main", "Desktop main"],
    ["service.settings", "Service Settings"],
  ]) {
    const windowState = state.windows[windowKey];
    if (!windowState || typeof windowState !== "object") {
      fail(`Native runtime evidence file window-state.json must include ${label} state.`);
    }

    for (const field of ["x", "y", "width", "height"]) {
      if (!Number.isInteger(windowState[field])) {
        fail(
          `Native runtime evidence file window-state.json ${windowKey}.${field} must be an integer.`
        );
      }
    }

    if (windowState.width < 640 || windowState.height < 480) {
      fail(
        `Native runtime evidence file window-state.json ${windowKey} must store a usable restored size.`
      );
    }

    if (typeof windowState.maximized !== "boolean") {
      fail(
        `Native runtime evidence file window-state.json ${windowKey}.maximized must be a boolean.`
      );
    }
  }
}

function verifyWindowStateSourceEvidence(allowedPathFragments) {
  const sourcePath = readRequiredText("window-state-source.txt")
    .trim()
    .replaceAll("\\", "/");

  if (
    !sourcePath.endsWith("/shipflow-service-runtime/window-state.json") ||
    !allowedPathFragments.some((fragment) => sourcePath.includes(fragment))
  ) {
    fail(
      "Native runtime evidence file window-state-source.txt must point to an installed ShipFlow runtime window-state.json path."
    );
  }
}

function verifyMacosEvidence() {
  for (const [relativePath, token] of [
    ["README.txt", "ShipFlow native runtime smoke evidence was collected from installed macOS apps."],
    ["desktop-plist-bundle-id.txt", "com.shipflow.desktop"],
    ["desktop-plist-executable.txt", "shipflow3-tauri"],
    ["service-plist-bundle-id.txt", "com.shipflow.service"],
    ["service-plist-executable.txt", "shipflow-service"],
    ["desktop-launchservices-discovery.txt", "Bundle ID: com.shipflow.desktop"],
    ["desktop-launchservices-discovery.txt", "LaunchServices discovery matched installed app path."],
    ["service-launchservices-discovery.txt", "Bundle ID: com.shipflow.service"],
    ["service-launchservices-discovery.txt", "LaunchServices discovery matched installed app path."],
    ["service-login-launch-agent.plist", "<string>com.shipflow.service-login</string>"],
    ["service-login-launch-agent.plist", "/usr/bin/open"],
    ["service-login-launch-agent.plist", "<string>-b</string>"],
    ["service-login-launch-agent.plist", "<string>com.shipflow.service</string>"],
    ["service-login-launch-agent.plist", "<string>--args</string>"],
    ["service-login-launch-agent.plist", "--shipflow-service-autostart"],
    ["service-login-launchctl-print.txt", "com.shipflow.service-login"],
  ]) {
    requireFileContains(relativePath, token);
  }

  requireFileNotContains("service-login-launch-agent.plist", "<string>-n</string>");
  requireFileNotContains("service-login-launch-agent.plist", "<string>--shipflow-service-tray</string>");
  requireFileNotContains("service-login-launch-agent.plist", "Contents/MacOS");

  for (const relativePath of requiredMacosSignatureEvidenceFiles) {
    readRequiredText(relativePath);
  }

  verifyMacosSignatureEvidence("desktop");
  verifyMacosSignatureEvidence("service");
  readRequiredText("process-snapshot.txt");

  if (requireRepeatedLaunch) {
    requireFileContains("desktop-single-instance-processes.txt", "Desktop process snapshot after repeated launch:");
    requireExactlyOneProcessRecord(
      "desktop-single-instance-processes.txt",
      ["shipflow3-tauri", "ShipFlow Desktop"],
      "Desktop"
    );
    requireFileContains(
      "desktop-runtime-log.txt",
      "[ShipFlowDesktop] secondary launch delegated to existing desktop instance"
    );
    requireFileContains(
      "service-settings-single-instance-processes.txt",
      "Service Settings process snapshot after repeated launch:"
    );
    requireExactlyOneProcessRecord(
      "service-settings-single-instance-processes.txt",
      ["shipflow-service", "ShipFlow Service"],
      "Service Settings"
    );
    requireFileContains(
      "service-runtime-log.txt",
      "[ShipFlowService] secondary launch delegated to existing service settings instance"
    );
  }

  if (requireTrayActions) {
    verifyServiceTrayActionEvidence();
  }

  if (requireTraySingleInstance) {
    verifyServiceTraySingleInstanceEvidence();
  }

  if (requireMenuActions) {
    verifyMacosNativeMenuActionEvidence();
  }

  if (requireWindowState) {
    verifySavedWindowStateEvidence();
    verifyWindowStateSourceEvidence([
      "/Library/Application Support/ShipFlow Service/",
    ]);
  }
}

function verifyWindowsEvidence() {
  for (const [relativePath, token] of [
    ["README.txt", "ShipFlow native runtime smoke evidence was collected from installed Windows apps."],
    ["desktop-install-registry.txt", "InstallLocation"],
    ["desktop-install-registry.txt", "ExecutablePath"],
    ["service-install-registry.txt", "InstallLocation"],
    ["service-install-registry.txt", "ExecutablePath"],
    ["desktop-executable-discovery.txt", "Expected executable name: shipflow3-tauri.exe"],
    ["desktop-executable-discovery.txt", "Windows registry discovery matched collector executable path."],
    ["service-executable-discovery.txt", "Expected executable name: shipflow-service.exe"],
    ["service-executable-discovery.txt", "Windows registry discovery matched collector executable path."],
    ["service-login-run-registry.txt", "ShipFlowService"],
    ["service-login-run-registry.txt", "shipflow-service.exe"],
    ["service-login-run-registry.txt", "--shipflow-service-autostart"],
    ["service-legacy-tray-run-registry-absent.txt", "ShipFlowServiceTray Run value is absent."],
  ]) {
    requireFileContains(relativePath, token);
  }

  for (const relativePath of requiredWindowsSignatureEvidenceFiles) {
    readRequiredText(relativePath);
  }

  verifyWindowsSignatureEvidence("desktop-executable");
  verifyWindowsSignatureEvidence("service-executable");
  verifyWindowsSignatureEvidence("desktop-installer");
  verifyWindowsSignatureEvidence("service-installer");
  readRequiredText("shipflow-process-snapshot.txt");

  if (requireRepeatedLaunch) {
    requireExactlyOneProcessRecord(
      "desktop-single-instance-processes.txt",
      ["shipflow3-tauri.exe"],
      "Desktop"
    );
    requireFileContains(
      "desktop-runtime-log.txt",
      "[ShipFlowDesktopLaunch] activation request consumed by existing desktop process"
    );
    requireFileContains(
      "desktop-runtime-log.txt",
      "[ShipFlowDesktopTray] Windows tray ready"
    );
    requireExactlyOneProcessRecord(
      "service-settings-single-instance-processes.txt",
      ["shipflow-service.exe"],
      "Service Settings"
    );
    requireFileContains(
      "service-runtime-log.txt",
      "[ShipFlowServiceLaunch] activation request consumed by existing service settings process"
    );
  }

  if (requireTrayActions) {
    verifyWindowsDesktopTrayActionEvidence();
    verifyServiceTrayActionEvidence();
  }

  if (requireTraySingleInstance) {
    verifyServiceTraySingleInstanceEvidence();
  }

  if (requireWindowState) {
    verifySavedWindowStateEvidence();
    verifyWindowStateSourceEvidence([
      "/AppData/Roaming/ShipFlow Service/",
    ]);
  }
}

if (!["macos", "windows"].includes(platform) || !evidenceDirArg) {
  usage();
}

if (
  flags.some(
    (flag) =>
      ![
        "--require-repeated-launch",
        "--require-tray-actions",
        "--require-tray-single-instance",
        "--require-window-state",
        "--require-menu-actions",
      ].includes(flag)
  )
) {
  usage();
}

if (platform === "macos") {
  verifyMacosEvidence();
} else {
  verifyWindowsEvidence();
}

console.log(
  `Verified ${platform} native runtime evidence: ${path.relative(rootDir, path.resolve(rootDir, evidenceDirArg))}`
);
