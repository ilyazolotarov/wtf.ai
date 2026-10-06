#!/usr/bin/env bash
# Creates the Android release signing key and prints the commands that store it as GitHub secrets
# (docs/ANDROID-SPEC.md §4, plugins/android-build.js). Run once; keep the key file and the passwords safe:
# an APK signed with another key cannot be installed over this one (testers would have to uninstall first).
#
#   bash scripts/android-keystore.sh [output-dir]      default: ~/.wtfai-android-signing
#
# The key is written OUTSIDE the repository. Needs a JDK `keytool` (found on PATH, in JAVA_HOME or the usual install
# folders; otherwise a JDK container via docker is used) and `gh` logged in for the printed commands.
set -euo pipefail

DIR="${1:-$HOME/.wtfai-android-signing}"
KEYSTORE="$DIR/release.keystore"
ALIAS="wtfai"

# keytool is often missing from PATH even when `java` works (Windows keeps only a java shim there).
find_keytool() {
  if command -v keytool > /dev/null 2>&1; then
    command -v keytool
    return 0
  fi
  local candidate
  for candidate in \
    "${JAVA_HOME:-/nonexistent}/bin/keytool" "${JAVA_HOME:-/nonexistent}/bin/keytool.exe" \
    "/c/Program Files/Java"/*/bin/keytool.exe \
    "/c/Program Files/Eclipse Adoptium"/*/bin/keytool.exe \
    "/c/Program Files/Microsoft"/jdk*/bin/keytool.exe \
    "/c/Program Files/Android/Android Studio/jbr/bin/keytool.exe" \
    /usr/lib/jvm/*/bin/keytool \
    /Library/Java/JavaVirtualMachines/*/Contents/Home/bin/keytool; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if [ -e "$KEYSTORE" ]; then
  echo "A key already exists at $KEYSTORE. Refusing to overwrite it." >&2
  exit 1
fi
mkdir -p "$DIR"
chmod 700 "$DIR" 2> /dev/null || true

# One random password for the store and the key (PKCS12 uses the same one for both).
# (Not `tr < /dev/urandom | head`: under pipefail tr dies from SIGPIPE and the script exits silently.)
PASSWORD=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-24)
[ "${#PASSWORD}" -eq 24 ] || {
  echo "could not generate a password" >&2
  exit 1
}
echo "$PASSWORD" > "$DIR/password.txt"
chmod 600 "$DIR/password.txt" 2> /dev/null || true

GEN_ARGS=(-genkeypair -v -storetype PKCS12 -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000
  -storepass "$PASSWORD" -keypass "$PASSWORD" -dname "CN=wtf.ai, O=wtf.ai, C=UA")

if KEYTOOL=$(find_keytool); then
  echo "Using $KEYTOOL"
  "$KEYTOOL" "${GEN_ARGS[@]}" -keystore "$KEYSTORE"
elif command -v docker > /dev/null 2>&1; then
  echo "No local keytool: using a JDK container (docker)."
  MSYS_NO_PATHCONV=1 docker run --rm -v "$DIR:/out" eclipse-temurin:17-jdk keytool "${GEN_ARGS[@]}" -keystore /out/release.keystore
else
  rm -f "$DIR/password.txt"
  echo "keytool not found and no docker. Install a JDK (e.g. winget install Microsoft.OpenJDK.17) and run again." >&2
  exit 1
fi
if [ ! -s "$KEYSTORE" ]; then
  rm -f "$DIR/password.txt"
  echo "The key was not created." >&2
  exit 1
fi

echo
echo "Key created: $KEYSTORE"
echo "Password saved: $DIR/password.txt (back both up somewhere private; do not commit them)"
echo
echo "Store them as repository secrets with these commands (run them one by one):"
echo
echo "  base64 -w0 \"$KEYSTORE\" | gh secret set ANDROID_KEYSTORE_BASE64"
echo "  gh secret set ANDROID_KEYSTORE_PASSWORD < \"$DIR/password.txt\""
echo "  echo -n $ALIAS | gh secret set ANDROID_KEY_ALIAS"
echo "  gh secret set ANDROID_KEY_PASSWORD < \"$DIR/password.txt\""
echo
echo "Then run Actions -> CI -> Run workflow with android = tester. The job log says which key signed the APK."
