#!/usr/bin/env bash
# Creates the Android release signing key and prints the commands that store it as GitHub secrets
# (docs/ANDROID-SPEC.md §4, plugins/android-build.js). Run once; keep the key file and the passwords safe:
# an APK signed with another key cannot be installed over this one (testers would have to uninstall first).
#
#   bash scripts/android-keystore.sh [output-dir]      default: ~/.wtfai-android-signing
#
# The key is written OUTSIDE the repository. Needs `keytool` (any JDK) and `gh` logged in for the printed commands.
set -euo pipefail

DIR="${1:-$HOME/.wtfai-android-signing}"
KEYSTORE="$DIR/release.keystore"
ALIAS="wtfai"

if [ -e "$KEYSTORE" ]; then
  echo "A key already exists at $KEYSTORE. Refusing to overwrite it." >&2
  exit 1
fi
mkdir -p "$DIR"
chmod 700 "$DIR" 2> /dev/null || true

# One random password for the store and the key (PKCS12 uses the same one for both).
PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
echo "$PASSWORD" > "$DIR/password.txt"
chmod 600 "$DIR/password.txt" 2> /dev/null || true

keytool -genkeypair -v \
  -keystore "$KEYSTORE" -storetype PKCS12 \
  -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASSWORD" -keypass "$PASSWORD" \
  -dname "CN=wtf.ai, O=wtf.ai, C=UA"

echo
echo "Key created: $KEYSTORE"
echo "Password saved: $DIR/password.txt (back both up somewhere private; do not commit them)"
echo
echo "Store them as repository secrets with these commands (each prompts for nothing; run them one by one):"
echo
echo "  base64 -w0 \"$KEYSTORE\" | gh secret set ANDROID_KEYSTORE_BASE64"
echo "  gh secret set ANDROID_KEYSTORE_PASSWORD < \"$DIR/password.txt\""
echo "  echo -n $ALIAS | gh secret set ANDROID_KEY_ALIAS"
echo "  gh secret set ANDROID_KEY_PASSWORD < \"$DIR/password.txt\""
echo
echo "Then run Actions -> CI -> Run workflow with android = tester. The job log says which key signed the APK."
