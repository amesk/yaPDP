#!/usr/bin/env bash
#
# Stage the Tauri frontend directory (desktop/) from the web sources.
#
# The Tauri app serves its UI from `desktop/` (see src-tauri/tauri.conf.json
# -> build.frontendDist). Only the lightweight static assets are staged here;
# the large disk/tape images in media/ are deliberately EXCLUDED and shipped
# instead as bundled Tauri resources so the installer stays small.
#
# Two installer variants are produced from the same frontend:
#   --variant minimal  (default) -> bundles only rk0/rk1/bootcode
#   --variant full               -> bundles every media image (RK/RL/RP/RA/TM + tapes)
#
# The matching src-tauri/tauri.conf.<variant>.json is copied over
# src-tauri/tauri.conf.json (gitignored) before `cargo tauri build`.
#
# Re-run this script before `cargo tauri build` whenever web sources change.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/desktop"

# --- Parse arguments -------------------------------------------------
VARIANT="minimal"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --variant)
            VARIANT="${2:-minimal}"
            shift 2
            ;;
        --variant=*)
            VARIANT="${1#*=}"
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--variant minimal|full]"
            echo "  minimal  (default) bundle rk0/rk1/bootcode only"
            echo "  full     bundle every media image"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

case "$VARIANT" in
    minimal|full) ;;
    *)
        echo "Unknown variant '$VARIANT' (expected: minimal|full)" >&2
        exit 1
        ;;
esac

# --- Stage lightweight static web app (no media/) --------------------
rm -rf "$DEST"
mkdir -p "$DEST"

cp "$ROOT/pdp11.html"      "$DEST/"
cp "$ROOT/pdp11-45.html"   "$DEST/"
cp "$ROOT/favicon.ico"     "$DEST/"
cp -r "$ROOT/css"          "$DEST/css"
cp -r "$ROOT/src"          "$DEST/src"
cp -r "$ROOT/assets"       "$DEST/assets"

# --- Select the Tauri config for this variant -----------------------
cp "$ROOT/src-tauri/tauri.conf.$VARIANT.json" "$ROOT/src-tauri/tauri.conf.json"

echo "Staged Tauri frontend -> $DEST"
echo "Variant: $VARIANT (tauri.conf.$VARIANT.json -> tauri.conf.json)"
echo "Next: cd src-tauri && cargo tauri build"
du -sh "$DEST"
