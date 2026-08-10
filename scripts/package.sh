#!/usr/bin/env bash
# Copyright (C) 2023-2026 Matinee
# Author: Michael André Reber
# License: AGPL-3.0-or-later
# https://github.com/getmatinee/matinee
#
# Packages one plugin into a dist zip and prints its sha256 for a registry download entry

set -euo pipefail

src="${1:?usage: scripts/package.sh plugins/<id>}"
mkdir -p dist

if [ -f "$src/package.json" ]; then
  (cd "$src" && npm install --silent && npm run build --silent)
fi

python3 - "$src" <<'EOF'
import hashlib, json, os, sys, zipfile

src = sys.argv[1]
manifest = json.load(open(os.path.join(src, "manifest.json")))
main = manifest.get("main", "main.js")
dest = os.path.join("dist", "%s-%s.zip" % (manifest["id"], manifest["version"]))

with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(os.path.join(src, "manifest.json"), "manifest.json")
    z.write(os.path.join(src, main), main)
    icon = manifest.get("icon")
    if icon and os.path.exists(os.path.join(src, icon)):
        z.write(os.path.join(src, icon), icon)

print(dest)
print("sha256:", hashlib.sha256(open(dest, "rb").read()).hexdigest())
EOF
