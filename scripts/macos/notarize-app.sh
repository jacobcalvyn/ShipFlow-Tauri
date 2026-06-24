#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_PATH="${1:-}"
ARTIFACT_LABEL="${2:-ShipFlow app}"

if [[ -z "$ARTIFACT_PATH" || ! -e "$ARTIFACT_PATH" ]]; then
  echo "Usage: scripts/macos/notarize-app.sh <app-or-dmg-path> [artifact-label]" >&2
  exit 1
fi

TEMP_ROOT_CREATED=0
if [[ -n "${RUNNER_TEMP:-}" ]]; then
  TEMP_ROOT="$RUNNER_TEMP"
else
  TEMP_ROOT="$(mktemp -d)"
  TEMP_ROOT_CREATED=1
fi
ARCHIVE_DIR="$(mktemp -d "$TEMP_ROOT/shipflow-notary-XXXXXX")"
ARCHIVE_PATH="$ARCHIVE_DIR/app.zip"
SUBMISSION_PATH="$ARTIFACT_PATH"

cleanup() {
  rm -rf "$ARCHIVE_DIR"
  if [[ "$TEMP_ROOT_CREATED" = "1" ]]; then
    rm -rf "$TEMP_ROOT"
  fi
}
trap cleanup EXIT

if [[ -d "$ARTIFACT_PATH" ]]; then
  echo "Packaging $ARTIFACT_LABEL for Apple notarization..."
  ditto -c -k --sequesterRsrc --keepParent "$ARTIFACT_PATH" "$ARCHIVE_PATH"
  SUBMISSION_PATH="$ARCHIVE_PATH"
else
  echo "Submitting packaged $ARTIFACT_LABEL for Apple notarization..."
fi

if [[ -n "${APPLE_API_KEY_PATH:-}" && -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
  echo "Submitting $ARTIFACT_LABEL to Apple notary service with App Store Connect API key..."
  xcrun notarytool submit "$SUBMISSION_PATH" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY" \
    --issuer "$APPLE_API_ISSUER" \
    --wait
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  echo "Submitting $ARTIFACT_LABEL to Apple notary service with Apple ID credentials..."
  xcrun notarytool submit "$SUBMISSION_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
else
  echo "Apple notarization credentials are missing for $ARTIFACT_LABEL." >&2
  exit 1
fi

echo "Stapling notarization ticket to $ARTIFACT_LABEL..."
xcrun stapler staple "$ARTIFACT_PATH"
xcrun stapler validate "$ARTIFACT_PATH"
if [[ -d "$ARTIFACT_PATH" ]]; then
  spctl --assess --type execute --verbose "$ARTIFACT_PATH"
else
  spctl --assess --type open --context context:primary-signature --verbose "$ARTIFACT_PATH"
fi
