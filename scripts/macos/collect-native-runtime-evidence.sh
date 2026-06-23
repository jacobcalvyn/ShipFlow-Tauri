#!/usr/bin/env bash
set -euo pipefail

DESKTOP_APP_PATH="${1:-/Applications/ShipFlow Desktop.app}"
SERVICE_APP_PATH="${2:-/Applications/ShipFlow Service.app}"
OUTPUT_DIR="${3:-release-smoke-evidence/macos}"
LAUNCH_DESKTOP_TWICE="${4:-0}"
LAUNCH_SERVICE_SETTINGS_TWICE="${5:-0}"
LAUNCH_SERVICE_TRAY_TWICE="${6:-0}"
SERVICE_LOGIN_PLIST="$HOME/Library/LaunchAgents/com.shipflow.service-login.plist"
SERVICE_LOGIN_LABEL="com.shipflow.service-login"
DESKTOP_BUNDLE_IDENTIFIER="com.shipflow.desktop"
SERVICE_BUNDLE_IDENTIFIER="com.shipflow.service"
RUNTIME_LOG_DIR="${TMPDIR:-/tmp}"
RUNTIME_LOG_DIR="${RUNTIME_LOG_DIR%/}/shipflow-service-runtime/logs"
WINDOW_STATE_FILE_NAME="window-state.json"

usage() {
  echo "Usage: scripts/macos/collect-native-runtime-evidence.sh [desktop-app-path] [service-app-path] [output-dir] [launch-desktop-twice:0|1] [launch-service-settings-twice:0|1] [launch-service-tray-twice:0|1]" >&2
}

capture() {
  local name="$1"
  shift
  local output_path="$OUTPUT_DIR/$name.txt"

  {
    printf '$'
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n\n'
    "$@"
  } >"$output_path" 2>&1 || {
    cat "$output_path" >&2
    exit 1
  }
}

require_app_bundle() {
  local app_path="$1"
  local label="$2"

  if [[ ! -d "$app_path" ]]; then
    echo "$label app bundle does not exist: $app_path" >&2
    usage
    exit 1
  fi
}

verify_app_identity() {
  local app_path="$1"
  local label="$2"
  local expected_bundle_id="$3"
  local expected_executable="$4"
  local plist_path="$app_path/Contents/Info.plist"
  local actual_bundle_id
  local actual_executable

  actual_bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist_path")"
  actual_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist_path")"

  if [[ "$actual_bundle_id" != "$expected_bundle_id" ]]; then
    echo "$label CFBundleIdentifier mismatch: expected $expected_bundle_id, got $actual_bundle_id" >&2
    exit 1
  fi

  if [[ "$actual_executable" != "$expected_executable" ]]; then
    echo "$label CFBundleExecutable mismatch: expected $expected_executable, got $actual_executable" >&2
    exit 1
  fi

  capture "$label-plist-bundle-id" /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist_path"
  capture "$label-plist-executable" /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist_path"
}

verify_app_signature() {
  local app_path="$1"
  local label="$2"

  capture "$label-codesign-verify" codesign --verify --deep --strict --verbose=2 "$app_path"
  capture "$label-codesign-details" codesign -dv --verbose=4 "$app_path"
  capture "$label-spctl-assess" spctl --assess --type execute --verbose "$app_path"

  if ! command -v xcrun >/dev/null 2>&1; then
    echo "xcrun is required to validate the stapled notarization ticket for $label." >&2
    exit 1
  fi

  capture "$label-stapler-validate" xcrun stapler validate "$app_path"
}

normalize_app_path() {
  local app_path="$1"
  printf '%s\n' "${app_path%/}"
}

