#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Ensure cargo/rustc on PATH (rustup installs to ~/.cargo/bin)
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

echo "==> building sidecars"
./scripts/build-sidecars.sh

echo "==> tauri build"
bun x tauri build

APP="src-tauri/target/release/bundle/macos/A2AChannel.app"
if [ ! -d "$APP" ]; then
  echo "build failed: $APP missing"
  exit 1
fi

echo "==> ad-hoc codesign"
codesign --force --deep --sign - "$APP"

echo "==> installing to /Applications"
rm -rf /Applications/A2AChannel.app
cp -R "$APP" /Applications/
xattr -dr com.apple.quarantine /Applications/A2AChannel.app 2>/dev/null || true

echo "==> launching"
open /Applications/A2AChannel.app
echo "installed."
