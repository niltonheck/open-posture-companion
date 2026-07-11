#!/bin/bash
# App Store screenshot capture + finalize (docs/store-listing.md workflow).
#
#   scripts/store_screenshots.sh snap <label>   # capture phone screen (USB) → store/screenshots/raw/
#   scripts/store_screenshots.sh finalize       # raw/ → final/ at the ASC 6.9" size (1320×2868)
#   scripts/store_screenshots.sh list           # show what's captured so far
#
# Requires: pymobiledevice3 (pipx), iPhone on USB with dev mode; sips (macOS).
# Raw shots keep the device's native resolution; finalize resamples to the
# target height and center-crops the width (sub-1% aspect difference across
# modern iPhones), refusing to upscale past 130% to keep marketing shots crisp.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/store/screenshots/raw"
FINAL="$ROOT/store/screenshots/final"
TARGET_W="${TARGET_W:-1320}"
TARGET_H="${TARGET_H:-2868}"

case "${1:-}" in
  snap)
    label="${2:?usage: store_screenshots.sh snap <label>}"
    mkdir -p "$RAW"
    n=$(ls "$RAW" 2>/dev/null | wc -l | tr -d ' ')
    file="$RAW/$(printf '%02d' $((n + 1)))-${label}.png"
    pymobiledevice3 developer dvt screenshot "$file" --userspace
    echo "captured: $file ($(sips -g pixelWidth -g pixelHeight "$file" | awk '/pixel/ {printf "%s ", $2}'))"
    ;;
  finalize)
    mkdir -p "$FINAL"
    for f in "$RAW"/*.png; do
      out="$FINAL/$(basename "$f")"
      w=$(sips -g pixelWidth "$f" | awk '/pixelWidth/ {print $2}')
      h=$(sips -g pixelHeight "$f" | awk '/pixelHeight/ {print $2}')
      if [ "$w" = "$TARGET_W" ] && [ "$h" = "$TARGET_H" ]; then
        cp "$f" "$out"; echo "$(basename "$f"): already ${TARGET_W}x${TARGET_H}"; continue
      fi
      scale_pct=$(( TARGET_H * 100 / h ))
      if [ "$scale_pct" -gt 130 ]; then
        echo "$(basename "$f"): would upscale ${scale_pct}% — too far for a crisp shot; capture on a larger phone or pick a smaller ASC size" >&2
        continue
      fi
      cp "$f" "$out"
      sips --resampleHeight "$TARGET_H" "$out" >/dev/null
      neww=$(sips -g pixelWidth "$out" | awk '/pixelWidth/ {print $2}')
      if [ "$neww" -lt "$TARGET_W" ]; then
        sips --resampleWidth "$TARGET_W" "$out" >/dev/null
        sips --cropToHeightWidth "$TARGET_H" "$TARGET_W" "$out" >/dev/null
      else
        sips --cropToHeightWidth "$TARGET_H" "$TARGET_W" "$out" >/dev/null
      fi
      echo "$(basename "$f"): ${w}x${h} → ${TARGET_W}x${TARGET_H}"
    done
    echo "finalized into $FINAL"
    ;;
  list)
    ls -1 "$RAW" 2>/dev/null || echo "(none captured yet)"
    ;;
  *)
    grep '^#' "$0" | head -12
    exit 1
    ;;
esac
