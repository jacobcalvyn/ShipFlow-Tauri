import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function read(relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  if (!existsSync(absolutePath)) {
    errors.push(`Missing required file: ${relativePath}`);
    return "";
  }
  return readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
}

function requireTokens(relativePath, tokens) {
  const source = read(relativePath);
  for (const token of tokens) {
    if (!source.includes(token)) {
      errors.push(`${relativePath} must include ${token}.`);
    }
  }
}

function forbidTokens(relativePath, tokens) {
  const source = read(relativePath);
  for (const token of tokens) {
    if (source.includes(token)) {
      errors.push(`${relativePath} must not include ${token}.`);
    }
  }
}

function walk(relativeDirectory, extensions) {
  const absoluteDirectory = path.join(rootDir, relativeDirectory);
  if (!existsSync(absoluteDirectory)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(absoluteDirectory)) {
    const relativePath = path.join(relativeDirectory, entry);
    const absolutePath = path.join(rootDir, relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      if (!["node_modules", "target", "out", "release", "dist"].includes(entry)) {
        files.push(...walk(relativePath, extensions));
      }
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      files.push(relativePath);
    }
  }
  return files;
}

const packageJson = JSON.parse(read("package.json"));
if (packageJson.main !== "out/main/index.js") {
  errors.push("package.json must use the Electron main entry.");
}
for (const dependency of ["electron", "electron-vite", "electron-builder"]) {
  if (!packageJson.devDependencies?.[dependency]) {
    errors.push(`package.json must include ${dependency}.`);
  }
}
for (const dependency of ["@tauri-apps/api", "@tauri-apps/cli"]) {
  if (packageJson.dependencies?.[dependency] || packageJson.devDependencies?.[dependency]) {
    errors.push(`package.json must not include legacy dependency ${dependency}.`);
  }
}
for (const scriptName of [
  "dev",
  "build",
  "build:native",
  "package",
  "package:dir",
  "package:macos",
  "package:windows",
]) {
  if (!packageJson.scripts?.[scriptName]) {
    errors.push(`package.json must expose script ${scriptName}.`);
  }
}
for (const scriptName of ["package", "package:dir", "package:macos", "package:windows"]) {
  if (!packageJson.scripts?.[scriptName]?.includes("--publish never")) {
    errors.push(`package.json script ${scriptName} must disable implicit publishing.`);
  }
}
for (const [scriptName, script] of Object.entries(packageJson.scripts ?? {})) {
  if (/\btauri\b/i.test(String(script))) {
    errors.push(`package.json script ${scriptName} still invokes Tauri.`);
  }
}

for (const relativePath of [...walk("src", [".ts", ".tsx"]), ...walk("electron", [".ts"])]) {
  forbidTokens(relativePath, ["@tauri-apps/", "window.__TAURI__", "ipcRenderer.send("]);
}

for (const legacyPath of [
  "src-tauri",
  "crates/shipflow-tauri-runtime",
  "apps/service/capabilities",
  "apps/service/gen",
  "apps/service/tauri.conf.json",
  "apps/service/tauri.updater.conf.json",
  "apps/service/windows-app-manifest.xml",
  "docs/desktop-service-split.md",
  "docs/native-platform-architecture.md",
  "docs/native-runtime-release-smoke-checklist.md",
  "docs/refactor-audit.md",
  "docs/rust-core-engine-big-bang.md",
  "src/features/service/ServiceSettingsApp.tsx",
  "scripts/build-updater-artifacts.mjs",
  "scripts/create-release-build-config.mjs",
  "scripts/generate-release-evidence.mjs",
  "scripts/macos",
  "scripts/test-native-runtime-evidence-verifier.mjs",
  "scripts/verify-native-runtime-evidence.mjs",
  "scripts/verify-release-evidence.mjs",
  "scripts/verify-updater-signatures.mjs",
  "scripts/windows/build-desktop-installer.ps1",
  "scripts/windows/build-service-installer.ps1",
  "scripts/windows/collect-native-runtime-evidence.ps1",
  "scripts/windows/desktop-installer-hooks.nsh",
  "scripts/windows/resolve-makensis.ps1",
  "scripts/windows/resolve-tauri-version.ps1",
  "scripts/windows/service-installer-hooks.nsh",
  "scripts/windows/shipflow-desktop-installer.nsi",
  "scripts/windows/shipflow-service-installer.nsi",
  "scripts/windows/sign-windows-artifact-from-env.ps1",
  "scripts/windows/sign-windows-artifact.ps1",
]) {
  if (existsSync(path.join(rootDir, legacyPath))) {
    errors.push(`Legacy Tauri path must stay removed: ${legacyPath}.`);
  }
}

