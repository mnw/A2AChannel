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

echo "building hub-bin..."
bun build ./hub/hub.ts \
  --compile \
  --target=bun-darwin-arm64 \
  --outfile "src-tauri/binaries/hub-bin-${TRIPLE}"

echo "building channel-bin..."
bun build ./hub/channel.ts \
  --compile \
  --target=bun-darwin-arm64 \
  --outfile "src-tauri/binaries/channel-bin-${TRIPLE}"

chmod +x src-tauri/binaries/hub-bin-"${TRIPLE}" src-tauri/binaries/channel-bin-"${TRIPLE}"

# Bun --compile leaves a stale signature from the Bun runtime that macOS
# rejects (appended JS code invalidates the original sig). Strip + re-sign ad-hoc.
for bin in src-tauri/binaries/hub-bin-"${TRIPLE}" src-tauri/binaries/channel-bin-"${TRIPLE}"; do
  codesign --remove-signature "$bin" 2>/dev/null || true
  codesign --force --sign - "$bin"
done

ls -lh src-tauri/binaries/
echo "done."
