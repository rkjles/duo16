#!/bin/bash
# Signs the Mac app ad-hoc (required on Apple Silicon) and packs it as .zip and .dmg
set -euo pipefail
cd "$(dirname "$0")/.."
APP=$(ls -d dist/mac-universal/*.app | head -n 1)
VERSION=$(node -p "require('./package.json').version")
echo "Signing $APP (ad-hoc)"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
mkdir -p dist/release
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/release/Duo16-$VERSION-mac.zip"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Duo16" -srcfolder "$STAGE" -ov -format UDZO "dist/release/Duo16-$VERSION-mac.dmg"
rm -rf "$STAGE"
ls -lh dist/release