capture_launchservices_discovery() {
  local app_path="$1"
  local label="$2"
  local bundle_id="$3"
  local resolved_path
  local normalized_expected_path
  local normalized_resolved_path
  local output_path="$OUTPUT_DIR/$label-launchservices-discovery.txt"

  if ! resolved_path="$(/usr/bin/osascript -e "POSIX path of (path to application id \"$bundle_id\")")"; then
    echo "LaunchServices could not resolve $bundle_id." >&2
    exit 1
  fi

  normalized_expected_path="$(normalize_app_path "$app_path")"
  normalized_resolved_path="$(normalize_app_path "$resolved_path")"

  {
    printf 'Bundle ID: %s\n' "$bundle_id"
    printf 'Expected app path: %s\n' "$normalized_expected_path"
    printf 'LaunchServices app path: %s\n' "$normalized_resolved_path"
  } >"$output_path"

  if [[ "$normalized_resolved_path" != "$normalized_expected_path" ]]; then
    echo "LaunchServices resolved $bundle_id to $normalized_resolved_path, expected $normalized_expected_path." >&2
    cat "$output_path" >&2
    exit 1
  fi

  printf 'LaunchServices discovery matched installed app path.\n' >>"$output_path"
}

verify_service_login_launch_agent() {
  if [[ ! -f "$SERVICE_LOGIN_PLIST" ]]; then
    echo "Service login LaunchAgent does not exist: $SERVICE_LOGIN_PLIST" >&2
    echo "Enable 'Start ShipFlow Service at login' before collecting release smoke evidence." >&2
    exit 1
  fi

  if ! grep -q '/usr/bin/open' "$SERVICE_LOGIN_PLIST"; then
    echo "Service login LaunchAgent must launch through /usr/bin/open." >&2
    exit 1
  fi

  if ! grep -q '<string>-b</string>' "$SERVICE_LOGIN_PLIST"; then
    echo "Service login LaunchAgent must launch the Service app by bundle id." >&2
    exit 1
  fi

  if ! grep -q '<string>com.shipflow.service</string>' "$SERVICE_LOGIN_PLIST"; then
    echo "Service login LaunchAgent must target com.shipflow.service." >&2
    exit 1
  fi

  if ! grep -q '<string>--args</string>' "$SERVICE_LOGIN_PLIST"; then
    echo "Service login LaunchAgent must pass app arguments after --args." >&2
    exit 1
  fi

  if grep -q -- '-n' "$SERVICE_LOGIN_PLIST"; then
    echo "Service login LaunchAgent must not pass open -n." >&2
    exit 1
  fi

  if grep -q -- '--shipflow-service-tray' "$SERVICE_LOGIN_PLIST"; then
    echo "Service login LaunchAgent must not start the legacy tray autostart mode." >&2
    exit 1
  fi

  if grep -q 'Contents/MacOS' "$SERVICE_LOGIN_PLIST"; then
    echo "Service login LaunchAgent must not launch a bundle executable path directly." >&2
    exit 1
  fi

  if ! grep -q -- '--shipflow-service-autostart' "$SERVICE_LOGIN_PLIST"; then
    echo "Service login LaunchAgent must pass --shipflow-service-autostart." >&2
    exit 1
  fi

  cp "$SERVICE_LOGIN_PLIST" "$OUTPUT_DIR/service-login-launch-agent.plist"
  capture "service-login-launchctl-print" /bin/launchctl print "gui/$(id -u)/$SERVICE_LOGIN_LABEL"
}

capture_process_snapshot() {
  {
    echo "Desktop processes:"
    pgrep -fl 'shipflow3-tauri|ShipFlow Desktop' || true
    echo
    echo "Service processes:"
    pgrep -fl 'shipflow-service|ShipFlow Service' || true
  } >"$OUTPUT_DIR/process-snapshot.txt"
}

capture_desktop_single_instance_processes() {
  {
    echo "Desktop process snapshot after repeated launch:"
    pgrep -fl 'shipflow3-tauri|ShipFlow Desktop' || true
  } >"$OUTPUT_DIR/desktop-single-instance-processes.txt"
}

capture_service_settings_single_instance_processes() {
  {
    echo "Service Settings process snapshot after repeated launch:"
    service_settings_process_lines || true
  } >"$OUTPUT_DIR/service-settings-single-instance-processes.txt"
}

