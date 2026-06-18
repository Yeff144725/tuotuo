#!/bin/bash
# Double-click this in Finder to launch the Token Trackpad.
cd "$(dirname "$0")" || exit 1
if [ ! -d node_modules ]; then
  echo "First run — installing Electron (one-time, ~1–2 min)…"
  npm install || { echo "npm install failed"; read -r; exit 1; }
fi
echo "Launching Token Trackpad… (quit from the ⚡ menu-bar icon)"
npm start
