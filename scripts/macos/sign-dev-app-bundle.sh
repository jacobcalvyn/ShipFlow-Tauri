#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping macOS dev bundle signing on non-Darwin host."
  exit 0
fi

if [[ "$#" -eq 0 ]]; then
  echo "Usage: scripts/macos/sign-dev-app-bundle.sh <app-bundle>..." >&2
  exit 1
fi

for app_path in "$@"; do
  if [[ ! -d "$app_path" ]]; then
    echo "App bundle does not exist: $app_path" >&2
    exit 1
  fi

  codesign --force --deep --sign - "$app_path"
  codesign --verify --deep --strict --verbose=2 "$app_path"
done
