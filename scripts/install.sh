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

# Build bundled tmux only if missing — the static build takes ~2 min and
# doesn't change across installs. `build-tmux.sh` ad-hoc signs the binary
# inline, so the nested signature survives the outer `codesign --deep` pass.
if [ ! -x "src-tauri/resources/tmux" ]; then
  echo "==> building bundled tmux (first-time setup)"
  ./scripts/build-tmux.sh
fi

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
sleep 0.5

# Tauri's cleanup handler isn't 100% reliable on SIGTERM — orphan hub
# sidecars (a2a-bin A2A_MODE=hub with parent reassigned to launchd) can
# survive the parent's death and keep binding their dynamic port, leaving
# the discovery file pointing at a live-but-wrong process on the next
# relaunch. Detect and kill them. Orphan signature: a2a-bin with PPID=1
# AND env A2A_MODE=hub. Channel-mode sidecars are spawned by claude
# (PPID != 1) so they're skipped.
for pid in $(pgrep -f "A2AChannel.app/Contents/MacOS/a2a-bin"); do
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  mode=$(ps -Eww -p "$pid" 2>/dev/null | tail -1 | tr ' ' '\n' | grep '^A2A_MODE=' | cut -d= -f2 | head -1)
  if [ "$ppid" = "1" ] && [ "$mode" = "hub" ]; then
    echo "   killing orphan hub sidecar (pid=$pid)"
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 0.3

echo "==> installing to /Applications"
rm -rf /Applications/A2AChannel.app
cp -R "$APP" /Applications/
xattr -dr com.apple.quarantine /Applications/A2AChannel.app 2>/dev/null || true

echo "==> launching"
open /Applications/A2AChannel.app
echo "installed."
