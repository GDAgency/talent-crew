#!/usr/bin/env bash
# Makes the Android and/or iPhone projects for the Lumia app (Capacitor).
#
#   mobile/app/prepare.sh <android|ios|both> <version> <build number> [first address]
#
# The first address is only where a brand-new install looks first; after that the app
# follows whatever an admin sets in Impostazioni → App per telefono.
# Then:  Android → mobile/app/build-android.sh   iPhone → GitHub Actions (or Xcode on a Mac).
set -euo pipefail
WHICH="${1:?android|ios|both}"; VERSION="${2:?version}"; BUILD="${3:?build number}"
FIRST="${4:-https://lumia.rogatski.com}"
cd "$(dirname "$0")"
case "$FIRST" in https://*) ;; *) FIRST="https://$FIRST" ;; esac
printf '// Written by mobile/app/prepare.sh: the address the app tries on its very first start.\nwindow.LUMIA_DEFAULT = "%s";\n' "$FIRST" > www/config.js
[ -d node_modules/@capacitor/cli ] || npm install --no-audit --no-fund --silent

if [ "$WHICH" = android ] || [ "$WHICH" = both ]; then
  rm -rf android && npx cap add android >/dev/null
  RES=android/app/src/main/res
  cp -r resources/android/. "$RES/"
  cat > "$RES/values/ic_launcher_background.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<resources><color name="ic_launcher_background">#121316</color></resources>
XML
  python3 - "$VERSION" "$BUILD" <<'PY'
import re, sys
v, b = sys.argv[1:3]
p = "android/app/build.gradle"; s = open(p).read()
s = re.sub(r"versionCode \d+", f"versionCode {b}", s)
s = re.sub(r'versionName "[^"]*"', f'versionName "{v}"', s)
open(p, "w").write(s)
PY
fi

if [ "$WHICH" = ios ] || [ "$WHICH" = both ]; then
  rm -rf ios
  # On Linux the last step (pod install) fails; a Swift Package project doesn't need it.
  npx cap add ios --packagemanager SPM >/dev/null || true
  [ -f ios/App/App.xcodeproj/project.pbxproj ] || { echo "iOS project was not created" >&2; exit 1; }
  cp resources/icon-1024.png ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
  python3 - "$VERSION" "$BUILD" <<'PY'
import plistlib, re, sys
v, b = sys.argv[1:3]
p = "ios/App/App/Info.plist"
with open(p, "rb") as f: d = plistlib.load(f)
d.update({"CFBundleDisplayName": "Lumia", "CFBundleShortVersionString": v, "CFBundleVersion": b, "ITSAppUsesNonExemptEncryption": False})
with open(p, "wb") as f: plistlib.dump(d, f)
x = "ios/App/App.xcodeproj/project.pbxproj"; s = open(x).read()
s = re.sub(r"MARKETING_VERSION = [^;]+;", f"MARKETING_VERSION = {v};", s)
s = re.sub(r"CURRENT_PROJECT_VERSION = [^;]+;", f"CURRENT_PROJECT_VERSION = {b};", s)
open(x, "w").write(s)
PY
fi
npx cap copy >/dev/null
echo "ready: $WHICH $VERSION ($BUILD), first address $FIRST"
