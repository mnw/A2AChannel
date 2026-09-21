#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

TRIPLE=$(rustc -Vv | awk '/host:/{print $2}')
echo "target triple: $TRIPLE"

mkdir -p src-tauri/binaries

# Drop any legacy per-role binaries from previous builds.
rm -f src-tauri/binaries/hub-bin-* src-tauri/binaries/channel-bin-*

echo "building unified a2a-bin..."
bun build ./hub/main.ts \
  --compile \
  --target=bun-darwin-arm64 \
  --outfile "src-tauri/binaries/a2a-bin-${TRIPLE}"

chmod +x "src-tauri/binaries/a2a-bin-${TRIPLE}"

# Bun --compile leaves a stale signature from the Bun runtime that macOS
# rejects (appended JS code invalidates the original sig). Strip + re-sign ad-hoc.
codesign --remove-signature "src-tauri/binaries/a2a-bin-${TRIPLE}" 2>/dev/null || true
codesign --force --sign - "src-tauri/binaries/a2a-bin-${TRIPLE}"

# Pi runtime adapter. Not a compiled binary: pi loads it as a JS module via
# `pi -e`, so it ships as a bundled single file under resources/. Bundling (vs
# shipping the .ts tree) means no import resolution and no TS parse at spawn.
echo "bundling pi-extension..."
mkdir -p src-tauri/resources
bun build ./hub/channel/pi-extension.ts \
  --target=node \
  --format=esm \
  --outfile src-tauri/resources/pi-extension.js

ls -lh src-tauri/binaries/ src-tauri/resources/
echo "done."
