#!/usr/bin/env bash
# Renders the link-preview image and icons into packages/web/public/ with
# headless Chrome. Run after changing anything in packages/web/og/.
set -euo pipefail
cd "$(dirname "$0")/../packages/web"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT

shot() { # <source> <out.png> <width> <height> [extra chrome args...]
  local src="$1" out="$2" w="$3" h="$4"; shift 4
  "$CHROME" --headless=new --user-data-dir="$PROFILE" --disable-gpu --hide-scrollbars \
    --window-size="$w,$h" --screenshot="$out" "$@" "file://$PWD/$src" >/dev/null 2>&1 &
  local pid=$!
  # Headless Chrome occasionally hangs after writing the file; don't wait forever.
  for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill "$pid" 2>/dev/null || true
  test -s "$out" && echo "rendered $out (${w}x${h})"
}

# The preview loads web fonts: give it virtual time for them before the shot.
shot og/og-image.html public/og.png 1200 630 --virtual-time-budget=8000
# Chrome won't lay out windows narrower than ~500px, so render icons at 512
# and scale them down (sips ships with macOS).
TMP="$PROFILE/icons"; mkdir -p "$TMP"
shot og/touch-icon.html "$TMP/touch.png" 512 512
sips -z 180 180 "$TMP/touch.png" --out public/apple-touch-icon.png >/dev/null
shot og/icon.svg "$TMP/icon.png" 512 512 --default-background-color=00000000
sips -z 32 32 "$TMP/icon.png" --out public/favicon-32.png >/dev/null
cp og/icon.svg public/favicon.svg
echo "scaled icons: public/apple-touch-icon.png (180), public/favicon-32.png (32)"
