#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/desktop/build.command"
mkdir -p "$HOME/Applications"
ditto "$ROOT/dist/Fire Simulator.app" "$HOME/Applications/Fire Simulator.app"
/usr/bin/mdimport "$HOME/Applications/Fire Simulator.app" >/dev/null 2>&1 || true
echo "Installed: $HOME/Applications/Fire Simulator.app"
open "$HOME/Applications/Fire Simulator.app"
