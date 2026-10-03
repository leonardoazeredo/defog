#!/usr/bin/env bash
set -euo pipefail

APK="${1:?Usage: $0 <path-to.apk>}"

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD_TOOLS_DIR="$(ls -d "$ANDROID_HOME/build-tools"/* 2>/dev/null | sort -V | tail -1)"
AAPT2="$BUILD_TOOLS_DIR/aapt2"
ZIPALIGN="$BUILD_TOOLS_DIR/zipalign"

NDK_DIR="$(ls -d "$ANDROID_HOME/ndk"/* 2>/dev/null | sort -V | tail -1)"
LLVM_READELF="$NDK_DIR/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-readelf"

fail() { echo "FAIL $1"; exit 1; }

# 1. Permissions — only android.permission.INTERNET is expected
PERMS="$("$AAPT2" dump permissions "$APK")"
EXTRA="$(echo "$PERMS" | grep 'android.permission\.' | grep -v 'android.permission.INTERNET' || true)"
[[ -z "$EXTRA" ]] || fail "permissions (unexpected: $EXTRA)"
echo "OK permissions"

# 2. Target SDK must be 36
BADGING="$("$AAPT2" dump badging "$APK")"
echo "$BADGING" | grep -q "targetSdkVersion:'36'" || fail "targetSdk (want 36)"
echo "OK targetSdk"

# 3. Zip alignment at 16 KB pages
"$ZIPALIGN" -c -P 16 -v 4 "$APK" >/dev/null 2>&1 || fail "zipalign"
echo "OK zipalign"

# 4. 16 KB ELF LOAD segment alignment in all .so files
TMPDIR_EXTRACT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EXTRACT"' EXIT

unzip -q "$APK" "lib/arm64-v8a/*.so" "lib/x86_64/*.so" -d "$TMPDIR_EXTRACT" 2>/dev/null || true

for so in "$TMPDIR_EXTRACT"/lib/*/*.so; do
  [[ -f "$so" ]] || continue
  BAD_SEGS="$("$LLVM_READELF" -lW "$so" | awk '/LOAD/{if (NF>=6) { align=$NF; sub(/^0x/,"",align); if (strtonum("0x"align) < strtonum("0x4000")) print FILENAME": "align}}')"
  [[ -z "$BAD_SEGS" ]] || fail "16k-elf ($BAD_SEGS)"
done
echo "OK 16k-elf"
