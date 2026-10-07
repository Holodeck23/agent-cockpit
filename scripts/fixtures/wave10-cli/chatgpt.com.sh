#!/bin/bash
# Stand-in for Codex's official installer (proof-wave-10.ts serves it from COCKPIT_PROOF_INSTALLERS).
# Its bytes differ from the pinned review, so Cockpit first refuses it and offers "Install this version anyway".
set -e
echo "==> Detected platform: macOS (Apple Silicon)"
echo "==> Resolved version: 0.160.1"
dir="$HOME/.codex/packages/standalone/releases/0.160.1"
mkdir -p "$dir" "$HOME/.local/bin"
sleep 1
cp "$HOME/.fcli/fcli" "$dir/codex"; chmod +x "$dir/codex"
ln -sf "$dir/codex" "$HOME/.local/bin/codex"
echo "==> Installed codex to ~/.local/bin/codex"