requireTokens("electron/main/index.ts", [
  "contextIsolation: true",
  "nodeIntegration: false",
  "sandbox: true",
  "webSecurity: true",
  "app.requestSingleInstanceLock()",
  "event.senderFrame !== event.sender.mainFrame",
  "COMMON_COMMANDS",
  "WORKSPACE_ONLY_COMMANDS",
  "Content-Security-Policy",
  "serviceAgent.shutdown()",
  "SHIPFLOW_USER_DATA_DIR",
  "../preload/index.cjs",
  "app.exit(0)",
  "nativeRuntimesShuttingDown",
  "workspaceHostStarts",
  "stopAllWorkspaceHosts",
  'type WindowKind = "workspace"',
  'openWorkspaceSettings("service")',
]);
forbidTokens("electron/main/index.ts", [
  "openServiceSettingsWindow",
  'createWindow("service-settings"',
]);
forbidTokens("src/backend/bridge-contract.ts", ["open_shipflow_service_app"]);
requireTokens("src/features/workspace/components/SheetTabs.tsx", [
  "IntegratedServiceSettings",
  'aria-label="Pengaturan ShipFlow"',
  "serviceSettingsOpenRequestToken",
]);
requireTokens("electron/preload/index.ts", [
  "contextBridge.exposeInMainWorld",
  "ALLOWED_COMMANDS",
  "ALLOWED_EVENTS",
]);
forbidTokens("electron/preload/index.ts", [
  "exposeInMainWorld(\"ipcRenderer\"",
  "exposeInMainWorld('ipcRenderer'",
]);
requireTokens("src/backend/bridge-contract.ts", [
  "export type ShipFlowCommand",
  "export type ShipFlowWorkspaceMethod",
  "requestWorkspace",
]);

