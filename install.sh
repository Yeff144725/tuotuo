#!/bin/bash
# Optional: install 坨坨 (tuotuo) as a real macOS app that auto-starts at login
# and relaunches itself if it's ever killed.
#   ./install.sh              install + start
#   ./install.sh --uninstall  remove
set -e

PROJ="$(cd "$(dirname "$0")" && pwd)"
ELECTRON="$PROJ/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
APP="$HOME/Applications/坨坨.app"
PLIST="$HOME/Library/LaunchAgents/com.tuotuo.pet.plist"
LABEL="com.tuotuo.pet"

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; rm -rf "$APP"
  pkill -f "MacOS/Electron $PROJ" 2>/dev/null || true
  echo "坨坨 uninstalled."
  exit 0
fi

[ -d "$PROJ/node_modules" ] || ( cd "$PROJ" && npm install )
pkill -f "MacOS/Electron $PROJ" 2>/dev/null || true

# 1) .app bundle — Spotlight-searchable + double-clickable
mkdir -p "$APP/Contents/MacOS"
printf '#!/bin/bash\nexec "%s" "%s"\n' "$ELECTRON" "$PROJ" > "$APP/Contents/MacOS/tuotuo"
chmod +x "$APP/Contents/MacOS/tuotuo"
cat > "$APP/Contents/Info.plist" <<'P'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>坨坨</string>
<key>CFBundleDisplayName</key><string>坨坨</string>
<key>CFBundleIdentifier</key><string>com.tuotuo.pet</string>
<key>CFBundleExecutable</key><string>tuotuo</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
P

# 2) LaunchAgent — start at login + relaunch if killed (a clean Quit stays quit)
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<A
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$ELECTRON</string><string>$PROJ</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>2</integer>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
A

# 3) load it now
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
sleep 2
echo "✅ 坨坨 installed + running. Quit from the ⚡ menu-bar; relaunch from Spotlight."
echo "   Uninstall any time: ./install.sh --uninstall"
