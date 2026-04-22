#!/usr/bin/env bash
#
# release.sh — one-shot release pipeline for A2AChannel
#
# Usage:
#   ./scripts/release.sh 0.7.1
#   ./scripts/release.sh 0.7.1 --dry-run     # build + zip, skip publish
#   ./scripts/release.sh 0.7.1 --no-tap      # skip cask update
#   ./scripts/release.sh 0.7.1 --notes "Fixes vertical tab regression"
#
# What it does (in order):
#   1.  Validates arguments and environment (gh CLI, jq, git clean, etc.)
#   2.  Bumps version in package.json, src-tauri/tauri.conf.json, Cargo.toml
#   3.  Commits and tags (v<version>)
#   4.  Runs ./scripts/install.sh — builds A2AChannel.app
#   5.  Zips /Applications/A2AChannel.app into dist/
#   6.  Computes SHA256
#   7.  Pushes the commit + tag
#   8.  Creates GitHub release, uploads the zip
#   9.  Updates the Cask file in the homebrew-a2achannel tap
#  10.  Commits and pushes the cask bump
#
# Configure the two variables below once for your setup.

set -euo pipefail

# ─── configure these ─────────────────────────────────────────────────────────
readonly GITHUB_USER="${GITHUB_USER:-mnw}"
readonly TAP_REPO_PATH="${TAP_REPO_PATH:-$HOME/Code/homebrew-a2achannel}"
# ─────────────────────────────────────────────────────────────────────────────

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly DIST_DIR="${REPO_ROOT}/dist"
readonly APP_NAME="A2AChannel"
readonly APP_BUNDLE="/Applications/${APP_NAME}.app"
readonly CASK_NAME="a2achannel"

# ─── colours (only if stdout is a tty) ──────────────────────────────────────
if [[ -t 1 ]]; then
  readonly C_RESET=$'\033[0m'
  readonly C_BOLD=$'\033[1m'
  readonly C_DIM=$'\033[2m'
  readonly C_ORANGE=$'\033[38;5;215m'
  readonly C_GREEN=$'\033[38;5;114m'
  readonly C_RED=$'\033[38;5;203m'
  readonly C_BLUE=$'\033[38;5;110m'
else
  readonly C_RESET='' C_BOLD='' C_DIM='' C_ORANGE='' C_GREEN='' C_RED='' C_BLUE=''
fi

step() { printf '%s▸%s %s%s%s\n' "$C_ORANGE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

# ─── argument parsing ───────────────────────────────────────────────────────
VERSION=""
DRY_RUN=0
SKIP_TAP=0
NOTES=""

while (( $# > 0 )); do
  case "$1" in
    --dry-run)  DRY_RUN=1; shift ;;
    --no-tap)   SKIP_TAP=1; shift ;;
    --notes)    NOTES="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown flag: $1" ;;
    *)
      [[ -z "$VERSION" ]] || die "version already set to $VERSION, got extra arg: $1"
      VERSION="$1"; shift
      ;;
  esac
done

[[ -n "$VERSION" ]] || die "usage: $0 <version> [--dry-run] [--no-tap] [--notes TEXT]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "version must be semver (e.g. 0.7.1), got: $VERSION"

readonly VERSION DRY_RUN SKIP_TAP NOTES
readonly TAG="v${VERSION}"
readonly ZIP_NAME="${APP_NAME}-${VERSION}.zip"
readonly ZIP_PATH="${DIST_DIR}/${ZIP_NAME}"

# ─── preflight ──────────────────────────────────────────────────────────────
step "preflight"
cd "$REPO_ROOT"

command -v gh   >/dev/null || die "gh CLI not found — brew install gh"
command -v jq   >/dev/null || die "jq not found — brew install jq"
command -v bun  >/dev/null || die "bun not found — see bun.sh"

[[ -f scripts/install.sh ]] || die "scripts/install.sh not found (wrong cwd?)"

if [[ -n "$(git status --porcelain)" ]]; then
  die "working tree not clean — commit or stash first"
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists"
fi

gh auth status >/dev/null 2>&1 || die "gh not authenticated — run: gh auth login"

ok "environment looks good"
info "version:    $VERSION"
info "tag:        $TAG"
info "dry-run:    $DRY_RUN"
info "update tap: $(( ! SKIP_TAP ))"

# ─── version bumps ──────────────────────────────────────────────────────────
step "bumping version in manifests"

# package.json
jq --arg v "$VERSION" '.version = $v' package.json > package.json.tmp \
  && mv package.json.tmp package.json
ok "package.json → $VERSION"

# src-tauri/tauri.conf.json
jq --arg v "$VERSION" '.version = $v' src-tauri/tauri.conf.json > src-tauri/tauri.conf.json.tmp \
  && mv src-tauri/tauri.conf.json.tmp src-tauri/tauri.conf.json
ok "tauri.conf.json → $VERSION"

