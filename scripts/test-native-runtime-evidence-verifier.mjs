import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipflow-native-evidence-"));
const evidenceDirArg = path.relative(rootDir, evidenceDir);

function writeEvidenceFile(name, value) {
  fs.writeFileSync(path.join(evidenceDir, name), `${value}\n`);
}

function verifyWindowsEvidence() {
  execFileSync(
    "node",
    [
      "scripts/verify-native-runtime-evidence.mjs",
      "windows",
      evidenceDirArg,
      "--require-repeated-launch",
      "--require-tray-actions",
      "--require-tray-single-instance",
      "--require-window-state",
    ],
    { cwd: rootDir, stdio: "pipe" }
  );
}

function verifyMacosEvidence() {
  execFileSync(
    "node",
    [
      "scripts/verify-native-runtime-evidence.mjs",
      "macos",
      evidenceDirArg,
      "--require-repeated-launch",
      "--require-menu-actions",
      "--require-window-state",
    ],
    { cwd: rootDir, stdio: "pipe" }
  );
}

function seedWindowsEvidence(desktopRuntimeLog) {
  const files = {
    "README.txt": "ShipFlow native runtime smoke evidence was collected from installed Windows apps.",
    "desktop-install-registry.txt": "InstallLocation\nExecutablePath",
    "service-install-registry.txt": "InstallLocation\nExecutablePath",
    "desktop-executable-discovery.txt":
      "Expected executable name: shipflow3-tauri.exe\nWindows registry discovery matched collector executable path.",
    "service-executable-discovery.txt":
      "Expected executable name: shipflow-service.exe\nWindows registry discovery matched collector executable path.",
    "service-login-run-registry.txt":
      "ShipFlowService shipflow-service.exe --shipflow-service-autostart",
    "service-legacy-tray-run-registry-absent.txt":
      "ShipFlowServiceTray Run value is absent.",
    "desktop-executable-signtool-verify.txt": "Successfully verified:",
    "service-executable-signtool-verify.txt": "Successfully verified:",
    "desktop-installer-signtool-verify.txt": "Successfully verified:",
    "service-installer-signtool-verify.txt": "Successfully verified:",
    "shipflow-process-snapshot.txt": "ProcessId : 1\nName : shipflow3-tauri.exe",
    "desktop-single-instance-processes.txt": "ProcessId : 10\nName : shipflow3-tauri.exe",
    "desktop-runtime-log.txt": desktopRuntimeLog,
    "service-settings-single-instance-processes.txt":
      "ProcessId : 20\nName : shipflow-service.exe\nCommandLine : shipflow-service.exe --shipflow-service-open-settings",
    "service-runtime-log.txt":
      "[ShipFlowServiceLaunch] activation request consumed by existing service settings process",
    "service-tray-single-instance-processes.txt":
      "ProcessId : 30\nName : shipflow-service.exe\nCommandLine : shipflow-service.exe --shipflow-service-tray",
    "service-tray-runtime-log.txt": [
      "[ShipFlowServiceTray] open service settings succeeded",
      "[ShipFlowServiceTray] open desktop succeeded",
      "[ShipFlowServiceTray] copy endpoint succeeded",
      "[ShipFlowServiceTray] restart API succeeded",
      "[ShipFlowServiceTray] quit requested",
      "[ShipFlowServiceTray] duplicate tray launch skipped",
    ].join("\n"),
    "window-state.json": JSON.stringify({
      version: 1,
      windows: {
        "desktop.main": { x: 1, y: 2, width: 900, height: 700, maximized: false },
        "service.settings": { x: 3, y: 4, width: 900, height: 700, maximized: true },
      },
    }),
    "window-state-source.txt":
      "C:/ShipFlow/Data/Service/shipflow-service-runtime/window-state.json",
  };

  for (const [name, value] of Object.entries(files)) {
    writeEvidenceFile(name, value);
  }
}

