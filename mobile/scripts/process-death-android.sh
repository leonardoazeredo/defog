#!/bin/zsh
# usage: process-death-android.sh <adb-serial>
# Kills the WebView renderer twice while the saved fog restores, so the retry panel can be checked by eye (the process-death
# row of the manual checklist). It prints a "killed" line per successful kill; a missing line means that kill did not happen.
# Needs a rootable emulator (userdebug image) with the large backup already saved as the current fog.
SER=${1:?adb serial required}
adb() { /opt/homebrew/bin/adb -s $SER "$@"; }
PKG=codes.madera.crossfog
adb root >/dev/null
adb wait-for-device
sleep 2
adb shell am force-stop $PKG
adb shell "rm -f /data/data/$PKG/files/fog/restoring.json"
adb shell 'cat > /data/local/tmp/kill2.sh' <<'DEV'
F=/data/data/codes.madera.crossfog/files/fog/restoring.json
kill_renderer() {
  # Match the "webview:" prefix: a bare "sandboxed_process" also matches Chrome's own renderer, which must stay alive.
  pid=$(ps -A -o PID,NAME | grep 'webview:sandboxed_process' | { read p r; echo $p; })
  [ -n "$pid" ] && kill -9 $pid && echo "killed renderer $pid at $(date +%T.%N)"
}
# The restore guard writes restoring.json with an attempt count when the page sends ready and it starts restoring the saved
# fog, and removes it once loaded. The count survives a kill, so attempts:1 then attempts:2 mark the two restore tries. The
# file is the only observable signal of the restore window (the app logs nothing for it), so poll in a tight loop: sleep would miss it.
wait_for() {
  n=0
  while [ $n -lt 4000000 ]; do
    if [ -e $F ] && grep -q "\"attempts\":$1" $F 2>/dev/null; then return 0; fi
    n=$((n+1))
  done
  return 1
}
am start -n codes.madera.crossfog/.MainActivity >/dev/null
echo "launched at $(date +%T.%N)"
if wait_for 1; then echo "marker attempts=1 at $(date +%T.%N)"; kill_renderer; else echo "no attempts=1 marker"; exit 1; fi
if wait_for 2; then echo "marker attempts=2 at $(date +%T.%N)"; kill_renderer; else echo "no attempts=2 marker (restore finished or never remounted)"; exit 2; fi
echo done
DEV
adb shell "sh /data/local/tmp/kill2.sh"
