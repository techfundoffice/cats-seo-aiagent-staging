#!/usr/bin/env bash
set -euo pipefail

HARNESS_DIR="${HARNESS_DIR:-/opt/browser-harness}"

if [ -d "$HARNESS_DIR" ]; then
  echo "browser-harness already cloned at $HARNESS_DIR"
  cd "$HARNESS_DIR" && git pull --ff-only 2>/dev/null || true
else
  git clone --depth 1 https://github.com/browser-use/browser-harness "$HARNESS_DIR"
fi

cd "$HARNESS_DIR"

command -v uv >/dev/null 2>&1 || {
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
}

uv tool install -e .
echo "browser-harness installed at: $(command -v browser-harness)"

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
mkdir -p "$REPO_ROOT/.claude/skills/browser-harness"
ln -sf "$HARNESS_DIR/SKILL.md" "$REPO_ROOT/.claude/skills/browser-harness/SKILL.md"
echo "Skill symlinked to $REPO_ROOT/.claude/skills/browser-harness/SKILL.md"

browser-harness --doctor 2>/dev/null || echo "browser-harness --doctor not available (may need Chrome running)"
