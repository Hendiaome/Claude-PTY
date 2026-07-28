#!/usr/bin/env bash
set -euo pipefail

mode="${1:-dist}"

npm run build

case "${mode}" in
  app)
    npx electron-builder --mac dir --publish never
    ;;
  dist)
    npx electron-builder --mac dmg zip --publish never
    ;;
  *)
    echo "Usage: scripts/package-mac.sh [app|dist]" >&2
    exit 2
    ;;
esac
