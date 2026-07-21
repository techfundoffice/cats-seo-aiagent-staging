#!/usr/bin/env bash
# Idempotent: add Composio to PATH in ~/.profile so `bash -lc` / npm scripts find `composio`.
# ~/.bashrc exits early for non-interactive shells, so blocks at the end of .bashrc never run.
set -eu
if grep -q "Composio_CLI_noninteractive" ~/.profile 2>/dev/null; then
    exit 0
fi
cat >>~/.profile <<'EOF'

# Composio_CLI_noninteractive (~/.bashrc returns early for non-interactive shells)
if [ -d "$HOME/.composio" ]; then
    export PATH="$HOME/.composio:$PATH"
fi
EOF
echo "Appended Composio PATH to ~/.profile"