# src-tauri/Cargo.toml — only the [package] version line, not dependency versions
if [[ -f src-tauri/Cargo.toml ]]; then
  awk -v v="$VERSION" '
    /^\[package\]/ { in_pkg = 1 }
    /^\[/ && !/^\[package\]/ { in_pkg = 0 }
    in_pkg && /^version *=/ { print "version = \"" v "\""; next }
    { print }
  ' src-tauri/Cargo.toml > src-tauri/Cargo.toml.tmp \
    && mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml
  ok "Cargo.toml → $VERSION"
fi

# ─── commit version bump ────────────────────────────────────────────────────
step "committing version bump"
git add package.json src-tauri/tauri.conf.json
[[ -f src-tauri/Cargo.toml ]] && git add src-tauri/Cargo.toml
[[ -f src-tauri/Cargo.lock ]] && git add src-tauri/Cargo.lock

git commit -m "release: ${VERSION}" >/dev/null
git tag -a "$TAG" -m "A2AChannel ${VERSION}"
ok "committed + tagged $TAG"

# ─── build ──────────────────────────────────────────────────────────────────
step "building via scripts/install.sh (this takes ~60s)"
if ! ./scripts/install.sh; then
  # rollback commit + tag so next attempt isn't blocked
  git tag -d "$TAG" >/dev/null
  git reset --hard HEAD^ >/dev/null
  die "build failed — version bump rolled back"
fi
ok "build complete"

[[ -d "$APP_BUNDLE" ]] || die "$APP_BUNDLE not found after build"

# ─── package ────────────────────────────────────────────────────────────────
step "zipping $APP_BUNDLE"
mkdir -p "$DIST_DIR"
rm -f "$ZIP_PATH"

# ditto preserves macOS metadata, extended attributes, and symlinks — zip does not.
# homebrew-cask specifically expects ditto-style archives for .app bundles.
ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP_PATH"
ok "wrote $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"

# ─── hash ───────────────────────────────────────────────────────────────────
step "computing sha256"
SHA256="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
ok "sha256 = $SHA256"

if (( DRY_RUN )); then
  printf '\n%s[dry-run]%s stopping before publish. Artefact at:\n  %s\n' \
    "$C_BLUE" "$C_RESET" "$ZIP_PATH"
  printf '\nTo undo the local commit + tag:\n  git tag -d %s && git reset --hard HEAD^\n' "$TAG"
  exit 0
fi

# ─── publish ────────────────────────────────────────────────────────────────
step "pushing commit + tag"
git push origin HEAD
git push origin "$TAG"
ok "pushed to origin"

step "creating GitHub release"
RELEASE_NOTES="${NOTES:-Release ${VERSION}}"
gh release create "$TAG" "$ZIP_PATH" \
  --title "$TAG" \
  --notes "$RELEASE_NOTES"
ok "release $TAG created"

RELEASE_URL="https://github.com/${GITHUB_USER}/A2AChannel/releases/tag/${TAG}"
DOWNLOAD_URL="https://github.com/${GITHUB_USER}/A2AChannel/releases/download/${TAG}/${ZIP_NAME}"
info "release:  $RELEASE_URL"
info "download: $DOWNLOAD_URL"

# ─── update cask ────────────────────────────────────────────────────────────
if (( SKIP_TAP )); then
  printf '\n%s▸%s skipping tap update (--no-tap)\n' "$C_ORANGE" "$C_RESET"
  info "manually update: ${TAP_REPO_PATH}/Casks/${CASK_NAME}.rb"
  info "  version \"${VERSION}\""
  info "  sha256  \"${SHA256}\""
  exit 0
fi

step "updating cask in $TAP_REPO_PATH"
[[ -d "$TAP_REPO_PATH" ]] || die "tap repo not found at $TAP_REPO_PATH (set TAP_REPO_PATH env var)"

CASK_FILE="${TAP_REPO_PATH}/Casks/${CASK_NAME}.rb"
[[ -f "$CASK_FILE" ]] || die "cask file not found: $CASK_FILE"

# Update version and sha256 lines in place. Requires the cask to already have
# these two lines in canonical form (as produced by the earlier bootstrap).
sed -i.bak -E \
  -e "s/^(  version )\".*\"/\\1\"${VERSION}\"/" \
  -e "s/^(  sha256 )\".*\"/\\1\"${SHA256}\"/" \
  "$CASK_FILE"
rm -f "${CASK_FILE}.bak"

if ! grep -q "version \"${VERSION}\"" "$CASK_FILE"; then
  die "cask sed didn't take — check the file manually"
fi

ok "cask updated"
info "diff:"
( cd "$TAP_REPO_PATH" && git --no-pager diff --color=always "Casks/${CASK_NAME}.rb" | sed 's/^/    /' )

step "committing cask bump"
(
  cd "$TAP_REPO_PATH"
  git add "Casks/${CASK_NAME}.rb"
  git commit -m "${CASK_NAME} ${VERSION}" >/dev/null
  git push origin HEAD
)
ok "tap pushed"

# ─── optional smoke test ────────────────────────────────────────────────────
step "smoke-testing install"
if brew list --cask "$CASK_NAME" >/dev/null 2>&1; then
  info "already installed — running upgrade"
  if brew upgrade --cask "$CASK_NAME"; then
    ok "brew upgrade succeeded"
  else
    printf '  %s! brew upgrade failed — release is live but install is broken%s\n' "$C_RED" "$C_RESET"
  fi
else
  info "not yet tapped locally — skipping. To test:"
  info "  brew tap ${GITHUB_USER}/${CASK_NAME}"
  info "  brew install --cask ${CASK_NAME}"
fi

# ─── summary ────────────────────────────────────────────────────────────────
printf '\n%s━━━ released %s%s%s ━━━%s\n' "$C_GREEN" "$C_BOLD" "$VERSION" "$C_RESET$C_GREEN" "$C_RESET"
printf '  release:  %s\n' "$RELEASE_URL"
printf '  install:  brew install --cask %s/%s/%s\n' "$GITHUB_USER" "$CASK_NAME" "$CASK_NAME"
printf '  upgrade:  brew upgrade --cask %s\n' "$CASK_NAME"
