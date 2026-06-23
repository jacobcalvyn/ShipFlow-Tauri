#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-}"

if [[ "$TARGET" != "desktop" && "$TARGET" != "service" ]]; then
  echo "Usage: scripts/macos/resign-updater-artifacts-after-notarization.sh <desktop|service>" >&2
  exit 1
fi

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY is required to sign macOS updater artifacts." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "$TARGET" = "desktop" ]]; then
  BUNDLE_ROOT="$ROOT_DIR/target/release/bundle/macos"
  ARTIFACT_ROOT="$ROOT_DIR/target/release/bundle"
else
  BUNDLE_ROOT="$ROOT_DIR/apps/service/target/release/bundle/macos"
  ARTIFACT_ROOT="$ROOT_DIR/apps/service/target/release/bundle"
fi

APP_PATH="$(find "$BUNDLE_ROOT" -maxdepth 1 -name '*.app' -print -quit)"
if [[ -z "$APP_PATH" ]]; then
  echo "No macOS app bundle found in $BUNDLE_ROOT." >&2
  exit 1
fi

APP_ARCHIVE_PATH="$APP_PATH.tar.gz"
rm -f "$APP_ARCHIVE_PATH" "$APP_ARCHIVE_PATH.sig"

echo "Repacking notarized app bundle for updater: $APP_ARCHIVE_PATH"
COPYFILE_DISABLE=1 tar -czf "$APP_ARCHIVE_PATH" -C "$(dirname "$APP_PATH")" "$(basename "$APP_PATH")"

sign_artifact() {
  local artifact_path="$1"
  local signature_path="$artifact_path.sig"
  rm -f "$signature_path"
  echo "Signing updater artifact: $artifact_path"
  (
    cd "$ROOT_DIR"
    npm exec tauri -- signer sign "$artifact_path"
  ) > "$signature_path"

  if [[ ! -s "$signature_path" ]]; then
    echo "Updater signature is empty: $signature_path" >&2
    exit 1
  fi
}

sign_artifact "$APP_ARCHIVE_PATH"

while IFS= read -r -d '' dmg_path; do
  sign_artifact "$dmg_path"
done < <(find "$ARTIFACT_ROOT" -name '*.dmg' -print0)