requireTokens("electron/main/service-agent.ts", [
  "app.getPath(\"appData\")",
  "SHIPFLOW_INTERNAL_SERVICE_TOKEN",
  "SHIPFLOW_INTERNAL_IPC_ENDPOINT",
  "requestManagedService",
  '"service.shutdown"',
  "safeStorage.encryptString",
  "safeStorage.decryptString",
  "app.setLoginItemSettings",
  "SHIPFLOW_SERVICE_AGENT_STATE_DIR",
  "#isShuttingDown",
  "publicApiTokenForNativeAction",
  "authTokenConfigured",
  "probeExternalApiAuth",
]);
requireTokens("electron/main/external-api-policy.ts", [
  "isRestrictedNetworkAddress",
  "lookup:",
  "destination.address",
  "redirects are not allowed",
]);
requireTokens("electron/main/document-capabilities.ts", [
  "DocumentPathCapabilities",
  "realpathSync.native",
  "Workspace path is not authorized",
]);
requireTokens("electron/main/index.ts", [
  "authorize_workspace_document_path",
  "requireAuthorizedDocumentPath",
  "copy_public_api_token",
]);
requireTokens("electron/main/service-ipc.ts", [
  "createConnection",
  "MAX_FRAME_BYTES",
  "protocolVersion",
  "authToken",
  "\\\\\\\\.\\\\pipe\\\\shipflow-",
  "safeNonce",
  "runtimeDirectory",
]);
forbidTokens("electron/main/service-agent.ts", [
  "process.kill(config.processId)",
  "desktopServiceAuthToken: config.internalToken",
  "/v1/internal/runtime/shutdown",
]);
requireTokens("crates/shipflow-service-runtime/src/http_api.rs", [
  "with_graceful_shutdown",
  "run_internal_ipc_server",
]);
forbidTokens("crates/shipflow-service-runtime/src/http_api.rs", [
  "/v1/internal/runtime/shutdown",
  "authorize_internal_state_request",
  "additional_auth_tokens",
]);
requireTokens("crates/shipflow-service-runtime/src/internal_ipc.rs", [
  '"service.status"',
  '"service.shutdown"',
  '"tracking.track"',
  '"tracking.bag"',
  '"tracking.manifest"',
  "constant_time_token_eq",
  "wait_for_peer_disconnect",
]);
requireTokens("crates/shipflow-ipc/src/lib.rs", [
  "UnixListener",
  "NamedPipeServer",
  "reject_remote_clients(true)",
  "MAX_FRAME_BYTES",
]);
requireTokens("crates/shipflow-service-client/src/lib.rs", [
  "ServiceConnectionTransport::LocalIpc",
  "connect_local_ipc",
  "new_ipc",
]);
requireTokens("electron/main/workspace-host.ts", [
  "SHIPFLOW_INTERNAL_SERVICE_TOKEN",
  "--service-ipc",
  "requestTimeoutMs",
  "clearTimeout(pending.timeout)",
  "child.stdin.write(payload",
  "Buffer.byteLength(payload)",
]);
forbidTokens("electron/main/workspace-host.ts", ["--service-url"]);
requireTokens("apps/workspace-host/src/main.rs", [
  "MAX_FRAME_BYTES + 1",
  "frame_too_large",
]);
requireTokens("crates/shipflow-workspace-engine/src/import_engine.rs", [
  "MAX_IMPORT_SOURCE_IDS",
  "MAX_IMPORT_SOURCE_ID_BYTES",
  "MAX_IMPORT_REQUEST_BYTES",
  "MAX_IMPORT_JOB_ITEMS",
]);
requireTokens("crates/shipflow-workspace-engine/src/storage.rs", [
  "RowOwnershipConflict",
  "item.attempt_count < max_attempts",
]);
requireTokens("crates/shipflow-core/src/upstream.rs", [
  "MAX_UPSTREAM_RESPONSE_BYTES",
  "read_response_text_limited",
]);
requireTokens("crates/shipflow-core/src/parser.rs", [
  "MAX_TRACKING_TABLE_ROWS",
  "to_ascii_uppercase",
  "to_ascii_lowercase",
]);
requireTokens("src/features/workspace/engine-sync.ts", [
  "WorkspaceEngineSyncCoordinator",
  "latestRequestId",
]);
requireTokens("src/features/workspace/useWorkspaceSheetViewModel.ts", [
  "workspaceDocumentGeneration",
]);
requireTokens("electron/main/pod-preview.ts", [
  "isAllowedPodHostname",
  "POD image source must use HTTPS.",
  "REQUEST_TIMEOUT_MS",
  "isForbiddenIp",
]);

const cargoToml = read("Cargo.toml");
for (const token of [
  "src-tauri",
  "shipflow-tauri-runtime",
  "tauri =",
  "tauri-build",
  "tauri-plugin",
]) {
  if (cargoToml.includes(token)) {
    errors.push(`Cargo.toml still references legacy Tauri token ${token}.`);
  }
}
for (const member of [
  "apps/service",
  "apps/workspace-host",
  "crates/shipflow-core",
  "crates/shipflow-ipc",
  "crates/shipflow-service-client",
  "crates/shipflow-service-runtime",
  "crates/shipflow-workspace-engine",
]) {
  if (!cargoToml.includes(`"${member}"`)) {
    errors.push(`Cargo.toml must keep workspace member ${member}.`);
  }
}

