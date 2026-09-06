#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Fire Simulator.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources/web"

mkdir -p "$MACOS" "$RESOURCES"
/usr/bin/swiftc "$ROOT/desktop/FireSimulatorApp.swift" -o "$MACOS/FireSimulator" -framework AppKit -framework WebKit -lsqlite3
cp "$ROOT/index.html" "$ROOT/stock_master.js" "$ROOT/manifest.json" "$ROOT/icon-192.png" "$ROOT/icon-512.png" "$ROOT/apple-touch-icon.png" "$RESOURCES/"
cp "$ROOT/mf_fire_bridge.user.js" "$ROOT/mf_asset_bridge.user.js" "$ROOT/broker_fire_bridge.user.js" "$RESOURCES/"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>FireSimulator</string>
  <key>CFBundleIdentifier</key><string>jp.kinoko.fire-simulator</string>
  <key>CFBundleName</key><string>Fire Simulator</string>
  <key>CFBundleDisplayName</key><string>資産管理 Fire Simulator</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
echo "Built: $APP"
