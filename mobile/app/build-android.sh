#!/usr/bin/env bash
# Builds and signs the Android app after prepare.sh.
#
#   JAVA_HOME=<JDK 21> ANDROID_HOME=<Android SDK> KEYSTORE=… KEYSTORE_PASSWORD=… [KEY_ALIAS=lumia] \
#     mobile/app/build-android.sh <version>
#
# Keep the keystore safe: every update must be signed with the same key, or phones refuse it.
# Output: mobile/app/out/lumia-<version>.apk
set -euo pipefail
VERSION="${1:?version}"
: "${JAVA_HOME:?}" "${ANDROID_HOME:?}" "${KEYSTORE:?}" "${KEYSTORE_PASSWORD:?}"
cd "$(dirname "$0")"
export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p out
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
(cd android && ./gradlew --no-daemon -q assembleRelease)
BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
"$BT/zipalign" -f -p 4 android/app/build/outputs/apk/release/app-release-unsigned.apk out/aligned.apk
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-key-alias "${KEY_ALIAS:-lumia}" --ks-pass env:KEYSTORE_PASSWORD --out "out/lumia-$VERSION.apk" out/aligned.apk
rm -f out/aligned.apk out/*.idsig
"$BT/apksigner" verify "out/lumia-$VERSION.apk"
echo "APK: $(pwd)/out/lumia-$VERSION.apk"