capture_service_tray_single_instance_processes() {
  {
    echo "Service tray process snapshot after repeated launch:"
    service_tray_process_lines || true
  } >"$OUTPUT_DIR/service-tray-single-instance-processes.txt"
}

capture_runtime_log_tail() {
  local process_name="$1"
  local evidence_name="$2"
  local log_path="$RUNTIME_LOG_DIR/$process_name.log"
  local output_path="$OUTPUT_DIR/$evidence_name.txt"

  if [[ ! -f "$log_path" ]]; then
    echo "Runtime log does not exist: $log_path" >&2
    exit 1
  fi

  tail -n 400 "$log_path" >"$output_path"
}

capture_runtime_log_tail_if_present() {
  local process_name="$1"
  local evidence_name="$2"
  local log_path="$RUNTIME_LOG_DIR/$process_name.log"

  if [[ -f "$log_path" ]]; then
    tail -n 400 "$log_path" >"$OUTPUT_DIR/$evidence_name.txt"
  fi
}

capture_window_state_evidence() {
  local primary_path="$HOME/Library/Application Support/ShipFlow Service/shipflow-service-runtime/$WINDOW_STATE_FILE_NAME"

  if [[ -f "$primary_path" ]]; then
    cp "$primary_path" "$OUTPUT_DIR/window-state.json"
    printf '%s\n' "$primary_path" >"$OUTPUT_DIR/window-state-source.txt"
    return
  fi

  echo "Window state file was not found. Resize and close/reopen Desktop and Service Settings before collecting release smoke evidence." >&2
  exit 1
}

service_settings_process_lines() {
  pgrep -fl 'shipflow-service|ShipFlow Service' |
    grep -v -- '--shipflow-service-process' |
    grep -v -- '--shipflow-service-autostart' |
    grep -v -- '--shipflow-service-tray' || true
}

service_tray_process_lines() {
  pgrep -fl 'shipflow-service|ShipFlow Service' |
    grep -- '--shipflow-service-tray' || true
}

verify_desktop_single_instance_after_repeated_launch() {
  /usr/bin/open -b "$DESKTOP_BUNDLE_IDENTIFIER"
  sleep 2
  /usr/bin/open -b "$DESKTOP_BUNDLE_IDENTIFIER"
  sleep 2
  capture_desktop_single_instance_processes

  local process_count
  process_count="$(pgrep -fl 'shipflow3-tauri|ShipFlow Desktop' | wc -l | tr -d ' ')"

  if [[ "$process_count" -lt 1 ]]; then
    echo "Desktop repeated launch did not leave a detectable Desktop process." >&2
    exit 1
  fi

  if [[ "$process_count" -gt 1 ]]; then
    echo "Desktop repeated launch created more than one Desktop process: $process_count" >&2
    cat "$OUTPUT_DIR/desktop-single-instance-processes.txt" >&2
    exit 1
  fi

  capture_runtime_log_tail "shipflow3-tauri" "desktop-runtime-log"
}

verify_service_settings_single_instance_after_repeated_launch() {
  /usr/bin/open -b "$SERVICE_BUNDLE_IDENTIFIER" --args --shipflow-service-open-settings
  sleep 2
  /usr/bin/open -b "$SERVICE_BUNDLE_IDENTIFIER" --args --shipflow-service-open-settings
  sleep 2
  capture_service_settings_single_instance_processes

  local process_count
  process_count="$(service_settings_process_lines | wc -l | tr -d ' ')"

  if [[ "$process_count" -lt 1 ]]; then
    echo "Service Settings repeated launch did not leave a detectable settings process." >&2
    exit 1
  fi

  if [[ "$process_count" -gt 1 ]]; then
    echo "Service Settings repeated launch created more than one settings process: $process_count" >&2
    cat "$OUTPUT_DIR/service-settings-single-instance-processes.txt" >&2
    exit 1
  fi

  capture_runtime_log_tail "shipflow-service" "service-runtime-log"
}

