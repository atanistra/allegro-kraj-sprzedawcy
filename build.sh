#!/bin/sh
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
mkdir -p dist
OUT="dist/allegro-kraj-sprzedawcy-$VERSION.zip"
rm -f "$OUT"
zip -q -r "$OUT" manifest.json content.js content.css icons
echo "$OUT"