requireTokens("electron-builder.config.cjs", [
  "shipflow-service",
  "shipflow-workspace-host",
  "duckdb.dll",
  "assets/icons",
  "useAdHocMacSigning",
  'identity: useAdHocMacSigning ? "-" : undefined',
  "hardenedRuntime: !useAdHocMacSigning",
  "target: [\"dmg\", \"zip\"]",
  "target: [\"nsis\"]",
]);
requireTokens("scripts/verify-electron-package.mjs", [
  "shipflow-service",
  "shipflow-workspace-host",
  "duckdb.dll",
  "app.asar",
  '"--verify", "--deep", "--strict", "--verbose=2"',
  "verifyPackagedFileMatchesSource",
  "Get-AuthenticodeSignature",
  "SHIPFLOW_REQUIRE_WINDOWS_SIGNATURE",
]);
requireTokens("scripts/verify-quality-gate.mjs", [
  "actions/workflows/",
  "head_sha",
  'conclusion === "success"',
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_TOKEN",
]);

for (const workflow of [
  ".github/workflows/quality.yml",
  ".github/workflows/build-macos-app.yml",
  ".github/workflows/build-windows-exe.yml",
  ".github/workflows/build-updater-artifacts.yml",
]) {
  requireTokens(workflow, ["node-version: 24", "npm run security:baseline"]);
  forbidTokens(workflow, ["tauri", "shipflow-tauri-runtime", "ShipFlow Service.app"]);
}
requireTokens(".github/workflows/build-updater-artifacts.yml", [
  "SHIPFLOW_REQUIRE_WINDOWS_SIGNATURE",
]);
requireTokens(".github/workflows/quality.yml", [
  "npm run build",
  "npm run package:verify",
  "cargo test --workspace --all-targets",
  "cargo clippy --workspace --all-targets -- -D warnings",
  "npx playwright install-deps chromium",
  "xvfb-run --auto-servernum npm run test:e2e",
]);
requireTokens(".github/workflows/build-macos-app.yml", [
  "actions: read",
  "node scripts/verify-quality-gate.mjs",
  "Build unsigned Electron macOS suite",
  "Build signed Electron macOS suite",
  'CSC_IDENTITY_AUTO_DISCOVERY: "false"',
  'CSC_IDENTITY_AUTO_DISCOVERY: "true"',
  'SHIPFLOW_MAC_ADHOC_SIGN: "true"',
  "codesign --verify --deep --strict --verbose=2",
  "npm run package:macos",
  "npm run package:verify",
]);
forbidTokens(".github/workflows/build-macos-app.yml", [
  "npm test",
  "cargo test --workspace --all-targets",
  "secrets.APPLE_CERTIFICATE || ''",
  "secrets.APPLE_CERTIFICATE_PASSWORD || ''",
  "secrets.APPLE_ID || ''",
  "secrets.APPLE_PASSWORD || ''",
  "secrets.APPLE_TEAM_ID || ''",
]);
requireTokens(".github/workflows/build-windows-exe.yml", [
  "actions: read",
  "node scripts/verify-quality-gate.mjs",
  "Build unsigned Electron Windows suite",
  "Build signed Electron Windows suite",
  'CSC_IDENTITY_AUTO_DISCOVERY: "false"',
  'CSC_IDENTITY_AUTO_DISCOVERY: "true"',
  "npm run package:windows",
  "npm run package:verify",
  "SHIPFLOW_REQUIRE_WINDOWS_SIGNATURE",
  "target/release/duckdb.dll",
]);
forbidTokens(".github/workflows/build-windows-exe.yml", [
  "npm test",
  "cargo test --workspace --all-targets",
  "secrets.WINDOWS_CERTIFICATE || ''",
  "secrets.WINDOWS_CERTIFICATE_PASSWORD || ''",
]);

requireTokens("docs/electron-parity-program.md", [
  "Electron",
  "shipflow-service",
  "shipflow-workspace-host",
  "one installer",
]);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log("ShipFlow Electron security baseline passed.");
