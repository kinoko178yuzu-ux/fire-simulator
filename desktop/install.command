#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/desktop/build.command"
mkdir -p "$HOME/Applications"
ditto "$ROOT/dist/資産管理アプリ.app" "$HOME/Applications/資産管理アプリ.app"
/usr/bin/mdimport "$HOME/Applications/資産管理アプリ.app" >/dev/null 2>&1 || true
echo "Installed: $HOME/Applications/資産管理アプリ.app"
open "$HOME/Applications/資産管理アプリ.app"