function seedMacosEvidence({ desktopRuntimeLog, serviceRuntimeLog }) {
  const files = {
    "README.txt": "ShipFlow native runtime smoke evidence was collected from installed macOS apps.",
    "desktop-plist-bundle-id.txt": "com.shipflow.desktop",
    "desktop-plist-executable.txt": "shipflow3-tauri",
    "service-plist-bundle-id.txt": "com.shipflow.service",
    "service-plist-executable.txt": "shipflow-service",
    "desktop-launchservices-discovery.txt":
      "Bundle ID: com.shipflow.desktop\nLaunchServices discovery matched installed app path.",
    "service-launchservices-discovery.txt":
      "Bundle ID: com.shipflow.service\nLaunchServices discovery matched installed app path.",
    "service-login-launch-agent.plist":
      "<string>com.shipflow.service-login</string>\n/usr/bin/open\n<string>-b</string>\n<string>com.shipflow.service</string>\n<string>--args</string>\n<string>--shipflow-service-autostart</string>",
    "service-login-launchctl-print.txt": "com.shipflow.service-login",
    "desktop-codesign-verify.txt": "codesign --verify --deep --strict --verbose=2",
    "desktop-codesign-details.txt": "Authority=Developer ID",
    "desktop-spctl-assess.txt": "spctl --assess --type execute --verbose\naccepted",
    "desktop-stapler-validate.txt": "xcrun stapler validate\nThe validate action worked!",
    "service-codesign-verify.txt": "codesign --verify --deep --strict --verbose=2",
    "service-codesign-details.txt": "Authority=Developer ID",
    "service-spctl-assess.txt": "spctl --assess --type execute --verbose\naccepted",
    "service-stapler-validate.txt": "xcrun stapler validate\nThe validate action worked!",
    "process-snapshot.txt": "Desktop processes:\n100 shipflow3-tauri",
    "desktop-single-instance-processes.txt":
      "Desktop process snapshot after repeated launch:\n100 shipflow3-tauri",
    "desktop-runtime-log.txt": desktopRuntimeLog,
    "service-settings-single-instance-processes.txt":
      "Service Settings process snapshot after repeated launch:\n200 shipflow-service",
    "service-runtime-log.txt": serviceRuntimeLog,
    "window-state.json": JSON.stringify({
      version: 1,
      windows: {
        "desktop.main": { x: 1, y: 2, width: 900, height: 700, maximized: false },
        "service.settings": { x: 3, y: 4, width: 900, height: 700, maximized: true },
      },
    }),
    "window-state-source.txt":
      "/Users/example/Library/Application Support/ShipFlow Service/shipflow-service-runtime/window-state.json",
  };

  for (const [name, value] of Object.entries(files)) {
    writeEvidenceFile(name, value);
  }
}

try {
  seedWindowsEvidence(
    [
      "[ShipFlowDesktopLaunch] activation request consumed by existing desktop process",
      "[ShipFlowDesktopTray] Windows tray ready",
      "[ShipFlowDesktopTray] main window hidden to tray",
      "[ShipFlowDesktopTray] open desktop requested",
      "[ShipFlowDesktopTray] quitting ShipFlow Desktop",
    ].join("\n")
  );
  verifyWindowsEvidence();

  seedWindowsEvidence(
    [
      "[ShipFlowDesktopLaunch] activation request consumed by existing desktop process",
      "[ShipFlowDesktopTray] Windows tray ready",
      "[ShipFlowDesktopTray] open desktop requested",
      "[ShipFlowDesktopTray] quitting ShipFlow Desktop",
    ].join("\n")
  );

  let rejectedMissingDesktopTrayAction = false;
  try {
    verifyWindowsEvidence();
  } catch {
    rejectedMissingDesktopTrayAction = true;
  }

  if (!rejectedMissingDesktopTrayAction) {
    throw new Error(
      "Native runtime verifier accepted Windows evidence without Desktop tray hide action telemetry."
    );
  }

  seedMacosEvidence({
    desktopRuntimeLog: [
      "[ShipFlowDesktop] secondary launch delegated to existing desktop instance",
      "[ShipFlowDesktopMenu] command show-settings emitted to main",
      "[ShipFlowDesktopMenu] native quit requested",
    ].join("\n"),
    serviceRuntimeLog: [
      "[ShipFlowService] secondary launch delegated to existing service settings instance",
      "[ShipFlowServiceMenu] open preferences succeeded",
      "[ShipFlowServiceMenu] quitting ShipFlow Service",
    ].join("\n"),
  });
  verifyMacosEvidence();

  seedMacosEvidence({
    desktopRuntimeLog: [
      "[ShipFlowDesktop] secondary launch delegated to existing desktop instance",
      "[ShipFlowDesktopMenu] command show-settings emitted to main",
      "[ShipFlowDesktopMenu] native quit requested",
    ].join("\n"),
    serviceRuntimeLog: [
      "[ShipFlowService] secondary launch delegated to existing service settings instance",
      "[ShipFlowServiceMenu] open preferences succeeded",
    ].join("\n"),
  });

  let rejectedMissingMacosMenuAction = false;
  try {
    verifyMacosEvidence();
  } catch {
    rejectedMissingMacosMenuAction = true;
  }

  if (!rejectedMissingMacosMenuAction) {
    throw new Error(
      "Native runtime verifier accepted macOS evidence without Service menu quit telemetry."
    );
  }
} finally {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
}

console.log("Native runtime evidence verifier smoke passed.");
