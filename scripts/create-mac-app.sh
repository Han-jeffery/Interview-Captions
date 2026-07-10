#!/bin/zsh
set -euo pipefail

APP_NAME="Interview Captions"
PROJECT_DIR="/Volumes/HML-Apple/英文面试"
APP_PATH="${1:-${PROJECT_DIR}/${APP_NAME}.app}"
NPM_BIN="/opt/homebrew/bin/npm"
ICON_SVG="${PROJECT_DIR}/assets/interview-captions-icon.svg"
ICONSET_DIR="${PROJECT_DIR}/assets/InterviewCaptions.iconset"
ICON_FILE="${PROJECT_DIR}/assets/InterviewCaptions.icns"

if [[ ! -x "$NPM_BIN" ]]; then
  NPM_BIN="$(command -v npm)"
fi

rm -rf "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"

if [[ -f "$ICON_SVG" ]]; then
  rm -rf "$ICONSET_DIR"
  mkdir -p "$ICONSET_DIR"
  TMP_ICON_DIR="$(mktemp -d)"
  qlmanage -t -s 1024 -o "$TMP_ICON_DIR" "$ICON_SVG" >/dev/null 2>&1 || true
  BASE_PNG="${TMP_ICON_DIR}/interview-captions-icon.svg.png"
  if [[ -f "$BASE_PNG" ]]; then
    for size in 16 32 128 256 512; do
      sips -z "$size" "$size" "$BASE_PNG" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
      sips -z "$((size * 2))" "$((size * 2))" "$BASE_PNG" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
    done
    iconutil -c icns "$ICONSET_DIR" -o "$ICON_FILE"
    cp "$ICON_FILE" "$APP_PATH/Contents/Resources/InterviewCaptions.icns"
  fi
  rm -rf "$TMP_ICON_DIR"
fi

cat > "$APP_PATH/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>InterviewCaptionsLauncher</string>
  <key>CFBundleIconFile</key>
  <string>InterviewCaptions</string>
  <key>CFBundleIdentifier</key>
  <string>local.interview.captions</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Interview Captions needs microphone access to transcribe interview audio.</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

cat > "$APP_PATH/Contents/MacOS/InterviewCaptionsLauncher" <<LAUNCHER
#!/bin/zsh
set -euo pipefail
cd "$PROJECT_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_BINARY="/opt/homebrew/bin/node"
exec "$NPM_BIN" run desktop
LAUNCHER

chmod +x "$APP_PATH/Contents/MacOS/InterviewCaptionsLauncher"
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

echo "$APP_PATH"
