#!/usr/bin/env bash
#
# Stage the Tauri frontend directory (desktop/) from the web sources.
#
# The Tauri app serves its UI from `desktop/` (see src-tauri/tauri.conf.json
# -> build.frontendDist). Only the lightweight static assets are staged here;
# the large disk/tape images in media/ are deliberately EXCLUDED and shipped
# instead as bundled Tauri resources (rk0/rk1/bootcode) so the installer stays
# small (~10 MB). Other images can be dragged & dropped at runtime.
#
# Re-run this script before `cargo tauri build` whenever web sources change.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/desktop"

rm -rf "$DEST"
mkdir -p "$DEST"

# --- Lightweight static web app (no media/) -------------------------
cp "$ROOT/pdp11.html"      "$DEST/"
cp "$ROOT/pdp11-45.html"   "$DEST/"
cp "$ROOT/favicon.ico"     "$DEST/"
cp -r "$ROOT/css"          "$DEST/css"
cp -r "$ROOT/src"          "$DEST/src"
cp -r "$ROOT/assets"       "$DEST/assets"

echo "Staged Tauri frontend -> $DEST"
du -sh "$DEST"
