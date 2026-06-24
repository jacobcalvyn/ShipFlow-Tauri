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
const updaterRuntimeFiles = [
  path.join(rootDir, "Cargo.toml"),
  path.join(rootDir, "crates", "shipflow-tauri-runtime", "src", "app_runtime.rs"),
  path.join(rootDir, "crates", "shipflow-tauri-runtime", "src", "updater_runtime.rs"),
  path.join(rootDir, "src-tauri", "src", "app_menu_runtime.rs"),
  path.join(rootDir, "src-tauri", "src", "desktop_app.rs"),
  path.join(
    rootDir,
    "crates",
    "shipflow-tauri-runtime",
    "src",
    "service_settings_app.rs"
  ),
  path.join(rootDir, "src-tauri", "src", "commands", "system.rs"),
  path.join(rootDir, "src", "backend", "commands.ts"),
  path.join(rootDir, "src", "features", "workspace", "useWorkspaceShellController.ts"),
  path.join(rootDir, "src", "features", "service", "components", "ServiceSettingsWindow.tsx"),
  path.join(rootDir, "scripts", "build-updater-artifacts.mjs"),
  path.join(rootDir, "scripts", "create-release-build-config.mjs"),
  path.join(rootDir, "scripts", "generate-release-evidence.mjs"),
  path.join(rootDir, "scripts", "verify-release-evidence.mjs"),
  path.join(rootDir, "scripts", "verify-native-runtime-evidence.mjs"),
  path.join(rootDir, "scripts", "verify-updater-signatures.mjs"),
  path.join(rootDir, ".github", "workflows", "build-updater-artifacts.yml"),
];
const nativeReleaseGateFiles = [
  path.join(rootDir, ".github", "workflows", "quality.yml"),
  path.join(rootDir, ".github", "workflows", "build-macos-app.yml"),
  path.join(rootDir, ".github", "workflows", "build-service-macos-app.yml"),
  path.join(rootDir, ".github", "workflows", "build-windows-exe.yml"),
  path.join(rootDir, ".github", "workflows", "build-service-windows-installer.yml"),
  path.join(rootDir, "scripts", "macos", "notarize-app.sh"),
  path.join(rootDir, "scripts", "macos", "collect-native-runtime-evidence.sh"),
  path.join(rootDir, "scripts", "macos", "resign-updater-artifacts-after-notarization.sh"),
  path.join(rootDir, "scripts", "windows", "resolve-makensis.ps1"),
  path.join(rootDir, "scripts", "windows", "sign-windows-artifact.ps1"),
  path.join(rootDir, "scripts", "windows", "sign-windows-artifact-from-env.ps1"),
  path.join(rootDir, "scripts", "windows", "resolve-tauri-version.ps1"),
  path.join(rootDir, "scripts", "windows", "build-desktop-installer.ps1"),
  path.join(rootDir, "scripts", "windows", "build-service-installer.ps1"),
  path.join(rootDir, "scripts", "windows", "collect-native-runtime-evidence.ps1"),
  path.join(rootDir, "scripts", "test-native-runtime-evidence-verifier.mjs"),
  path.join(rootDir, "scripts", "windows", "desktop-installer-hooks.nsh"),
  path.join(rootDir, "scripts", "windows", "service-installer-hooks.nsh"),
  path.join(rootDir, "crates", "shipflow-tauri-runtime", "src", "service.rs"),
  path.join(rootDir, "crates", "shipflow-tauri-runtime", "src", "service_runtime.rs"),
  path.join(rootDir, "crates", "shipflow-tauri-runtime", "src", "service", "process_runtime.rs"),
  path.join(rootDir, "crates", "shipflow-tauri-runtime", "src", "service", "tray_runtime.rs"),
  path.join(rootDir, "crates", "shipflow-tauri-runtime", "src", "service", "state_store.rs"),
  path.join(rootDir, "crates", "shipflow-tauri-runtime", "src", "window_runtime.rs"),
  path.join(rootDir, "src-tauri", "src", "main.rs"),
  path.join(rootDir, "apps", "service", "src", "main.rs"),
  path.join(rootDir, "src", "features", "service", "useServiceSettingsController.ts"),
  path.join(rootDir, "scripts", "windows", "shipflow-desktop-installer.nsi"),
  path.join(rootDir, "scripts", "windows", "shipflow-service-installer.nsi"),
  path.join(rootDir, "docs", "native-runtime-release-smoke-checklist.md"),
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

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function requireTokenOrder(source, firstToken, secondToken, message) {
  const firstIndex = source.indexOf(firstToken);
  const secondIndex = source.indexOf(secondToken);

  if (firstIndex === -1 || secondIndex === -1 || firstIndex > secondIndex) {
    errors.push(message);
  }
}

function requireTokenAfter(source, anchorToken, requiredToken, message) {
  const anchorIndex = source.indexOf(anchorToken);
  if (anchorIndex === -1 || source.indexOf(requiredToken, anchorIndex) === -1) {
    errors.push(message);
  }
}

function requireTokenBetween(source, startToken, endToken, requiredToken, message) {
  const startIndex = source.indexOf(startToken);
  const endIndex = source.indexOf(endToken, startIndex + startToken.length);
  if (startIndex === -1 || endIndex === -1) {
    errors.push(message);
    return;
  }

  const scopedSource = source.slice(startIndex, endIndex);
  if (!scopedSource.includes(requiredToken)) {
    errors.push(message);
  }
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
  const macosSigningIdentity = config.bundle?.macOS?.signingIdentity;
  const expectedWindowsInstallerHooks = filePath.endsWith(
    path.join("src-tauri", "tauri.conf.json")
  )
    ? "../scripts/windows/desktop-installer-hooks.nsh"
    : "../../scripts/windows/service-installer-hooks.nsh";

  if (macosSigningIdentity === "-") {
    errors.push(
      `${relativePath(filePath)} must not default macOS builds to ad-hoc signing. Release workflows must inject APPLE_SIGNING_IDENTITY explicitly.`
    );
  }

  if (config.bundle?.windows?.nsis?.installerHooks !== expectedWindowsInstallerHooks) {
    errors.push(
      `${relativePath(filePath)} must configure Windows NSIS installerHooks as ${expectedWindowsInstallerHooks}.`
    );
  }

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

const [
  rootCargoToml,
  appRuntimeSource,
  updaterRuntimeSource,
  appMenuRuntimeSource,
  desktopAppSource,
  serviceSettingsSource,
  desktopSystemCommandsSource,
  frontendCommandsSource,
  workspaceShellControllerSource,
  serviceSettingsWindowSource,
  updaterBuildScript,
  releaseBuildConfigScript,
  releaseEvidenceScript,
  releaseEvidenceVerifier,
  nativeRuntimeEvidenceVerifier,
  updaterSignatureVerifier,
  updaterWorkflow,
] = updaterRuntimeFiles.map(readText);
const [
  qualityWorkflow,
  desktopMacosWorkflow,
  serviceMacosWorkflow,
  desktopWindowsWorkflow,
  serviceWindowsWorkflow,
  macosNotarizeScript,
  macosCollectNativeRuntimeEvidenceScript,
  macosResignUpdaterScript,
  windowsResolveMakensisScript,
  windowsSignScript,
  windowsSignFromEnvScript,
  windowsResolveTauriVersionScript,
  windowsBuildDesktopInstallerScript,
  windowsBuildServiceInstallerScript,
  windowsCollectNativeRuntimeEvidenceScript,
  nativeRuntimeEvidenceVerifierSmokeScript,
  desktopWindowsInstallerHooksSource,
  serviceWindowsInstallerHooksSource,
  serviceRuntimeSource,
  serviceTrayStateRuntime,
  serviceProcessRuntime,
  serviceTrayRuntime,
  serviceStateStoreSource,
  windowRuntimeSource,
  desktopMainSource,
  serviceMainSource,
  serviceSettingsControllerSource,
  desktopWindowsInstallerSource,
  serviceWindowsInstallerSource,
  nativeRuntimeSmokeChecklist,
] = nativeReleaseGateFiles.map(readText);

if (!rootCargoToml.includes("tauri-plugin-updater")) {
  errors.push("Cargo.toml must include the Tauri updater plugin dependency.");
}

if (!rootCargoToml.includes("tauri-plugin-single-instance")) {
  errors.push("Cargo.toml must include the Tauri single-instance plugin dependency.");
}

if (!appRuntimeSource.includes("tauri_plugin_single_instance::init")) {
  errors.push(
    "crates/shipflow-tauri-runtime/src/app_runtime.rs must build the native single-instance plugins."
  );
}

for (const requiredToken of [
  "tauri_plugin_updater::Builder::new().build()",
  "pub fn is_signed_updater_configured",
  "pub fn maybe_install_signed_updater_plugin",
  "plugins.updater is not configured",
]) {
  if (!appRuntimeSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/app_runtime.rs must keep updater runtime token ${requiredToken}.`
    );
  }
}

if (!appRuntimeSource.includes("builder.plugin(build_signed_updater_plugin())")) {
  errors.push(
    "crates/shipflow-tauri-runtime/src/app_runtime.rs must install the signed updater plugin from the conditional runtime helper."
  );
}

for (const requiredToken of [
  "pub struct AppReleaseHealth",
  "pub fn app_release_health",
  "app_identifier: config.identifier.clone()",
  "product_name: config",
  "updater_plugin_ready: app_handle.updater().is_ok()",
]) {
  if (!updaterRuntimeSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/updater_runtime.rs must keep release health token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "get_release_health(app_handle: tauri::AppHandle)",
  "app_release_health(&app_handle)",
]) {
  if (!desktopSystemCommandsSource.includes(requiredToken)) {
    errors.push(
      `src-tauri/src/commands/system.rs must expose Desktop release health token ${requiredToken}.`
    );
  }
  if (!serviceSettingsSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service_settings_app.rs must expose Service release health token ${requiredToken}.`
    );
  }
}

for (const requiredToken of ["appIdentifier", "productName", "updaterPluginReady"]) {
  if (!frontendCommandsSource.includes(requiredToken)) {
    errors.push(`src/backend/commands.ts must expose release health field ${requiredToken}.`);
  }
}

if (!desktopAppSource.includes(".plugin(build_desktop_single_instance_plugin())")) {
  errors.push("src-tauri/src/desktop_app.rs must register the desktop single-instance plugin.");
}

if (!desktopAppSource.includes("let context = tauri::generate_context!()")) {
  errors.push("src-tauri/src/desktop_app.rs must create context before conditional updater registration.");
}

if (!desktopAppSource.includes("maybe_install_signed_updater_plugin(builder, context.config())")) {
  errors.push("src-tauri/src/desktop_app.rs must register the updater plugin conditionally.");
}

if (
  desktopAppSource.indexOf(".plugin(build_desktop_single_instance_plugin())") >
  desktopAppSource.indexOf("maybe_install_signed_updater_plugin(builder, context.config())")
) {
  errors.push("src-tauri/src/desktop_app.rs must register single-instance before updater wiring.");
}

if (!serviceSettingsSource.includes(".plugin(build_service_settings_single_instance_plugin())")) {
  errors.push(
    "crates/shipflow-tauri-runtime/src/service_settings_app.rs must register the service settings single-instance plugin."
  );
}

if (!serviceSettingsSource.includes("maybe_install_signed_updater_plugin(builder, context.config())")) {
  errors.push(
    "crates/shipflow-tauri-runtime/src/service_settings_app.rs must register the updater plugin conditionally."
  );
}

if (
  serviceSettingsSource.indexOf(".plugin(build_service_settings_single_instance_plugin())") >
  serviceSettingsSource.indexOf("maybe_install_signed_updater_plugin(builder, context.config())")
) {
  errors.push(
    "crates/shipflow-tauri-runtime/src/service_settings_app.rs must register single-instance before updater wiring."
  );
}

for (const requiredToken of [
  "pub fn maybe_delegate_desktop_launch_to_existing_process()",
  "pub fn maybe_delegate_service_settings_launch_to_existing_process()",
  "claim_current_service_tray_process()?",
  "#[cfg(target_os = \"windows\")]",
  "#[cfg(not(target_os = \"windows\"))]",
]) {
  if (!serviceRuntimeSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service.rs must keep platform-specific UI delegation token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "CreateMutexW",
  "ERROR_ALREADY_EXISTS",
  "DESKTOP_UI_MUTEX_NAME: &str = \"Local\\\\ShipFlow.Desktop.UI\"",
  "SERVICE_SETTINGS_UI_MUTEX_NAME: &str = \"Local\\\\ShipFlow.Service.Settings.UI\"",
  "SERVICE_TRAY_UI_MUTEX_NAME: &str = \"Local\\\\ShipFlow.Service.Tray.UI\"",
  "DESKTOP_UI_MUTEX_GUARD",
  "SERVICE_SETTINGS_UI_MUTEX_GUARD",
  "SERVICE_TRAY_UI_MUTEX_GUARD",
  "claim_windows_named_mutex",
  "persist_desktop_activation_request(&DesktopActivationRequest",
  "wait_for_desktop_activation_request_consumed(Duration::from_secs(3))",
  "clear_desktop_activation_request();",
  "persist_service_settings_activation_request(&DesktopActivationRequest",
  "wait_for_service_settings_activation_request_consumed(Duration::from_secs(3))",
  "clear_service_settings_activation_request();",
]) {
  if (!serviceProcessRuntime.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service/process_runtime.rs must keep Windows mutex and activation-request token ${requiredToken}.`
    );
  }
}

requireTokenOrder(
  desktopMainSource,
  "maybe_delegate_to_existing_desktop_process()",
  "shipflow3_tauri_lib::run()",
  "src-tauri/src/main.rs must delegate duplicate Desktop launches before building the Tauri app."
);
requireTokenOrder(
  serviceMainSource,
  "maybe_run_service_autostart_from_current_args()",
  "maybe_run_service_tray_from_current_args()",
  "apps/service/src/main.rs must handle login autostart before tray mode."
);
requireTokenOrder(
  serviceMainSource,
  "maybe_run_service_tray_from_current_args()",
  "maybe_run_service_process_from_current_args()",
  "apps/service/src/main.rs must handle tray mode before service runtime mode."
);
requireTokenOrder(
  serviceMainSource,
  "maybe_run_service_process_from_current_args()",
  "maybe_delegate_service_settings_launch_to_existing_process()",
  "apps/service/src/main.rs must handle background service mode before Service Settings UI delegation."
);
requireTokenOrder(
  serviceMainSource,
  "maybe_delegate_service_settings_launch_to_existing_process()",
  "run_service_settings_with_context",
  "apps/service/src/main.rs must delegate duplicate Service Settings launches before building the Tauri app."
);

for (const forbiddenToken of [
  "pub fn maybe_delegate_desktop_launch_to_existing_process() -> Result<bool, String> {\n    if !claim_desktop_ui_single_instance()",
  "pub fn maybe_delegate_service_settings_launch_to_existing_process() -> Result<bool, String> {\n    let should_show_window = should_show_service_settings_window_from_current_args();",
  "return focus_existing_desktop_process();",
  "focus_existing_service_settings_process()?",
]) {
  if (serviceRuntimeSource.includes(forbiddenToken)) {
    errors.push(
      "crates/shipflow-tauri-runtime/src/service.rs must keep Windows named mutex as the authoritative pre-launch single-instance gate."
    );
  }
}

for (const requiredToken of [
  "check_app_update_runtime",
  "install_app_update_runtime",
  "download_and_install",
]) {
  if (!updaterRuntimeSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/updater_runtime.rs must include ${requiredToken}.`
    );
  }
}