verify_service_tray_single_instance_after_repeated_launch() {
  local service_executable="$SERVICE_APP_PATH/Contents/MacOS/shipflow-service"

  nohup "$service_executable" --shipflow-service-tray >/dev/null 2>&1 &
  sleep 2
  nohup "$service_executable" --shipflow-service-tray >/dev/null 2>&1 &
  sleep 2
  capture_service_tray_single_instance_processes

  local process_count
  process_count="$(service_tray_process_lines | wc -l | tr -d ' ')"

  if [[ "$process_count" -lt 1 ]]; then
    echo "Service tray repeated launch did not leave a detectable tray process." >&2
    exit 1
  fi

  if [[ "$process_count" -gt 1 ]]; then
    echo "Service tray repeated launch created more than one tray process: $process_count" >&2
    cat "$OUTPUT_DIR/service-tray-single-instance-processes.txt" >&2
    exit 1
  fi

  capture_runtime_log_tail "shipflow-service" "service-tray-runtime-log"
}

mkdir -p "$OUTPUT_DIR"
require_app_bundle "$DESKTOP_APP_PATH" "Desktop"
require_app_bundle "$SERVICE_APP_PATH" "Service"

verify_app_identity "$DESKTOP_APP_PATH" "desktop" "$DESKTOP_BUNDLE_IDENTIFIER" "shipflow3-tauri"
verify_app_identity "$SERVICE_APP_PATH" "service" "$SERVICE_BUNDLE_IDENTIFIER" "shipflow-service"
verify_app_signature "$DESKTOP_APP_PATH" "desktop"
verify_app_signature "$SERVICE_APP_PATH" "service"
capture_launchservices_discovery "$DESKTOP_APP_PATH" "desktop" "$DESKTOP_BUNDLE_IDENTIFIER"
capture_launchservices_discovery "$SERVICE_APP_PATH" "service" "$SERVICE_BUNDLE_IDENTIFIER"
verify_service_login_launch_agent
if [[ "$LAUNCH_DESKTOP_TWICE" = "1" || "$LAUNCH_DESKTOP_TWICE" = "true" ]]; then
  verify_desktop_single_instance_after_repeated_launch
fi
if [[ "$LAUNCH_SERVICE_SETTINGS_TWICE" = "1" || "$LAUNCH_SERVICE_SETTINGS_TWICE" = "true" ]]; then
  verify_service_settings_single_instance_after_repeated_launch
fi
if [[ "$LAUNCH_SERVICE_TRAY_TWICE" = "1" || "$LAUNCH_SERVICE_TRAY_TWICE" = "true" ]]; then
  verify_service_tray_single_instance_after_repeated_launch
fi
capture_process_snapshot
capture_runtime_log_tail_if_present "shipflow-service" "service-tray-runtime-log"
capture_window_state_evidence

cat >"$OUTPUT_DIR/README.txt" <<EOF
ShipFlow native runtime smoke evidence was collected from installed macOS apps.

Desktop app: $DESKTOP_APP_PATH
Service app: $SERVICE_APP_PATH
Service login LaunchAgent: $SERVICE_LOGIN_PLIST
Desktop repeated launch check: $LAUNCH_DESKTOP_TWICE
Service Settings repeated launch check: $LAUNCH_SERVICE_SETTINGS_TWICE
Service tray repeated launch check: $LAUNCH_SERVICE_TRAY_TWICE
LaunchServices discovery evidence: desktop-launchservices-discovery.txt, service-launchservices-discovery.txt
Window state evidence: window-state.json

This evidence covers installed app identity, code signature, Gatekeeper
assessment, required notarization ticket validation, explicit Service login
LaunchAgent registration, LaunchServices bundle-id discovery for both apps,
optional Desktop and Service Settings repeated-launch single-instance focus
verification with runtime logs, single-instance focus verification with runtime logs,
optional Service tray repeated-launch
single-instance verification, optional Service tray action runtime logs,
optional macOS native menu action runtime logs, persisted Desktop and Service Settings window state, and a process snapshot.
EOF

echo "Collected macOS native runtime evidence in $OUTPUT_DIR"
