#!/usr/bin/env bash
# Build a clean static publish folder for Render (frontend only)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"

rm -rf "$DIST"
mkdir -p "$DIST/static"

cp "$ROOT/index.html" "$DIST/"
cp "$ROOT/ok.html" "$DIST/" 2>/dev/null || true
cp "$ROOT/manifest.json" "$DIST/" 2>/dev/null || true
cp "$ROOT/robots.txt" "$DIST/" 2>/dev/null || true
cp "$ROOT/favicon.ico" "$DIST/" 2>/dev/null || true
cp "$ROOT/logo192.png" "$DIST/" 2>/dev/null || true
cp "$ROOT/certy.png" "$DIST/" 2>/dev/null || true
cp -R "$ROOT/static/." "$DIST/static/"

# SPA fallback for Render static hosting
printf '%s\n' '/*    /index.html   200' > "$DIST/_redirects"

echo "Frontend dist ready: $DIST"