for (const requiredToken of ["check_app_update", "install_app_update"]) {
  if (!desktopSystemCommandsSource.includes(requiredToken)) {
    errors.push(
      `src-tauri/src/commands/system.rs must expose ${requiredToken}.`
    );
  }

  if (!desktopAppSource.includes(`commands::system::${requiredToken}`)) {
    errors.push(
      `src-tauri/src/desktop_app.rs must register ${requiredToken}.`
    );
  }

  if (!serviceSettingsSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service_settings_app.rs must register ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "checkAppUpdate",
  "installAppUpdate",
  "Check Update",
  "Install Update",
]) {
  if (
    !frontendCommandsSource.includes(requiredToken) &&
    !serviceSettingsWindowSource.includes(requiredToken)
  ) {
    errors.push(
      `Updater frontend path must include ${requiredToken}.`
    );
  }
}

for (const requiredToken of ["getReleaseHealth", "getAppReleaseHealth"]) {
  if (!serviceSettingsControllerSource.includes(requiredToken)) {
    errors.push(
      `src/features/service/useServiceSettingsController.ts must keep Service release health controller token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "onGetReleaseHealth",
  "Cek Health",
  "appIdentifier",
  "productName",
  "updaterPluginReady",
]) {
  if (!serviceSettingsWindowSource.includes(requiredToken)) {
    errors.push(
      `src/features/service/components/ServiceSettingsWindow.tsx must expose Service release health UI token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "app-menu-check-for-updates",
  "app-menu-install-app-update",
  "Check for Updates...",
  "Install Available Update...",
  "Preferences...",
  "[ShipFlowDesktopMenu] command {command} emitted to {label}",
  "PredefinedMenuItem::about",
  "PredefinedMenuItem::hide",
  "PredefinedMenuItem::hide_others",
  "PredefinedMenuItem::show_all",
  "PredefinedMenuItem::quit",
  "PredefinedMenuItem::services",
  "#[cfg(target_os = \"macos\")]",
]) {
  if (!appMenuRuntimeSource.includes(requiredToken)) {
    errors.push(
      `src-tauri/src/app_menu_runtime.rs must expose native menu item ${requiredToken}.`
    );
  }
}

for (const requiredToken of ["check-for-updates", "install-app-update"]) {
  if (!workspaceShellControllerSource.includes(requiredToken)) {
    errors.push(
      `src/features/workspace/useWorkspaceShellController.ts must handle ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_UPDATER_PUBLIC_KEY",
  "TAURI_UPDATER_ENDPOINTS",
  "APPLE_SIGNING_IDENTITY",
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "function cleanTargetBundleRoot",
  "fs.rmSync(targetBundleRoot(targetName), { recursive: true, force: true })",
  "cleanTargetBundleRoot(target);",
  "bundle.macOS",
  "bundle.windows",
  "signCommand",
  "sign-windows-artifact-from-env.ps1",
  "function windowsInstallerHooksPath",
  "desktop-installer-hooks.nsh",
  "service-installer-hooks.nsh",
  "installerHooks",
  "nsis",
  'parsed.protocol !== "https:"',
  "Duplicate updater endpoint:",
]) {
  if (!updaterBuildScript.includes(requiredToken)) {
    errors.push(
      `scripts/build-updater-artifacts.mjs must enforce ${requiredToken} for production updater builds.`
    );
  }
}

for (const requiredToken of [
  "TAURI_UPDATER_PUBLIC_KEY",
  "TAURI_UPDATER_ENDPOINTS",
  'parsed.protocol !== "https:"',
  "Duplicate updater endpoint:",
  "APPLE_SIGNING_IDENTITY",
  "plugins",
  "updater",
  "pubkey",
  "endpoints",
  "installMode",
  "passive",
]) {
  if (!releaseBuildConfigScript.includes(requiredToken)) {
    errors.push(
      `scripts/create-release-build-config.mjs must enforce updater-ready release config token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "No updater .sig files were produced",
  "No ${platform} updater .sig files were produced",
  "Updater signature files from a different platform were found",
  "function isSignatureForPlatform",
  "isSignatureForPlatform(signaturePath, platform)",
  "platformSignatureFiles",
  "function isLikelyTauriSignature",
  "Updater signature files are not valid Tauri updater signature strings",
  "fs.readFileSync(signaturePath, \"utf8\")",
  "signedArtifactPaths",
  "No macOS app archive updater signature was produced",
  "No macOS DMG updater signature was produced",
  "No Windows installer updater signature was produced",
  "artifactPath.endsWith(\".app.tar.gz\")",
  "artifactPath.endsWith(\".dmg\")",
  "function targetBundleRoot",
  "const bundleRoot = targetBundleRoot(target);",
  'path.join(rootDir, "apps", "service", "target", "release", "bundle")',
  "signaturePath.slice(0, -\".sig\".length)",
  "Updater signature files without matching artifacts",
  "Updater signature files are empty",
  "Updater artifacts with signatures are empty",
  "fs.statSync(signaturePath).size === 0",
  "fs.statSync(signedArtifactPath).size === 0",
  "target",
  "release",
  "bundle",
]) {
  if (!updaterSignatureVerifier.includes(requiredToken)) {
    errors.push(
      `scripts/verify-updater-signatures.mjs must enforce updater signature artifact token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "schemaVersion: 1",
  "function sha256File",
  "crypto.createHash(\"sha256\")",
  "function distributionArtifacts",
  "function updaterArtifacts",
  "function buildMacosArtifactVerification",
  "function buildWindowsArtifactVerification",
  "function parseUpdaterEndpointsFromEnv",
  "function sha256String",
  "function buildUpdaterConfigEvidence",
  "TAURI_UPDATER_PUBLIC_KEY is required to generate release evidence.",
  "TAURI_UPDATER_ENDPOINTS is required to generate release evidence.",
  'parsed.protocol !== "https:"',
  "Duplicate updater endpoint:",
  "updaterConfig: buildUpdaterConfigEvidence()",
  "publicKeySha256",
  "evidence.updaterEndpoints = evidence.updaterConfig.endpoints;",
  "verification",
  "codesignVerify",
  "staplerValidate",
  "signtoolVerify",
  "signatureFor",
  "apps/service",
  "shipflow3-tauri.exe",
  "shipflow-service.exe",
  "ShipFlow-Desktop-Setup.exe",
  "ShipFlow-Service-Setup.exe",
  "No ${kind} artifacts found",
]) {
  if (!releaseEvidenceScript.includes(requiredToken)) {
    errors.push(
      `scripts/generate-release-evidence.mjs must include release evidence token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "schemaVersion",
  "function sha256File",
  "crypto.createHash(\"sha256\")",
  "function validateRequiredDistributionArtifacts",
  "function validateRequiredUpdaterArtifacts",
  "function validateUpdaterEndpoints",
  "function validateUpdaterConfigEvidence",
  "Release evidence must include updaterConfig.",
  "updaterConfig.publicKeySha256",
  "validateUpdaterEndpoints(evidence.updaterConfig.endpoints, \"updaterConfig.endpoints\")",
  "validateUpdaterConfigEvidence();",
  "Release evidence must include non-empty",
  "Release evidence endpoint must use HTTPS:",
  "duplicate updater endpoint",
  "function validateRequiredArtifactVerifications",
  "function isSafeRepoRelativePath",
  "function requireCheckOutputContains",
  "function requireCheckCommandContains",
  "verification.sourcePath",
  "verification.sourcePath must point to a .app bundle",
  "verification.sourcePath must match the DMG artifact path",
  "verification.signed !== true",
  "verification.notarized !== true",
  "Windows release evidence must include at least one .exe or .msi artifact",
  "signtoolVerify",
  "codesignVerify",
  "staplerValidate",
  "codesign --verify",
  "codesign -dv",
  "Authority=",
  "spctl --assess",
  "accepted",
  "xcrun stapler validate",
  "The validate action worked!",
  "Successfully verified:",
  "signatureFor",
  "updaterEndpoints",
  "artifactsByPath.has(normalizedSignatureFor)",
  "sha256 mismatch",
  "byte count mismatch",
  "Windows ${expectedTarget} distribution evidence must include ${executableName}.",
  "shipflow3-tauri.exe",
  "shipflow-service.exe",
  "ShipFlow-Desktop-Setup.exe",
  "ShipFlow-Service-Setup.exe",
  "Usage: node scripts/verify-release-evidence.mjs <desktop|service> <macos|windows> <distribution|updater> <evidence.json>",
]) {
  if (!releaseEvidenceVerifier.includes(requiredToken)) {
    errors.push(
      `scripts/verify-release-evidence.mjs must include release evidence verification token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "Usage: node scripts/verify-native-runtime-evidence.mjs <macos|windows> <evidence-dir> [--require-repeated-launch] [--require-tray-actions]",
  "readRequiredText",
  "requireFileContains",
  "requireFileNotContains",
  "matchingProcessRecordCount",
  "requireExactlyOneProcessRecord",
  "must include exactly one ${label} process record",
  "verifyMacosSignatureEvidence",
  "verifyWindowsSignatureEvidence",
  "codesign --verify --deep --strict --verbose=2",
  "Signature=adhoc",
  "spctl --assess --type execute --verbose",
  "The validate action worked!",
  "Successfully verified:",
  "verifyMacosEvidence",
  "verifyWindowsEvidence",
  "verifyServiceTrayActionEvidence",
  "verifyMacosNativeMenuActionEvidence",
  "verifyServiceTraySingleInstanceEvidence",
  "verifySavedWindowStateEvidence",
  "verifyWindowStateSourceEvidence",
  "service-login-launch-agent.plist",
  "desktop-launchservices-discovery.txt",
  "service-launchservices-discovery.txt",
  "LaunchServices discovery matched installed app path.",
  "desktop-codesign-verify.txt",
  "desktop-stapler-validate.txt",
  "service-codesign-verify.txt",
  "service-stapler-validate.txt",
  "desktop-executable-signtool-verify.txt",
  "service-executable-signtool-verify.txt",
  "desktop-installer-signtool-verify.txt",
  "service-installer-signtool-verify.txt",
  "service-legacy-tray-run-registry-absent.txt",
  "desktop-executable-discovery.txt",
  "service-executable-discovery.txt",
  "Windows registry discovery matched collector executable path.",
  "ShipFlowServiceTray Run value is absent.",
  "shipflow-service.exe",
  "<string>com.shipflow.service-login</string>",
  "<string>-b</string>",
  "<string>com.shipflow.service</string>",
  "<string>--args</string>",
  "<string>--shipflow-service-tray</string>",
  "Contents/MacOS",
  "desktop-single-instance-processes.txt",
  "service-settings-single-instance-processes.txt",
  "service-tray-single-instance-processes.txt",
  "window-state.json",
  "window-state-source.txt",
  "desktop-runtime-log.txt",
  "service-runtime-log.txt",
  "service-tray-runtime-log.txt",
  "[ShipFlowDesktop] secondary launch delegated to existing desktop instance",
  "[ShipFlowDesktopMenu] command show-settings emitted",
  "[ShipFlowDesktopMenu] native quit requested",
  "[ShipFlowService] secondary launch delegated to existing service settings instance",
  "[ShipFlowServiceMenu] open preferences succeeded",
  "[ShipFlowServiceMenu] quitting ShipFlow Service",
  "[ShipFlowDesktopLaunch] activation request consumed by existing desktop process",
  "[ShipFlowDesktopTray] Windows tray ready",
  "[ShipFlowDesktopTray] main window hidden to tray",
  "[ShipFlowDesktopTray] open desktop requested",
  "[ShipFlowDesktopTray] quitting ShipFlow Desktop",
  "[ShipFlowServiceLaunch] activation request consumed by existing service settings process",
  "[ShipFlowServiceTray] open service settings succeeded",
  "[ShipFlowServiceTray] open desktop succeeded",
  "[ShipFlowServiceTray] copy endpoint succeeded",
  "[ShipFlowServiceTray] restart API succeeded",
  "[ShipFlowServiceTray] quit requested",
  "[ShipFlowServiceTray] duplicate tray launch skipped",
  "--require-repeated-launch",
  "--require-tray-actions",
  "--require-tray-single-instance",
  "--require-window-state",
  "--require-menu-actions",
  "--shipflow-service-autostart",
  "ShipFlow native runtime smoke evidence was collected from installed macOS apps.",
  "ShipFlow native runtime smoke evidence was collected from installed Windows apps.",
]) {
  if (!nativeRuntimeEvidenceVerifier.includes(requiredToken)) {
    errors.push(
      `scripts/verify-native-runtime-evidence.mjs must include native runtime evidence verification token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "Native runtime evidence file window-state-source.txt must point to an installed ShipFlow runtime window-state.json path.",
  "/Library/Application Support/ShipFlow Service/",
  "/ShipFlow/Data/Service/",
  "/AppData/Roaming/ShipFlow Service/",
]) {
  if (!nativeRuntimeEvidenceVerifier.includes(requiredToken)) {
    errors.push(
      `scripts/verify-native-runtime-evidence.mjs must keep window-state source guard token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "strategy:",
  "fail-fast: false",
  "- target: desktop\n            platform: macos",
  "- target: desktop\n            platform: windows",
  "- target: service\n            platform: macos",
  "- target: service\n            platform: windows",
  "${{ matrix.target }}",
  "${{ matrix.platform }}",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_UPDATER_PUBLIC_KEY",
  "TAURI_UPDATER_ENDPOINTS",
  "APPLE_CERTIFICATE",
  "APPLE_SIGNING_IDENTITY",
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "scripts/build-updater-artifacts.mjs",
  "scripts/generate-release-evidence.mjs",
  "scripts/verify-release-evidence.mjs",
  "scripts/verify-updater-signatures.mjs",
  "Verify updater signature artifacts",
  "Generate updater evidence manifest",
  "Verify updater evidence manifest",
  "release-evidence/${{ matrix.target }}-${{ matrix.platform }}-updater.evidence.json",
  "release-evidence/desktop-${{ matrix.platform }}-updater.evidence.json",
  "release-evidence/service-${{ matrix.platform }}-updater.evidence.json",
  "scripts/macos/notarize-app.sh",
  "scripts/macos/resign-updater-artifacts-after-notarization.sh",
  "Validate macOS signing secrets",
  "Validate Windows signing secrets",
  "Verify Windows updater installer signatures",
  '$roots = @("apps/service/target/release/bundle")',
  '$roots = @("target/release/bundle")',
  "shipflow-desktop-${{ matrix.platform }}-updater-artifacts",
  "shipflow-service-${{ matrix.platform }}-updater-artifacts",
  "Notarize macOS updater artifacts",
  "Re-sign macOS updater artifacts after notarization",
  "apps/service/target/release/bundle/macos",
  "ARTIFACT_ROOT=\"apps/service/target/release/bundle\"",
  "find \"$ARTIFACT_ROOT\" -name '*.dmg'",
  "DMG_PATH",
  "\"$PRODUCT_NAME DMG\"",
  "signtool.exe",
  "windows-latest",
  "macos-latest",
]) {
  if (!updaterWorkflow.includes(requiredToken)) {
    errors.push(
      `.github/workflows/build-updater-artifacts.yml must include ${requiredToken}.`
    );
  }
}

for (const forbiddenToken of ["inputs.target", "inputs.platform"]) {
  if (updaterWorkflow.includes(forbiddenToken)) {
    errors.push(
      `.github/workflows/build-updater-artifacts.yml must build all updater target/platform combinations through the matrix, not ${forbiddenToken}.`
    );
  }
}

requireTokenOrder(
  updaterWorkflow,
  "Notarize macOS updater artifacts",
  "Re-sign macOS updater artifacts after notarization",
  ".github/workflows/build-updater-artifacts.yml must notarize and staple macOS updater artifacts before regenerating updater signatures."
);
requireTokenOrder(
  updaterWorkflow,
  "Re-sign macOS updater artifacts after notarization",
  "Verify updater signature artifacts",
  ".github/workflows/build-updater-artifacts.yml must verify updater signatures after macOS notarization re-signs the final artifacts."
);

for (const forbiddenToken of ["Sign Windows updater installer artifacts"]) {
  if (updaterWorkflow.includes(forbiddenToken)) {
    errors.push(
      `.github/workflows/build-updater-artifacts.yml must not post-sign Windows updater artifacts after Tauri creates updater .sig files.`
    );
  }
}

for (const forbiddenToken of ["updaterBundleRoots", "$roots +="]) {
  if (updaterSignatureVerifier.includes(forbiddenToken) || updaterWorkflow.includes(forbiddenToken)) {
    errors.push(
      "Updater release verification must use target-specific bundle roots instead of merged bundle roots."
    );
  }
}

{
  const serviceUploadStart = updaterWorkflow.indexOf("- name: Upload service updater artifacts");
  const serviceUploadEnd =
    serviceUploadStart === -1
      ? -1
      : updaterWorkflow.indexOf("if-no-files-found: error", serviceUploadStart);
  const serviceUploadBlock =
    serviceUploadStart === -1 || serviceUploadEnd === -1
      ? ""
      : updaterWorkflow.slice(serviceUploadStart, serviceUploadEnd);

  if (!serviceUploadBlock.includes("apps/service/target/release/bundle/**/*.sig")) {
    errors.push(
      ".github/workflows/build-updater-artifacts.yml must upload Service updater signatures only from the Service bundle root."
    );
  }

  const uploadsRootBundleFromServiceBlock = serviceUploadBlock
    .split(/\r?\n/)
    .some((line) => line.trimStart().startsWith("target/release/bundle/"));

  if (uploadsRootBundleFromServiceBlock) {
    errors.push(
      ".github/workflows/build-updater-artifacts.yml must not upload root Desktop updater artifacts from the Service updater artifact block."
    );
  }
}

for (const requiredToken of ["native-runtime", "macos-latest", "windows-latest"]) {
  if (!qualityWorkflow.includes(requiredToken)) {
    errors.push(
      `.github/workflows/quality.yml must include the native runtime gate token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "Check release script syntax",
  "node --check scripts/build-updater-artifacts.mjs",
  "node --check scripts/create-release-build-config.mjs",
  "node --check scripts/generate-release-evidence.mjs",
  "node --check scripts/test-native-runtime-evidence-verifier.mjs",
  "node --check scripts/verify-release-evidence.mjs",
  "node --check scripts/verify-native-runtime-evidence.mjs",
  "node --check scripts/verify-updater-signatures.mjs",
  "node --check scripts/verify-security-baseline.mjs",
  "bash -n scripts/macos/notarize-app.sh",
  "bash -n scripts/macos/collect-native-runtime-evidence.sh",
  "bash -n scripts/macos/resign-updater-artifacts-after-notarization.sh",
  "Smoke check native runtime evidence verifier",
  "npm run test:native-runtime-evidence",
]) {
  if (!qualityWorkflow.includes(requiredToken)) {
    errors.push(
      `.github/workflows/quality.yml must include release script syntax gate token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "Check Windows release script syntax",
  "if: runner.os == 'Windows'",
  "shell: pwsh",
  "[System.Management.Automation.Language.Parser]::ParseFile",
  "scripts/windows/resolve-makensis.ps1",
  "scripts/windows/resolve-tauri-version.ps1",
  "scripts/windows/sign-windows-artifact.ps1",
  "scripts/windows/sign-windows-artifact-from-env.ps1",
  "scripts/windows/build-desktop-installer.ps1",
  "scripts/windows/build-service-installer.ps1",
  "scripts/windows/collect-native-runtime-evidence.ps1",
  "Windows release PowerShell syntax check failed.",
]) {
  if (!qualityWorkflow.includes(requiredToken)) {
    errors.push(
      `.github/workflows/quality.yml must include Windows release script syntax gate token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "verifyWindowsEvidence",
  "verifyMacosEvidence",
  "seedWindowsEvidence",
  "seedMacosEvidence",
  "--require-tray-actions",
  "--require-menu-actions",
  "Native runtime verifier accepted Windows evidence without Desktop tray hide action telemetry.",
  "Native runtime verifier accepted macOS evidence without Service menu quit telemetry.",
  "[ShipFlowDesktopTray] main window hidden to tray",
  "[ShipFlowDesktopMenu] command show-settings emitted to main",
  "[ShipFlowDesktopMenu] native quit requested",
  "[ShipFlowServiceMenu] open preferences succeeded",
  "[ShipFlowServiceMenu] quitting ShipFlow Service",
]) {
  if (!nativeRuntimeEvidenceVerifierSmokeScript.includes(requiredToken)) {
    errors.push(
      `scripts/test-native-runtime-evidence-verifier.mjs must include verifier smoke token ${requiredToken}.`
    );
  }
}

for (const [workflowPath, workflowSource] of [
  [".github/workflows/build-macos-app.yml", desktopMacosWorkflow],
  [".github/workflows/build-service-macos-app.yml", serviceMacosWorkflow],
]) {
  for (const requiredToken of [
    "signed_release",
    "SIGNED_RELEASE",
    "Validate macOS signing secrets",
    "Build macOS",
    "Notarize macOS",
    "Generate macOS",
    "Verify macOS",
    "scripts/generate-release-evidence.mjs",
    "scripts/verify-release-evidence.mjs",
    "scripts/create-release-build-config.mjs",
    "distribution.evidence.json",
    "RELEASE_CONFIG_PATH",
    "--config \"$RELEASE_CONFIG_PATH\"",
    "scripts/macos/notarize-app.sh",
    "--bundles app,dmg",
    "*.dmg",
    "APPLE_CERTIFICATE",
    "APPLE_SIGNING_IDENTITY",
    "TAURI_UPDATER_PUBLIC_KEY",
    "TAURI_UPDATER_ENDPOINTS",
    "updater-ready macOS",
    "APPLE_API_PRIVATE_KEY",
    "APPLE_ID",
  ]) {
    if (!workflowSource.includes(requiredToken)) {
      errors.push(`${workflowPath} must include macOS notarization token ${requiredToken}.`);
    }
  }

  for (const forbiddenToken of [
    "Build ad-hoc macOS",
    "APPLE_CERTIFICATE == ''",
    "APPLE_SIGNING_IDENTITY == ''",
  ]) {
    if (workflowSource.includes(forbiddenToken)) {
      errors.push(`${workflowPath} must not include unsigned/ad-hoc macOS release fallback ${forbiddenToken}.`);
    }
  }
}

for (const requiredToken of [
  "target/release/bundle/macos",
  "ShipFlow-Service-macos-app.zip",
  "ShipFlow Service DMG",
  "shipflow-service-macos-distribution",
]) {
  if (!serviceMacosWorkflow.includes(requiredToken)) {
    errors.push(
      `.github/workflows/build-service-macos-app.yml must use the service bundle artifact path token ${requiredToken}.`
    );
  }
}

for (const [workflowPath, workflowSource, dmgLabel, artifactName] of [
  [
    ".github/workflows/build-macos-app.yml",
    desktopMacosWorkflow,
    "ShipFlow Desktop DMG",
    "shipflow-desktop-macos-distribution",
  ],
  [
    ".github/workflows/build-service-macos-app.yml",
    serviceMacosWorkflow,
    "ShipFlow Service DMG",
    "shipflow-service-macos-distribution",
  ],
]) {
  for (const requiredToken of [dmgLabel, artifactName, "Notarize macOS", "target/release/bundle"]) {
    if (!workflowSource.includes(requiredToken)) {
      errors.push(`${workflowPath} must include signed macOS DMG installer token ${requiredToken}.`);
    }
  }
}

for (const [workflowPath, workflowSource, bundleIdentifier, bundleExecutable] of [
  [
    ".github/workflows/build-macos-app.yml",
    desktopMacosWorkflow,
    "com.shipflow.desktop",
    "shipflow3-tauri",
  ],
  [
    ".github/workflows/build-service-macos-app.yml",
    serviceMacosWorkflow,
    "com.shipflow.service",
    "shipflow-service",
  ],
]) {
  for (const requiredToken of [
    "/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier'",
    "/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable'",
    bundleIdentifier,
    bundleExecutable,
  ]) {
    if (!workflowSource.includes(requiredToken)) {
      errors.push(`${workflowPath} must verify macOS native bundle identity token ${requiredToken}.`);
    }
  }
}

for (const [workflowPath, workflowSource, buildTokens] of [
  [
    ".github/workflows/build-macos-app.yml",
    desktopMacosWorkflow,
    ["npm exec tauri -- build --bundles app,dmg --ci", "--config \"$RELEASE_CONFIG_PATH\""],
  ],
  [
    ".github/workflows/build-service-macos-app.yml",
    serviceMacosWorkflow,
    [
      "../../node_modules/.bin/tauri build --features custom-protocol --bundles app,dmg --ci",
      "CONFIG_ARGS=(--config \"$RELEASE_CONFIG_PATH\")",
    ],
  ],
]) {
  for (const buildToken of buildTokens) {
    if (!workflowSource.includes(buildToken)) {
      errors.push(`${workflowPath} must keep macOS readiness and signed-release build token ${buildToken}.`);
    }
  }
}

for (const requiredToken of [
  "xcrun notarytool submit",
  "xcrun stapler staple",
  "spctl --assess",
  "--type open",
  "context:primary-signature",
  "TEMP_ROOT_CREATED=0",
  "cleanup()",
  "rm -rf \"$ARCHIVE_DIR\"",
  "trap cleanup EXIT",
]) {
  if (!macosNotarizeScript.includes(requiredToken)) {
    errors.push(`scripts/macos/notarize-app.sh must include ${requiredToken}.`);
  }
}

for (const requiredToken of [
  "TAURI_SIGNING_PRIVATE_KEY",
  "APP_ARCHIVE_PATH=\"$APP_PATH.tar.gz\"",
  "COPYFILE_DISABLE=1 tar -czf",
  "npm exec tauri -- signer sign \"$artifact_path\"",
  "find \"$ARTIFACT_ROOT\" -name '*.dmg' -print0",
  "Updater signature is empty",
]) {
  if (!macosResignUpdaterScript.includes(requiredToken)) {
    errors.push(
      `scripts/macos/resign-updater-artifacts-after-notarization.sh must include ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "collect-native-runtime-evidence.sh",
  "com.shipflow.desktop",
  "com.shipflow.service",
  "shipflow3-tauri",
  "shipflow-service",
  "codesign --verify --deep --strict --verbose=2",
  "codesign -dv --verbose=4",
  "spctl --assess --type execute --verbose",
  "xcrun stapler validate",
  "xcrun is required to validate the stapled notarization ticket",
  "required notarization ticket validation",
  "com.shipflow.service-login.plist",
  "/usr/bin/open",
  "<string>-b</string>",
  "<string>com.shipflow.service</string>",
  "<string>--args</string>",
  "--shipflow-service-autostart",
  "--shipflow-service-tray",
  "Contents/MacOS",
  "/bin/launchctl print",
  "LAUNCH_DESKTOP_TWICE",
  "LAUNCH_SERVICE_SETTINGS_TWICE",
  "LAUNCH_SERVICE_TRAY_TWICE",
  "RUNTIME_LOG_DIR",
  "capture_runtime_log_tail",
  "capture_runtime_log_tail_if_present",
  "capture_window_state_evidence",
  "capture_launchservices_discovery",
  "POSIX path of (path to application id",
  "LaunchServices discovery matched installed app path.",
  "desktop-launchservices-discovery.txt",
  "service-launchservices-discovery.txt",
  "ShipFlow Service/shipflow-service-runtime/$WINDOW_STATE_FILE_NAME",
  "service_tray_process_lines",
  "verify_service_tray_single_instance_after_repeated_launch",
  "WINDOW_STATE_FILE_NAME",
  "desktop-runtime-log",
  "service-runtime-log",
  "service-tray-runtime-log",
  "service-tray-single-instance-processes.txt",
  "window-state-source.txt",
  "single-instance focus verification with runtime logs",
  "persisted Desktop and Service Settings window state",
  "optional macOS native menu action runtime logs",
  "optional Service tray",
  "/usr/bin/open -b \"$DESKTOP_BUNDLE_IDENTIFIER\"",
  "/usr/bin/open -b \"$SERVICE_BUNDLE_IDENTIFIER\" --args --shipflow-service-open-settings",
  "nohup \"$service_executable\" --shipflow-service-tray >/dev/null 2>&1 &",
  "desktop-single-instance-processes.txt",
  "service-settings-single-instance-processes.txt",
  "Service tray repeated launch created more than one tray process",
  "Desktop repeated launch created more than one Desktop process",
  "Service Settings repeated launch created more than one settings process",
  "process-snapshot.txt",
]) {
  if (!macosCollectNativeRuntimeEvidenceScript.includes(requiredToken)) {
    errors.push(
      `scripts/macos/collect-native-runtime-evidence.sh must include native smoke evidence token ${requiredToken}.`
    );
  }
}

for (const forbiddenToken of ["legacy_path", "temp_legacy_path"]) {
  if (macosCollectNativeRuntimeEvidenceScript.includes(forbiddenToken)) {
    errors.push(
      `scripts/macos/collect-native-runtime-evidence.sh must not accept legacy/temp window-state evidence via ${forbiddenToken}.`
    );
  }
}

if (macosCollectNativeRuntimeEvidenceScript.includes("/usr/bin/open -n -b")) {
  errors.push(
    "scripts/macos/collect-native-runtime-evidence.sh must not launch Service tray through open -n because it creates duplicate Dock-visible app instances."
  );
}

for (const [
  workflowPath,
  workflowSource,
  exePath,
  installerPath,
  verifyStepName,
  uploadStepName,
] of [
  [
    ".github/workflows/build-windows-exe.yml",
    desktopWindowsWorkflow,
    "target/release/shipflow3-tauri.exe",
    "target/release/ShipFlow-Desktop-Setup.exe",
    "Verify Windows desktop signatures",
    "Upload NSIS installer",
  ],
  [
    ".github/workflows/build-service-windows-installer.yml",
    serviceWindowsWorkflow,
    "target/release/shipflow-service.exe",
    "target/release/ShipFlow-Service-Setup.exe",
    "Verify Windows service signatures",
    "Upload Windows service installer",
  ],
]) {
  for (const requiredToken of [
    "signed_release",
    "SIGNED_RELEASE",
    "Validate Windows signing secrets",
    "Generate Windows",
    "Verify Windows",
    "scripts/create-release-build-config.mjs",
    "scripts/generate-release-evidence.mjs",
    "scripts/verify-release-evidence.mjs",
    "distribution.evidence.json",
    "TAURI_UPDATER_PUBLIC_KEY",
    "TAURI_UPDATER_ENDPOINTS",
    "updater-ready Windows",
    "$releaseConfigPath",
    "releaseConfigPath",
    "scripts/windows/sign-windows-artifact.ps1",
    "signtool.exe",
    "verify /pa /v",
    verifyStepName,
    exePath,
    installerPath,
    "WINDOWS_CERTIFICATE",
    "WINDOWS_CERTIFICATE_PASSWORD",
  ]) {
    if (!workflowSource.includes(requiredToken)) {
      errors.push(`${workflowPath} must include Windows signing token ${requiredToken}.`);
    }
  }

  const uploadStart = workflowSource.indexOf(`- name: ${uploadStepName}`);
  const uploadEnd =
    uploadStart === -1 ? -1 : workflowSource.indexOf("if-no-files-found: error", uploadStart);
  const uploadBlock =
    uploadStart === -1 || uploadEnd === -1 ? "" : workflowSource.slice(uploadStart, uploadEnd);
  if (!uploadBlock.includes(exePath)) {
    errors.push(`${workflowPath} must upload signed Windows executable artifact ${exePath}.`);
  }
  if (!uploadBlock.includes(installerPath)) {
    errors.push(`${workflowPath} must upload signed Windows installer artifact ${installerPath}.`);
  }

  for (const forbiddenToken of [
    "if: ${{ env.WINDOWS_CERTIFICATE != ''",
    "if: ${{ env.WINDOWS_CERTIFICATE_PASSWORD != ''",
  ]) {
    if (workflowSource.includes(forbiddenToken)) {
      errors.push(`${workflowPath} must not make Windows release signing optional via ${forbiddenToken}.`);
    }
  }

  if (workflowSource.indexOf(exePath) > workflowSource.indexOf(installerPath)) {
    errors.push(`${workflowPath} must sign the Windows executable before the installer.`);
  }
}

for (const [workflowPath, workflowSource, missingExecutableMessage] of [
  [
    ".github/workflows/build-windows-exe.yml",
    desktopWindowsWorkflow,
    "Missing desktop executable",
  ],
  [
    ".github/workflows/build-service-windows-installer.yml",
    serviceWindowsWorkflow,
    "Missing service executable",
  ],
]) {
  if (!workflowSource.includes(missingExecutableMessage)) {
    errors.push(`${workflowPath} must smoke check the native Windows executable with ${missingExecutableMessage}.`);
  }
}

for (const requiredToken of [
  "function Resolve-Makensis",
  "Get-Command makensis",
  "NSIS\\Bin\\makensis.exe",
  "NSIS\\makensis.exe",
  "ChocolateyInstall",
  "C:\\ProgramData\\chocolatey\\bin\\makensis.exe",
  "Test-Path $candidate",
  "Resolve-Path $candidate",
  "NSIS makensis.exe was not found. Install NSIS before building the Windows installer.",
]) {
  if (!windowsResolveMakensisScript.includes(requiredToken)) {
    errors.push(`scripts/windows/resolve-makensis.ps1 must include ${requiredToken}.`);
  }
}

for (const requiredToken of [
  "signtool.exe",
  "/fd SHA256",
  "/tr \"http://timestamp.digicert.com\"",
  "verify /pa /v",
  "$env:RUNNER_TEMP",
  "[System.IO.Path]::GetTempPath()",
]) {
  if (!windowsSignScript.includes(requiredToken)) {
    errors.push(`scripts/windows/sign-windows-artifact.ps1 must include ${requiredToken}.`);
  }
}

for (const requiredToken of [
  "WINDOWS_CERTIFICATE",
  "WINDOWS_CERTIFICATE_PASSWORD",
  "sign-windows-artifact.ps1",
]) {
  if (!windowsSignFromEnvScript.includes(requiredToken)) {
    errors.push(`scripts/windows/sign-windows-artifact-from-env.ps1 must include ${requiredToken}.`);
  }
}

for (const requiredToken of [
  "collect-native-runtime-evidence.ps1",
  "HKLM:\\Software\\ShipFlow\\Desktop",
  "HKLM:\\Software\\ShipFlow\\Service",
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  "ShipFlowService",
  "--shipflow-service-autostart",
  "signtool.exe",
  "@(\"verify\", \"/pa\", \"/v\", $Path)",
  "function Invoke-NativeCapture",
  "$LASTEXITCODE -ne 0",
  "function Normalize-WindowsEvidencePath",
  "function Assert-RegistryExecutableDiscovery",
  "Windows registry discovery matched collector executable path.",
  "desktop-executable-discovery.txt",
  "service-executable-discovery.txt",
  "Expected executable name: $ExpectedExecutableName",
  "shipflow3-tauri.exe",
  "shipflow-service.exe",
  "DesktopInstallerPath is required to collect signed Desktop installer evidence.",
  "ServiceInstallerPath is required to collect signed Service installer evidence.",
  "Desktop installer artifact: $DesktopInstallerPath",
  "Service installer artifact: $ServiceInstallerPath",
  "signed installer verification",
  "function Assert-RegistryValueAbsent",
  "ShipFlowServiceTray",
  "legacy tray autostart removal",
  "Get-CimInstance Win32_Process",
  "function Assert-DesktopSingleInstance",
  "function Assert-ServiceSettingsSingleInstance",
  "function Assert-ServiceTraySingleInstance",
  "function Get-ServiceTrayProcesses",
  "function Get-ServiceStateDir",
  "function Write-WindowStateEvidence",
  "function Get-RuntimeLogDir",
  "function Write-RuntimeLogTail",
  "function Write-RuntimeLogTailIfPresent",
  "Get-ServiceSettingsProcesses",
  "desktop-single-instance-processes.txt",
  "service-settings-single-instance-processes.txt",
  "service-tray-single-instance-processes.txt",
  "window-state-source.txt",
  "desktop-runtime-log",
  "service-runtime-log",
  "service-tray-runtime-log",
  "single-instance focus verification with runtime logs",
  "persisted Desktop and Service Settings window state",
  "optional Service tray action runtime logs",
  "Desktop repeated launch created more than one Desktop process",
  "Service Settings repeated launch created more than one settings process",
  "Service tray repeated launch created more than one tray process",
  "-LaunchDesktopTwice",
  "-LaunchServiceSettingsTwice",
  "-LaunchServiceTrayTwice",
  "--shipflow-service-open-settings",
  "--shipflow-service-tray",
  "shipflow-process-snapshot",
]) {
  if (!windowsCollectNativeRuntimeEvidenceScript.includes(requiredToken)) {
    errors.push(
      `scripts/windows/collect-native-runtime-evidence.ps1 must include native smoke evidence token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "Resolve-TauriAppVersion",
  "Convert-ToWindowsVersionQuad",
  "ConvertFrom-Json",
  "version",
  "65535",
]) {
  if (!windowsResolveTauriVersionScript.includes(requiredToken)) {
    errors.push(`scripts/windows/resolve-tauri-version.ps1 must include ${requiredToken}.`);
  }
}

for (const [scriptPath, scriptSource, configPath] of [
  [
    "scripts/windows/build-desktop-installer.ps1",
    windowsBuildDesktopInstallerScript,
    "src-tauri/tauri.conf.json",
  ],
  [
    "scripts/windows/build-service-installer.ps1",
    windowsBuildServiceInstallerScript,
    "apps/service/tauri.conf.json",
  ],
]) {
  for (const requiredToken of [
    "resolve-makensis.ps1",
    "$makensis = Resolve-Makensis",
    "& $makensis",
    "resolve-tauri-version.ps1",
    "Resolve-TauriAppVersion",
    "Convert-ToWindowsVersionQuad",
    configPath,
    "/DAPP_VERSION=$appVersion",
    "/DAPP_VERSION_QUAD=$appVersionQuad",
  ]) {
    if (!scriptSource.includes(requiredToken)) {
      errors.push(`${scriptPath} must derive installer versions with ${requiredToken}.`);
    }
  }

  if (scriptSource.includes("/DAPP_VERSION=0.1.0")) {
    errors.push(`${scriptPath} must not hardcode the Windows installer app version.`);
  }
}

for (const [installerPath, installerSource] of [
  ["scripts/windows/shipflow-desktop-installer.nsi", desktopWindowsInstallerSource],
  ["scripts/windows/shipflow-service-installer.nsi", serviceWindowsInstallerSource],
]) {
  for (const requiredToken of [
    '!error "APP_VERSION is required"',
    '!error "APP_VERSION_QUAD is required"',
    "APP_VERSION_QUAD",
    'VIProductVersion "${APP_VERSION_QUAD}"',
  ]) {
    if (!installerSource.includes(requiredToken)) {
      errors.push(`${installerPath} must derive Windows file version metadata with ${requiredToken}.`);
    }
  }

  if (installerSource.includes('VIProductVersion "0.1.0.0"')) {
    errors.push(`${installerPath} must not hardcode VIProductVersion.`);
  }

  if (
    installerSource.includes('!define APP_VERSION "0.1.0"') ||
    installerSource.includes('!define APP_VERSION_QUAD "0.1.0.0"')
  ) {
    errors.push(`${installerPath} must not define fallback hardcoded installer versions.`);
  }
}

for (const requiredToken of [
  "SHIPFLOW_KILL_PROCESS",
  "SHIPFLOW_CLOSE_DESKTOP_PROCESSES",
  "NSIS_HOOK_PREINSTALL",
  "NSIS_HOOK_PREUNINSTALL",
  "taskkill.exe",
  "shipflow3-tauri.exe",
  "ShipFlow Desktop.exe",
]) {
  if (!desktopWindowsInstallerHooksSource.includes(requiredToken)) {
    errors.push(`scripts/windows/desktop-installer-hooks.nsh must keep Windows Desktop installer hook token ${requiredToken}.`);
  }
}

for (const requiredToken of [
  "SHIPFLOW_KILL_PROCESS",
  "SHIPFLOW_CLOSE_SERVICE_PROCESSES",
  "NSIS_HOOK_PREINSTALL",
  "NSIS_HOOK_PREUNINSTALL",
  "SHIPFLOW_SERVICE_AUTOSTART_VALUE",
  "SHIPFLOW_SERVICE_LEGACY_AUTOSTART_VALUE",
  "SHIPFLOW_REMOVE_SERVICE_AUTOSTART_VALUES",
  "DeleteRegValue HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Run\" \"${SHIPFLOW_SERVICE_AUTOSTART_VALUE}\"",
  "DeleteRegValue HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Run\" \"${SHIPFLOW_SERVICE_LEGACY_AUTOSTART_VALUE}\"",
  "!insertmacro SHIPFLOW_REMOVE_SERVICE_AUTOSTART_VALUES",
  "taskkill.exe",
  "shipflow-service.exe",
  "ShipFlow Service.exe",
]) {
  if (!serviceWindowsInstallerHooksSource.includes(requiredToken)) {
    errors.push(`scripts/windows/service-installer-hooks.nsh must keep Windows Service installer hook token ${requiredToken}.`);
  }
}

requireTokenBetween(
  serviceWindowsInstallerHooksSource,
  "!macro NSIS_HOOK_PREUNINSTALL",
  "!macroend",
  "!insertmacro SHIPFLOW_REMOVE_SERVICE_AUTOSTART_VALUES",
  "scripts/windows/service-installer-hooks.nsh must remove explicit Service autostart values during pre-uninstall."
);

for (const requiredToken of [
  "Library/LaunchAgents",
  "/bin/launchctl",
  "macos_launchctl_bootstrap_args",
  "macos_launchctl_bootout_args",
  "macos_launchctl_kickstart_args",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  "ShipFlowService",
  "ShipFlowServiceTray",
  "SERVICE_AUTOSTART_FLAG",
  "sync_service_login_autostart",
  "should_enable_service_login_autostart",
  "stop_service_settings_process",
  "/usr/bin/open",
  "com.shipflow.desktop",
  "com.shipflow.service",
  "launch_macos_bundle_app",
  "launch_macos_desktop_bundle_app",
  "launch_macos_service_settings_bundle_app",
  "--args",
  "process_group(0)",
  "SERVICE_OPEN_SETTINGS_FLAG",
  "focus_existing_desktop_process",
  "macos_sibling_app_dir",
  "ShipFlow Desktop.app",
  "ShipFlow Service.app",
  "windows_registry_executable_path",
  "windows_registry_query_args(&key, value_name, registry_view)",
  "Some(\"/reg:64\")",
  "Some(\"/reg:32\")",
  "windows_registry_install_dir",
  "windows_registry_app_value",
  "macos_service_login_launch_agent_plist",
  "SERVICE_TRAY_UI_MUTEX_NAME",
  "claim_service_tray_ui_single_instance",
  "claim_current_service_tray_process",
  "claim_service_tray_launch_lock",
  "clear_service_tray_launch_lock",
  "Unable to claim API service tray launch lock after stale lock cleanup.",
  "wait_for_service_tray_process_registered",
  "wait_for_service_settings_process_registered",
  "wait_for_desktop_process_registered",
  "persist_service_settings_pid(child.id())?",
  "persist_desktop_pid(child.id())?",
  "macOS settings LaunchServices launch did not open settings UI; falling back to executable launch",
  "macOS settings LaunchServices activation accepted but settings process did not register before timeout",
  "macOS Desktop LaunchServices launch did not open Desktop UI; falling back to executable launch",
  "macOS Desktop LaunchServices activation accepted but desktop process did not register before timeout",
  "ShipFlow Service settings launched but did not register a settings process before timeout.",
  "ShipFlow Desktop launched but did not register a desktop process before timeout.",
  "<string>/usr/bin/open</string>",
  "<string>-b</string>",
  "<string>com.shipflow.service</string>",
  "<string>--shipflow-service-autostart</string>",
]) {
  if (!serviceProcessRuntime.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service/process_runtime.rs must include explicit autostart token ${requiredToken}.`
    );
  }
}

if (serviceProcessRuntime.includes("macos_bundle_open_args_with_options")) {
  errors.push(
    "crates/shipflow-tauri-runtime/src/service/process_runtime.rs must not keep force-new macOS LaunchServices helpers."
  );
}

if (serviceProcessRuntime.includes("open -n") || serviceProcessRuntime.includes("args.push(\"-n\"")) {
  errors.push(
    "crates/shipflow-tauri-runtime/src/service/process_runtime.rs must not launch Service tray with open -n because it creates duplicate Dock-visible Service apps."
  );
}

for (const requiredToken of [
  "ActivationPolicy::Accessory",
  "set_dock_visibility(false)",
  "set_activate_ignoring_other_apps(false)",
  "with_title(\"SF\")",
]) {
  if (!serviceTrayRuntime.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service/tray_runtime.rs must keep macOS hidden menu-bar helper token ${requiredToken}.`
    );
  }
}

requireTokenBetween(
  serviceProcessRuntime,
  "fn launch_macos_service_settings_bundle_app() -> Result<(), String>",
  "#[cfg(target_os = \"macos\")]\nfn launch_macos_bundle_app",
  "macos_bundle_open_args(",
  "macOS Service settings launch must use regular LaunchServices activation."
);
requireTokenBetween(
  serviceProcessRuntime,
  "fn launch_macos_service_settings_bundle_app() -> Result<(), String>",
  "#[cfg(target_os = \"macos\")]\nfn launch_macos_bundle_app",
  "macOS Service settings LaunchServices activation did not register a settings process.",
  "macOS Service settings LaunchServices launch must fall back when no settings process registers."
);
{
  const startToken = "fn launch_macos_service_settings_bundle_app() -> Result<(), String>";
  const endToken = "#[cfg(target_os = \"macos\")]\nfn launch_macos_bundle_app";
  const startIndex = serviceProcessRuntime.indexOf(startToken);
  const endIndex =
    startIndex === -1
      ? -1
      : serviceProcessRuntime.indexOf(endToken, startIndex + startToken.length);
  const scopedSource =
    startIndex === -1 || endIndex === -1
      ? ""
      : serviceProcessRuntime.slice(startIndex, endIndex);
  if (scopedSource.includes("macos_bundle_open_args_with_options")) {
    errors.push(
      "macOS Service settings launch must not pass open -n because Open Service must be idempotent."
    );
  }
}

requireTokenBetween(
  serviceProcessRuntime,
  "fn launch_shipflow_desktop() -> Result<(), String>",
  "#[cfg(target_os = \"macos\")]\nfn launch_macos_desktop_bundle_app",
  "launch_macos_desktop_bundle_app()",
  "macOS Desktop launch must use the verified LaunchServices helper before falling back to executable launch."
);
requireTokenBetween(
  serviceProcessRuntime,
  "fn launch_macos_desktop_bundle_app() -> Result<(), String>",
  "#[cfg(target_os = \"windows\")]\nfn service_login_autostart_command",
  "wait_for_desktop_process_registered(Duration::from_secs(3))",
  "macOS Desktop LaunchServices launch must wait for the Desktop process to register."
);
requireTokenBetween(
  serviceProcessRuntime,
  "fn launch_macos_desktop_bundle_app() -> Result<(), String>",
  "#[cfg(target_os = \"windows\")]\nfn service_login_autostart_command",
  "macOS Desktop LaunchServices activation did not register a desktop process.",
  "macOS Desktop LaunchServices launch must fall back when no Desktop process registers."
);

requireTokenBetween(
  serviceProcessRuntime,
  "fn macos_service_login_launch_agent_plist() -> String",
  "#[cfg(target_os = \"macos\")]",
  "<string>/usr/bin/open</string>",
  "macOS Service login LaunchAgent must launch through LaunchServices."
);
requireTokenBetween(
  serviceProcessRuntime,
  "fn macos_service_login_launch_agent_plist() -> String",
  "#[cfg(target_os = \"macos\")]",
  "<string>-b</string>",
  "macOS Service login LaunchAgent must activate the installed Service bundle by id."
);
requireTokenBetween(
  serviceProcessRuntime,
  "fn macos_service_login_launch_agent_plist() -> String",
  "#[cfg(target_os = \"macos\")]",
  "xml_escape(SERVICE_BUNDLE_IDENTIFIER)",
  "macOS Service login LaunchAgent must target the stable Service bundle id through the shared constant."
);
requireTokenBetween(
  serviceProcessRuntime,
  "fn macos_service_login_launch_agent_plist() -> String",
  "#[cfg(target_os = \"macos\")]",
  "<string>--args</string>",
  "macOS Service login LaunchAgent must pass app arguments after --args."
);
{
  const startToken = "fn macos_service_login_launch_agent_plist() -> String";
  const startIndex = serviceProcessRuntime.indexOf(startToken);
  const endIndex =
    startIndex === -1
      ? -1
      : serviceProcessRuntime.indexOf("#[cfg(target_os = \"macos\")]", startIndex + startToken.length);
  if (
    startIndex !== -1 &&
    endIndex !== -1 &&
    serviceProcessRuntime.slice(startIndex, endIndex).includes("<string>-n</string>")
  ) {
    errors.push(
      "macOS Service login LaunchAgent must not pass open -n because login autostart must be idempotent."
    );
  }
  if (
    startIndex !== -1 &&
    endIndex !== -1 &&
    serviceProcessRuntime.slice(startIndex, endIndex).includes("<string>--shipflow-service-tray</string>")
  ) {
    errors.push(
      "macOS Service login LaunchAgent must not use the legacy tray autostart mode."
    );
  }
  if (
    startIndex !== -1 &&
    endIndex !== -1 &&
    serviceProcessRuntime.slice(startIndex, endIndex).includes("Contents/MacOS")
  ) {
    errors.push(
      "macOS Service login LaunchAgent must not launch a bundle executable path directly."
    );
  }
}

for (const [requiredToken, description] of [
  [
    `#[cfg(target_os = "windows")]
    {
        candidates.extend(installed_service_companion_candidates(current_executable));
        candidates.push(parent_dir.join(format!("{SERVICE_COMPANION_BINARY_BASENAME}.exe")));
    }`,
    "Service companion discovery must prefer installed Windows paths before same-directory fallbacks.",
  ],
  [
    `#[cfg(target_os = "windows")]
    {
        candidates.extend(installed_desktop_companion_candidates(current_executable));
        candidates.push(parent_dir.join(format!("{DESKTOP_BINARY_BASENAME}.exe")));
        candidates.push(parent_dir.join(format!("{DESKTOP_PRODUCT_BASENAME}.exe")));
    }`,
    "Desktop companion discovery must prefer installed Windows paths before same-directory fallbacks.",
  ],
]) {
  if (!serviceProcessRuntime.includes(requiredToken)) {
    errors.push(description);
  }
}

requireTokenOrder(
  serviceProcessRuntime,
  "focus_existing_service_settings_process()?",
  "match launch_macos_service_settings_bundle_app()",
  "crates/shipflow-tauri-runtime/src/service/process_runtime.rs must focus an existing Service Settings process before falling back to a dedicated macOS settings launch."
);

requireTokenOrder(
  serviceProcessRuntime,
  "focus_existing_desktop_process()?",
  "match launch_macos_desktop_bundle_app()",
  "crates/shipflow-tauri-runtime/src/service/process_runtime.rs must focus an existing Desktop process before falling back to verified macOS bundle launch."
);

for (const [installerPath, installerSource, appRegistryKey, executableName] of [
  [
    "scripts/windows/shipflow-desktop-installer.nsi",
    desktopWindowsInstallerSource,
    "${SHIPFLOW_DESKTOP_REG_KEY}",
    "shipflow3-tauri.exe",
  ],
  [
    "scripts/windows/shipflow-service-installer.nsi",
    serviceWindowsInstallerSource,
    "${SHIPFLOW_SERVICE_REG_KEY}",
    "shipflow-service.exe",
  ],
]) {
  for (const requiredToken of [
    "InstallLocation",
    "ExecutablePath",
    appRegistryKey,
    executableName,
    "SetRegView 64",
  ]) {
    if (!installerSource.includes(requiredToken)) {
      errors.push(`${installerPath} must preserve stable app discovery token ${requiredToken}.`);
    }
  }
}

for (const requiredToken of [
  "SHIPFLOW_SERVICE_AUTOSTART_VALUE",
  "SHIPFLOW_SERVICE_LEGACY_AUTOSTART_VALUE",
  "SHIPFLOW_KILL_PROCESS",
  "SHIPFLOW_CLOSE_SERVICE_PROCESSES",
  'SHIPFLOW_KILL_PROCESS "shipflow-service.exe"',
  'SHIPFLOW_KILL_PROCESS "ShipFlow Service.exe"',
  "DeleteRegValue HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Run\" \"${SHIPFLOW_SERVICE_AUTOSTART_VALUE}\"",
  "DeleteRegValue HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Run\" \"${SHIPFLOW_SERVICE_LEGACY_AUTOSTART_VALUE}\"",
]) {
  if (!serviceWindowsInstallerSource.includes(requiredToken)) {
    errors.push(
      `scripts/windows/shipflow-service-installer.nsi must clean up the explicit Service autostart entry token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "build_service_settings_menu",
  "handle_service_settings_menu_event",
  "SERVICE_MENU_OPEN_PREFERENCES_ID",
  "SERVICE_MENU_QUIT_ID",
  "[ShipFlowServiceMenu] open preferences succeeded",
  "[ShipFlowServiceMenu] quitting ShipFlow Service",
  "ActivationPolicy::Regular",
  "ActivationPolicy::Accessory",
  "should_hide_service_settings_window_on_close",
  "should_show_service_settings_window_for_args(args.iter().map(String::as_str))",
  "secondary background launch kept service settings hidden",
  "failed to set initial macOS app policy",
  "focus_service_settings_window_runtime",
  "request_native_window_attention",
  "UserAttentionType::Informational",
  "DESKTOP_MAIN_WINDOW_STATE_KEY",
  "DESKTOP_WORKSPACE_WINDOW_STATE_KEY",
  "SERVICE_SETTINGS_WINDOW_STATE_KEY",
  "desktop_window_state_key",
  "restore_window_state",
  "persist_window_state_for_event",
  "WindowEvent::Moved(_)",
  "WindowEvent::Resized(_)",
  "WindowEvent::CloseRequested",
  "WindowEvent::Destroyed",
]) {
  if (!appRuntimeSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/app_runtime.rs must include native Service macOS menu/lifecycle token ${requiredToken}.`
    );
  }
}

requireTokenAfter(
  appRuntimeSource,
  "pub fn desktop_setup",
  "restore_window_state(&window, DESKTOP_MAIN_WINDOW_STATE_KEY);",
  "Desktop setup must restore the persisted main window state."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn service_settings_setup",
  "restore_window_state(&service_window, SERVICE_SETTINGS_WINDOW_STATE_KEY);",
  "Service Settings setup must restore the persisted settings window state."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn service_settings_setup",
  "focus_service_settings_window_runtime(app.handle(), &service_window);",
  "Visible Service Settings startup must focus through the native focus helper."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn open_service_settings_window_runtime",
  "restore_window_state(&service_window, SERVICE_SETTINGS_WINDOW_STATE_KEY);",
  "Recreated Service Settings windows must restore persisted window state."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn open_service_settings_window_runtime",
  "focus_service_settings_window_runtime(app, &service_window);",
  "Recreated Service Settings windows must be focused through the native focus helper."
);
requireTokenAfter(
  appRuntimeSource,
  "fn focus_service_settings_window_runtime",
  "set_activation_policy(tauri::ActivationPolicy::Regular)",
  "Service Settings focus helper must restore macOS regular activation policy before showing a hidden window."
);
requireTokenAfter(
  appRuntimeSource,
  "fn focus_service_settings_window_runtime",
  "window.show()",
  "Service Settings focus helper must show the hidden settings window."
);
requireTokenAfter(
  appRuntimeSource,
  "fn focus_desktop_main_window_runtime",
  'request_native_window_attention(&window, "desktop main window");',
  "Desktop focus helper must request native OS attention after showing the main window."
);
requireTokenAfter(
  appRuntimeSource,
  "fn focus_service_settings_window_runtime",
  'request_native_window_attention(window, "service settings window");',
  "Service Settings focus helper must request native OS attention after showing the settings window."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn handle_desktop_window_event",
  "desktop_window_state_key(window.label())",
  "Desktop window events must derive a persisted window state key."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn handle_desktop_window_event",
  "persist_window_state_for_event(window, event, window_state_key);",
  "Desktop window events must persist main and workspace window state."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn handle_service_settings_window_event",
  "persist_window_state_for_event(window, event, SERVICE_SETTINGS_WINDOW_STATE_KEY);",
  "Service Settings window events must persist the settings window state."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn handle_service_settings_window_event",
  "api.prevent_close();",
  "Service Settings close requests must be intercepted when tray mode is active."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn handle_service_settings_window_event",
  "service::ensure_service_tray_companion_running()",
  "Service Settings close-to-tray must keep the tray companion available."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn handle_service_settings_window_event",
  "window.hide()",
  "Service Settings close-to-tray must hide the window instead of destroying it."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn handle_service_settings_window_event",
  "set_activation_policy(tauri::ActivationPolicy::Accessory)",
  "Service Settings close-to-tray must restore macOS accessory mode."
);
requireTokenAfter(
  appRuntimeSource,
  "SERVICE_MENU_QUIT_ID =>",
  "service::stop_service_process();",
  "Service Cmd+Q/menu quit must stop the API runtime."
);
requireTokenAfter(
  appRuntimeSource,
  "SERVICE_MENU_QUIT_ID =>",
  "service::stop_service_tray_companion();",
  "Service Cmd+Q/menu quit must stop the tray companion."
);
requireTokenAfter(
  appRuntimeSource,
  "SERVICE_MENU_QUIT_ID =>",
  "app.exit(0);",
  "Service Cmd+Q/menu quit must exit the app."
);

if (!desktopAppSource.includes("[ShipFlowDesktopMenu] native quit requested")) {
  errors.push(
    "src-tauri/src/desktop_app.rs must log Desktop native menu quit evidence."
  );
}

for (const requiredToken of [
  "build_service_settings_menu",
  "handle_service_settings_menu_event",
  "RunEvent::Reopen",
  "RunEvent::ExitRequested",
  "stop_service_process",
  "stop_service_tray_companion",
]) {
  if (!serviceSettingsSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service_settings_app.rs must include native Service app token ${requiredToken}.`
    );
  }
}

if (!serviceRuntimeSource.includes("pub fn should_show_service_settings_window_for_args")) {
  errors.push(
    "crates/shipflow-tauri-runtime/src/service.rs must expose Service settings launch argument classification for single-instance callbacks."
  );
}

for (const requiredToken of [
  "let mut has_background_flag = false;",
  "SERVICE_AUTOSTART_FLAG | SERVICE_TRAY_FLAG | SERVICE_PROCESS_FLAG =>",
  "has_open_settings_flag || !has_background_flag",
  "std::iter::empty::<&str>()",
  "service_settings_explicit_open_wins_over_background_launch_flags",
]) {
  if (!serviceRuntimeSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service.rs must keep Service settings launch classification token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "RunEvent::ExitRequested { api, .. }",
  "prepare_desktop_native_quit",
  "first_dirty_window",
  "has_allowance",
  "api.prevent_exit();",
  "shipflow://window-close-requested",
  "clear_current_desktop_process",
  "RunEvent::Reopen",
  "focus_desktop_main_window_runtime(app)",
]) {
  if (!desktopAppSource.includes(requiredToken)) {
    errors.push(
      `src-tauri/src/desktop_app.rs must include native Desktop quit token ${requiredToken}.`
    );
  }
}

if (desktopAppSource.includes("fn focus_main_window(")) {
  errors.push(
    "src-tauri/src/desktop_app.rs must not keep a second macOS Dock reopen focus implementation."
  );
}

for (const requiredToken of [
  "build_desktop_windows_tray",
  "handle_desktop_windows_tray_menu_event",
  "DesktopTrayAvailabilityState",
  "DESKTOP_TRAY_ID",
  "Open ShipFlow Desktop",
  "Quit ShipFlow Desktop",
  "focus_desktop_main_window_runtime",
  "show_menu_on_left_click(false)",
  "TrayIconEvent::DoubleClick",
  "MouseButtonState::Up",
  "app.default_window_icon",
  "tray_builder.build(app)?",
  "mark_available",
  "mark_unavailable",
  "[ShipFlowDesktopTray] Windows tray ready",
  "[ShipFlowDesktopTray] main window hidden to tray",
  "[ShipFlowDesktopTray] open desktop requested",
  "[ShipFlowDesktopTray] quitting ShipFlow Desktop",
  "is_available",
  "should_hide_desktop_window_on_windows_close",
  "failed to unminimize main window",
  "failed to show main window",
  "failed to focus main window",
  "Windows tray unavailable; allowing main window close",
  "#[cfg(target_os = \"windows\")]",
]) {
  if (!appRuntimeSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/app_runtime.rs must include native Windows Desktop tray token ${requiredToken}.`
    );
  }
}

if (!desktopAppSource.includes("DesktopTrayAvailabilityState::default()")) {
  errors.push(
    "src-tauri/src/desktop_app.rs must manage DesktopTrayAvailabilityState before Desktop window events are handled."
  );
}

requireTokenAfter(
  appRuntimeSource,
  "pub fn desktop_setup",
  "desktop_tray_availability.mark_available()",
  "Desktop setup must mark Windows tray availability after successful tray creation."
);
requireTokenAfter(
  appRuntimeSource,
  "pub fn desktop_setup",
  "desktop_tray_availability.mark_unavailable()",
  "Desktop setup must record unavailable Windows tray state when tray initialization fails."
);
requireTokenBetween(
  appRuntimeSource,
  "pub fn handle_desktop_window_event",
  "pub fn handle_service_settings_window_event",
  ".state::<DesktopTrayAvailabilityState>()",
  "Desktop close-to-tray must read DesktopTrayAvailabilityState before hiding the window."
);
requireTokenBetween(
  appRuntimeSource,
  "pub fn handle_desktop_window_event",
  "pub fn handle_service_settings_window_event",
  ".is_available();",
  "Desktop close-to-tray must read actual Windows tray availability before hiding the window."
);
requireTokenBetween(
  appRuntimeSource,
  "pub fn handle_desktop_window_event",
  "pub fn handle_service_settings_window_event",
  "should_hide_desktop_window_on_windows_close(desktop_tray_available)",
  "Desktop close-to-tray must be conditional on Windows tray availability."
);
requireTokenAfter(
  appRuntimeSource,
  "if should_hide_desktop_window_on_windows_close(desktop_tray_available)",
  "api.prevent_close();",
  "Desktop close-to-tray must prevent close only after Windows tray availability is confirmed."
);
requireTokenAfter(
  appRuntimeSource,
  "if should_hide_desktop_window_on_windows_close(desktop_tray_available)",
  "window.hide()",
  "Desktop close-to-tray must hide only after Windows tray availability is confirmed."
);

for (const requiredToken of [
  "failed to unminimize service settings window",
  "failed to show service settings window",
  "failed to focus service settings window",
]) {
  if (!appRuntimeSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/app_runtime.rs must include native Service focus telemetry token ${requiredToken}.`
    );
  }
}

requireTokenBetween(
  appRuntimeSource,
  "pub fn handle_desktop_window_event",
  "pub fn handle_service_settings_window_event",
  "#[cfg(target_os = \"windows\")]",
  "Desktop close-to-tray must be guarded to Windows only."
);
requireTokenBetween(
  appRuntimeSource,
  "pub fn handle_desktop_window_event",
  "pub fn handle_service_settings_window_event",
  "window.label() == \"main\"",
  "Desktop close-to-tray must target the main Desktop window only."
);
requireTokenBetween(
  appRuntimeSource,
  "pub fn handle_desktop_window_event",
  "pub fn handle_service_settings_window_event",
  "api.prevent_close();",
  "Desktop close-to-tray must prevent destroying the main window."
);
requireTokenBetween(
  appRuntimeSource,
  "pub fn handle_desktop_window_event",
  "pub fn handle_service_settings_window_event",
  "window.hide()",
  "Desktop close-to-tray must hide the main window behind the tray surface."
);

for (const requiredToken of [
  "stop_service_settings_process",
  "should_auto_start_enabled_api_runtime",
  "last_auto_start_attempt_key",
  "auto-started enabled API runtime",
  "can_copy_service_endpoint",
  "can_restart_api_service",
  "config.enabled = true;",
  "Open ShipFlow Service",
  "Open ShipFlow Desktop",
  "Copy Endpoint",
  "Restart API",
  "Quit ShipFlow Service",
  "{action} succeeded",
  "[ShipFlowServiceTray] quit requested",
  "SERVICE_TRAY_OPEN_SETTINGS_ID",
  "SERVICE_TRAY_OPEN_DESKTOP_ID",
  "SERVICE_TRAY_COPY_ENDPOINT_ID",
  "SERVICE_TRAY_RESTART_SERVICE_ID",
  "SERVICE_TRAY_QUIT_ID",
  "launch_shipflow_service_settings_companion",
  "launch_shipflow_desktop_companion",
  "clear_recorded_tray_pid",
  "ControlFlow::Exit",
]) {
  if (!serviceTrayRuntime.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service/tray_runtime.rs must keep native tray runtime token ${requiredToken}.`
    );
  }
}
for (const requiredToken of [
  "stop_service_process();",
  "stop_service_settings_process();",
  "clear_recorded_tray_pid();",
  "return true;",
]) {
  requireTokenBetween(
    serviceTrayRuntime,
    "SERVICE_TRAY_QUIT_ID => {",
    "_ => {}",
    requiredToken,
    `Service tray Quit must stop the full Service runtime before exit with token ${requiredToken}.`
  );
}

if (serviceTrayRuntime.includes("std::process::exit(0)")) {
  errors.push(
    "crates/shipflow-tauri-runtime/src/service/tray_runtime.rs must not bypass tray loop cleanup with std::process::exit(0)."
  );
}

requireTokenBetween(
  serviceTrayRuntime,
  "Event::UserEvent(ServiceTrayUserEvent::Menu(event)) =>",
  "Event::UserEvent(ServiceTrayUserEvent::Tray(event)) =>",
  "*control_flow = ControlFlow::Exit;",
  "Service tray Quit must exit through the event loop so LoopDestroyed cleanup can run."
);

for (const requiredToken of [
  "clear_current_desktop_process",
  "clear_desktop_activation_request",
  "clear_current_service_settings_process",
  "clear_service_settings_activation_request",
  "claim_service_tray_launch_lock",
  "clear_service_tray_launch_lock",
  "StateFileLockGuard",
  "impl Drop for StateFileLockGuard",
  "fs::OpenOptions::new()",
  "create_new(true)",
  "service_tray_launch_lock_path",
]) {
  if (!serviceStateStoreSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service/state_store.rs must keep native process state token ${requiredToken}.`
    );
  }
}

if (!serviceRuntimeSource.includes("SERVICE_TRAY_LAUNCH_LOCK_FILE_NAME")) {
  errors.push("crates/shipflow-tauri-runtime/src/service.rs must define the Service tray launch lock file name.");
}

requireTokenOrder(
  serviceProcessRuntime,
  "claim_service_tray_launch_lock()?",
  "spawn_service_tray_process()?",
  "Service tray launch must claim the launch lock before spawning the tray companion."
);

requireTokenAfter(
  serviceStateStoreSource,
  "pub fn clear_current_desktop_process()",
  "clear_desktop_activation_request();",
  "Desktop process cleanup must clear stale desktop activation requests."
);
requireTokenAfter(
  serviceStateStoreSource,
  "pub fn clear_current_service_settings_process()",
  "clear_service_settings_activation_request();",
  "Service Settings process cleanup must clear stale activation requests."
);
requireTokenAfter(
  serviceProcessRuntime,
  "pub fn stop_service_settings_process()",
  "clear_service_settings_activation_request();",
  "Stopping Service Settings must clear stale activation requests."
);

for (const requiredToken of [
  "pub fn persist_window_state",
  "pub fn load_window_state",
  "window_state_path",
  "SavedWindowState",
]) {
  if (!serviceStateStoreSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/service/state_store.rs must keep persisted window state token ${requiredToken}.`
    );
  }
}

for (const requiredToken of [
  "DESKTOP_WORKSPACE_WINDOW_STATE_KEY",
  "restore_workspace_window_state",
  "service::load_window_state(DESKTOP_WORKSPACE_WINDOW_STATE_KEY)",
  "MIN_RESTORED_WORKSPACE_WINDOW_WIDTH",
  "MIN_RESTORED_WORKSPACE_WINDOW_HEIGHT",
]) {
  if (!windowRuntimeSource.includes(requiredToken)) {
    errors.push(
      `crates/shipflow-tauri-runtime/src/window_runtime.rs must keep workspace window state restore token ${requiredToken}.`
    );
  }
}

requireTokenAfter(
  windowRuntimeSource,
  "pub fn create_workspace_window_runtime",
  "restore_workspace_window_state(&window);",
  "Created workspace windows must restore the persisted workspace window state."
);

for (const forbiddenToken of [
  "startAtLogin: keepRunningInTray ?",
  "current.keepRunningInTray ? startAtLogin",
  "serviceConfigPreview.keepRunningInTray",
  "fn default_start_at_login() -> bool {\n    true",
]) {
  if (
    serviceSettingsControllerSource.includes(forbiddenToken) ||
    serviceRuntimeSource.includes(forbiddenToken)
  ) {
    errors.push("Service autostart must remain explicit and independent from keep-running-in-tray defaults.");
  }
}

for (const requiredToken of [
  "previewStartAtLogin",
  "startAtLogin",
  "startAtLogin: false",
]) {
  if (!serviceSettingsControllerSource.includes(requiredToken)) {
    errors.push(
      `src/features/service/useServiceSettingsController.ts must keep explicit Start at login controller token ${requiredToken}.`
    );
  }
}

if (!serviceRuntimeSource.includes("fn default_start_at_login() -> bool {\n    false")) {
  errors.push("crates/shipflow-tauri-runtime/src/service.rs must default start_at_login to false.");
}

requireTokenAfter(
  serviceTrayStateRuntime,
  "impl Default for TrayServiceSnapshot",
  "start_at_login: false",
  "Default tray service snapshot must not enable login autostart implicitly."
);
requireTokenAfter(
  serviceTrayStateRuntime,
  "if let Err(error) = sync_service_tray_companion_for_config(&config)",
  "return Err(message);",
  "Service configure must return an error when OS tray/autostart synchronization fails."
);
if (
  !serviceTrayStateRuntime.includes(
    "if result.is_ok() && !config.uses_custom_desktop_service_connection()"
  )
) {
  errors.push(
    "Service configure must sync OS tray/autostart only after service configuration succeeds."
  );
}

for (const requiredToken of [
  "aria-label=\"Start ShipFlow Service at login\"",
  "checked={serviceConfig.startAtLogin}",
  "onPreviewStartAtLogin(event.currentTarget.checked)",
  "Start ShipFlow Service at login",
  "Menu bar / system tray tetap mengikuti pilihan di atas.",
]) {
  if (!serviceSettingsWindowSource.includes(requiredToken)) {
    errors.push(
      `src/features/service/components/ServiceSettingsWindow.tsx must keep explicit Start at login UI token ${requiredToken}.`
    );
  }
}

if (serviceSettingsWindowSource.includes("disabled={!serviceConfig.keepRunningInTray}")) {
  errors.push(
    "src/features/service/components/ServiceSettingsWindow.tsx must not disable Start at login behind keepRunningInTray."
  );
}

for (const requiredToken of [
  "Native Runtime Readiness and Release Smoke Checklist",
  "native runtime readiness before",
  "deferred until Apple Developer ID",
  "Windows GitHub Actions artifacts",
  "signed_release=true",
  "Signed and notarized `ShipFlow Desktop.app`",
  "Signed `ShipFlow-Desktop-Setup.exe`",
  "Start ShipFlow Service at login",
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  "ShipFlowService",
  "ShipFlowServiceTray",
  "legacy `ShipFlowServiceTray` Run value is absent",
  "--shipflow-service-autostart",
  "com.shipflow.service-login.plist",
  "com.shipflow.service-login",
  "Copy Endpoint",
  "Restart API",
  "Signed updater artifacts",
  "Build Updater Artifacts",
  "scripts/generate-release-evidence.mjs",
  "scripts/verify-release-evidence.mjs",
  "scripts/verify-native-runtime-evidence.mjs",
  "scripts/macos/collect-native-runtime-evidence.sh",
  "scripts/windows/collect-native-runtime-evidence.ps1",
  "-DesktopInstallerPath",
  "-ServiceInstallerPath",
  "repeated Desktop launch single-instance evidence",
  "repeated Service Settings launch single-instance evidence",
  "repeated Service tray launch single-instance evidence",
  "desktop-runtime-log.txt",
  "service-runtime-log.txt",
  "service-tray-single-instance-processes.txt",
  "window-state.json",
  "window-state-source.txt",
  "not a temporary or legacy Desktop state directory",
  "--require-menu-actions",
  "[ShipFlowDesktopMenu] command show-settings emitted",
  "[ShipFlowDesktopMenu] native quit requested",
  "[ShipFlowServiceMenu] open preferences succeeded",
  "[ShipFlowServiceMenu] quitting ShipFlow Service",
  "desktop.main",
  "service.settings",
  "duplicate tray launch skipped",
  "named mutex delegated activation to the existing UI",
  "[ShipFlowDesktopTray] Windows tray ready",
  "[ShipFlowDesktopTray] main window hidden to tray",
  "[ShipFlowDesktopTray] open desktop requested",
  "[ShipFlowDesktopTray] quitting ShipFlow Desktop",
  "open service settings succeeded",
  "open desktop succeeded",
  "copy endpoint succeeded",
  "restart API succeeded",
  "[ShipFlowServiceTray] quit requested",
  "Service tray runtime logs proving repeated tray commands succeed",
  "--require-tray-actions",
  "--require-tray-single-instance",
  "--require-window-state",
  "service-tray-runtime-log.txt",
  "shipflow-desktop-macos-distribution.evidence.json",
  "shipflow-desktop-windows-distribution.evidence.json",
  "shipflow-service-macos-distribution.evidence.json",
  "shipflow-service-windows-distribution.evidence.json",
  "Windows distribution artifacts for Desktop and Service must attach both",
  "Every signed distribution build must use the updater-ready release config",
  "desktop-macos-updater.evidence.json",
  "desktop-windows-updater.evidence.json",
  "service-macos-updater.evidence.json",
  "service-windows-updater.evidence.json",
  "updaterConfig.publicKeySha256",
  "updaterConfig.endpoints",
  "updaterEndpoints",
  "metadata publication target",
  "sha256",
  "native `verification` metadata",
  "codesignVerify",
  "spctlAssess",
  "staplerValidate",
  "signtoolVerify",
  "signatureFor",
  "shipflow-desktop-macos-updater-artifacts",
  "shipflow-desktop-windows-updater-artifacts",
  "shipflow-service-macos-updater-artifacts",
  "shipflow-service-windows-updater-artifacts",
  "HKLM\\Software\\ShipFlow\\Desktop",
  "HKLM\\Software\\ShipFlow\\Service",
  "InstallLocation",
  "ExecutablePath",
  "desktop-executable-discovery.txt",
  "service-executable-discovery.txt",
  "registry `ExecutablePath`",
  ".app.tar.gz",
  ".dmg",
  "non-empty `.sig`",
  "Windows installer updater signature",
  "single-instance focus",
  "user-visible tray/taskbar surface",
  "without starting a duplicate process",
  "explicit Windows exit action",
  "PlistBuddy",
  "CFBundleIdentifier",
  "CFBundleExecutable",
  "desktop-launchservices-discovery.txt",
  "service-launchservices-discovery.txt",
  "LaunchServices resolves",
  "xcrun stapler validate",
  "launchctl print",
]) {
  if (!nativeRuntimeSmokeChecklist.includes(requiredToken)) {
    errors.push(
      `docs/native-runtime-release-smoke-checklist.md must keep native release evidence token ${requiredToken}.`
    );
  }
}

if (nativeRuntimeSmokeChecklist.includes("/usr/bin/open -n -b")) {
  errors.push(
    "docs/native-runtime-release-smoke-checklist.md must not document macOS login autostart with open -n because it would force duplicate Service instances."
  );
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log("Security baseline passed.");
