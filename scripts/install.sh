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

echo "==> stopping running A2AChannel (NOT channel-bin subprocesses of Claude sessions)"
# Match only the main app binary by exact name. A broader "-f A2AChannel.app"
# pattern would also match channel-bin processes spawned by Claude Code
# sessions, which would break every active MCP session and force the user
# to restart every Claude session. hub-bin dies via the Tauri cleanup
# handler when the parent a2achannel process exits.
pkill -x a2achannel 2>/dev/null || true
sleep 0.3

echo "==> installing to /Applications"
rm -rf /Applications/A2AChannel.app
cp -R "$APP" /Applications/
xattr -dr com.apple.quarantine /Applications/A2AChannel.app 2>/dev/null || true

echo "==> launching"
open /Applications/A2AChannel.app
echo "installed."
