#!/usr/bin/env bash
#
# bootstrap-tap.sh — one-time setup for the homebrew-a2achannel tap
#
# Creates the GitHub repo, writes the initial Cask file, and commits it.
# Run this once, before the first ./scripts/release.sh.
#
# Usage:
#   ./scripts/bootstrap-tap.sh

set -euo pipefail

# ─── configure ──────────────────────────────────────────────────────────────
readonly GITHUB_USER="${GITHUB_USER:-mnw}"
readonly TAP_REPO_PATH="${TAP_REPO_PATH:-$HOME/Code/homebrew-a2achannel}"
readonly MAIN_REPO="A2AChannel"
# ─────────────────────────────────────────────────────────────────────────────

readonly TAP_REPO_NAME="homebrew-a2achannel"

if [[ -t 1 ]]; then
  C_ORANGE=$'\033[38;5;215m'; C_GREEN=$'\033[38;5;114m'
  C_RED=$'\033[38;5;203m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_ORANGE=''; C_GREEN=''; C_RED=''; C_BOLD=''; C_RESET=''
fi

step() { printf '%s▸%s %s%s%s\n' "$C_ORANGE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

command -v gh >/dev/null || die "gh CLI required — brew install gh"

if [[ "$GITHUB_USER" == "YOUR-USERNAME" ]]; then
  die "edit GITHUB_USER at the top of this script before running"
fi

# ─── create repo if missing ─────────────────────────────────────────────────
step "creating GitHub repo ${GITHUB_USER}/${TAP_REPO_NAME}"
if gh repo view "${GITHUB_USER}/${TAP_REPO_NAME}" >/dev/null 2>&1; then
  ok "repo already exists on GitHub"
else
  gh repo create "${GITHUB_USER}/${TAP_REPO_NAME}" \
    --public \
    --description "Homebrew tap for A2AChannel" \
    --disable-issues=false
  ok "repo created"
fi

# ─── clone or enter ─────────────────────────────────────────────────────────
if [[ -d "$TAP_REPO_PATH/.git" ]]; then
  step "using existing clone at $TAP_REPO_PATH"
  cd "$TAP_REPO_PATH"
else
  step "cloning to $TAP_REPO_PATH"
  mkdir -p "$(dirname "$TAP_REPO_PATH")"
  git clone "https://github.com/${GITHUB_USER}/${TAP_REPO_NAME}.git" "$TAP_REPO_PATH"
  cd "$TAP_REPO_PATH"
fi

# ─── initialise contents ────────────────────────────────────────────────────
mkdir -p Casks

if [[ ! -f Casks/a2achannel.rb ]]; then
  step "writing initial Casks/a2achannel.rb"
  cat > Casks/a2achannel.rb <<EOF
cask "a2achannel" do
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/${GITHUB_USER}/${MAIN_REPO}/releases/download/v#{version}/A2AChannel-#{version}.zip"
  name "A2AChannel"
  desc "Typed handoffs between Claude Code agents with a desktop coordination room"
  homepage "https://github.com/${GITHUB_USER}/${MAIN_REPO}"

  depends_on macos: ">= :sonoma"
  depends_on arch: :arm64

  app "A2AChannel.app"

  zap trash: [
    "~/Library/Application Support/A2AChannel",
    "~/Library/Saved Application State/com.a2achannel.app.savedState",
  ]

  caveats <<~EOS
    A2AChannel is ad-hoc signed. Homebrew strips the quarantine attribute
    automatically, so the first launch should work without a Gatekeeper
    prompt. If you ever see an "unidentified developer" dialog, run:

      xattr -dr com.apple.quarantine /Applications/A2AChannel.app
  EOS
end
EOF
  ok "wrote Casks/a2achannel.rb (placeholder version)"
else
  ok "Casks/a2achannel.rb already exists — not overwriting"
fi

if [[ ! -f README.md ]]; then
  step "writing README.md"
  cat > README.md <<EOF
# homebrew-a2achannel

Homebrew tap for [A2AChannel](https://github.com/${GITHUB_USER}/${MAIN_REPO}) — typed handoffs between Claude Code agents.

## Install

\`\`\`bash
brew tap ${GITHUB_USER}/a2achannel
brew install --cask a2achannel
\`\`\`

## Upgrade

\`\`\`bash
brew upgrade --cask a2achannel
\`\`\`

## Uninstall

\`\`\`bash
brew uninstall --cask a2achannel
brew untap ${GITHUB_USER}/a2achannel
\`\`\`
EOF
  ok "wrote README.md"
fi

if [[ ! -f LICENSE ]]; then
  step "writing LICENSE (MIT, mirrors A2AChannel)"
  YEAR="$(date +%Y)"
  cat > LICENSE <<EOF
MIT License

Copyright (c) ${YEAR} Michel Wakim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF
  ok "wrote LICENSE"
fi

# ─── commit + push ──────────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  step "committing bootstrap"
  git add .
  git commit -m "bootstrap: initial tap"
  git push origin HEAD
  ok "pushed"
else
  ok "nothing to commit"
fi

printf '\n%s━━━ tap ready ━━━%s\n' "$C_GREEN" "$C_RESET"
printf '  path:   %s\n' "$TAP_REPO_PATH"
printf '  remote: https://github.com/%s/%s\n' "$GITHUB_USER" "$TAP_REPO_NAME"
printf '\nNext: run ./scripts/release.sh <version> to cut your first release.\n'
