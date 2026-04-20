#!/usr/bin/env bash
# Build a statically-linked tmux binary for aarch64-apple-darwin and place it
# at src-tauri/resources/tmux. The binary is included in the .app bundle so
# users don't need to install tmux themselves.
#
# Pinned versions — bump these when a CVE or feature need drives an update.
#   tmux      3.5a
#   libevent  2.1.12-stable
#
# "Static" here means libevent is statically linked INTO the tmux binary.
# tmux dynamically links to:
#   - libSystem (every mac)
#   - libncurses.5.4.dylib (shipped in /usr/lib on every mac)
# Both are part of the macOS base system, so the resulting binary runs on
# any Apple Silicon mac without Homebrew / MacPorts.
#
# We deliberately skip building static ncurses: macOS's system ncurses is
# ABI-stable, tmux works with it out of the box, and the static-build path
# hits path-length and terminfo-generation issues that aren't worth fighting.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$(pwd)

VERSION_TMUX="3.5a"
VERSION_LIBEVENT="2.1.12-stable"

WORK=$(mktemp -d -t a2a-tmux-build)
trap "rm -rf $WORK" EXIT
echo "==> work dir: $WORK"
cd "$WORK"

DEPS="$WORK/deps"
mkdir -p "$DEPS"

echo "==> fetching libevent $VERSION_LIBEVENT"
curl -fsSL -o libevent.tar.gz \
  "https://github.com/libevent/libevent/releases/download/release-${VERSION_LIBEVENT}/libevent-${VERSION_LIBEVENT}.tar.gz"
tar xf libevent.tar.gz

echo "==> building libevent (static, no openssl)"
pushd "libevent-${VERSION_LIBEVENT}" >/dev/null
./configure --prefix="$DEPS" --enable-static --disable-shared \
  --disable-openssl --disable-samples --disable-debug-mode >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null
make install >/dev/null
popd >/dev/null

echo "==> fetching tmux $VERSION_TMUX"
curl -fsSL -o tmux.tar.gz \
  "https://github.com/tmux/tmux/releases/download/${VERSION_TMUX}/tmux-${VERSION_TMUX}.tar.gz"
tar xf tmux.tar.gz

echo "==> building tmux against static libevent + system ncurses"
pushd "tmux-${VERSION_TMUX}" >/dev/null
# Point configure at our static libevent; let ncurses resolve via macOS's
# system library in /usr/lib. tmux's configure checks for libevent, so
# CPPFLAGS/LDFLAGS targeting our $DEPS are enough.
export CPPFLAGS="-I$DEPS/include"
export LDFLAGS="-L$DEPS/lib"
./configure --disable-utf8proc >/dev/null
make -j"$(sysctl -n hw.ncpu)" >/dev/null
popd >/dev/null

OUT="$REPO/src-tauri/resources/tmux"
mkdir -p "$(dirname "$OUT")"
cp "tmux-${VERSION_TMUX}/tmux" "$OUT"
chmod 0755 "$OUT"

echo "==> ad-hoc codesigning bundled binary"
codesign --force --sign - "$OUT"

echo "==> verifying"
file "$OUT"
"$OUT" -V
echo
echo "done: $OUT ($(stat -f %z "$OUT") bytes)"
