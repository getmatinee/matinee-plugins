#!/usr/bin/env python3
# Copyright (C) 2023-2026 Swissmakers GmbH
# Author: Michael André Reber
# License: AGPL-3.0-or-later
# https://github.com/getmatinee/matinee
"""Validate registry.json against the plugin manifests it describes.

registry.json duplicates each plugin's description, capabilities, scopes and
homepage so the catalog can render before a plugin is installed. Nothing keeps
those copies in sync with the manifest, so this check does.

It is run from the repository root: python3 scripts/validate.py
"""

import json
import os
import sys

# The typographic characters banned across the project. Letters carrying
# diacritics (an accented e, say) are fine these below are not
BANNED = {
    "–": "en-dash (use -)",
    "—": "em-dash (use a comma or colon)",
    "‘": "curly quote (use ')",
    "’": "curly quote (use ')",
    "‚": "low quote (use ')",
    "“": "curly quote (use \")",
    "”": "curly quote (use \")",
    "„": "low quote (use \")",
    "•": "bullet (use - or *)",
    "…": "ellipsis (use ...)",
    "→": "arrow (use ->)",
    " ": "non-breaking space (use a normal space)",
}

SKIP_DIRS = {".git", "node_modules", "dist"}
SKIP_FILES = {os.path.join("scripts", "validate.py"), "LICENSE"}

CONFIG_TYPES = {"text", "password", "number", "boolean", "button", "multiselect", "info", "usermatch"}

errors = []


def fail(msg):
    errors.append(msg)

def version_key(v):
    return tuple(int(p) if p.isdigit() else 0 for p in str(v).lstrip("v").split("."))

def check_typography(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root)
            if rel in SKIP_FILES:
                continue
            try:
                with open(path, encoding="utf-8") as fh:
                    lines = fh.readlines()
            except (UnicodeDecodeError, OSError):
                continue
            for n, line in enumerate(lines, 1):
                for ch in line:
                    if ch in BANNED:
                        fail("%s:%d contains a %s" % (rel, n, BANNED[ch]))

def check_registry(root):
    with open(os.path.join(root, "registry.json"), encoding="utf-8") as fh:
        registry = json.load(fh)

    if not registry.get("plugins"):
        fail("registry.json lists no plugins")
        return

    for entry in registry["plugins"]:
        pid = entry.get("id", "")
        if not pid or not entry.get("name") or not entry.get("versions"):
            fail("registry entry %r must set id, name and versions" % pid)
            continue

        for version in entry["versions"]:
            has_source = bool(version.get("source"))
            has_download = bool(version.get("download"))
            if has_source == has_download:
                fail("%s %s: set exactly one of source or download" % (pid, version.get("version")))

        latest = max(entry["versions"], key=lambda v: version_key(v["version"]))
        source = latest.get("source")
        if not source:
            continue

        plugin_dir = os.path.join(root, source)
        if not os.path.isdir(plugin_dir):
            fail("%s: source %r is not a directory" % (pid, source))
            continue

        manifest_path = os.path.join(plugin_dir, "manifest.json")
        if not os.path.isfile(manifest_path):
            fail("%s: %s/manifest.json is missing" % (pid, source))
            continue
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)

        if manifest.get("id") != pid:
            fail("%s: manifest id is %r" % (pid, manifest.get("id")))
        if manifest.get("version") != latest["version"]:
            fail("%s: manifest version %r does not match the newest registry version %r"
                 % (pid, manifest.get("version"), latest["version"]))

        main = manifest.get("main") or "main.js"
        if not os.path.isfile(os.path.join(plugin_dir, main)):
            fail("%s: entrypoint %r is missing from %s" % (pid, main, source))

        icon = manifest.get("icon")
        if icon and not os.path.isfile(os.path.join(plugin_dir, icon)):
            fail("%s: icon %r is missing from %s" % (pid, icon, source))

        for field in ("name", "author", "description", "capabilities", "scopes", "homepage"):
            if entry.get(field) != manifest.get(field):
                fail("%s: %s differs between registry.json and manifest.json" % (pid, field))
        if manifest.get("matinee_min") != latest.get("matinee_min"):
            fail("%s: matinee_min %r does not match the newest registry version's %r"
                 % (pid, manifest.get("matinee_min"), latest.get("matinee_min")))

        check_config_fields(pid, manifest.get("config") or [])

def check_config_fields(pid, fields):
    for field in fields:
        key = field.get("key")
        if not key or not field.get("label"):
            fail("%s: every config field must set key and label (got %r)" % (pid, field))
            continue
        ftype = field.get("type", "text")
        if ftype not in CONFIG_TYPES:
            fail("%s: config field %r has unknown type %r (one of %s)"
                 % (pid, key, ftype, ", ".join(sorted(CONFIG_TYPES))))
        if ftype == "button" and not field.get("action"):
            fail("%s: button field %r must set action" % (pid, key))
        if ftype in ("multiselect", "usermatch") and not field.get("options_hook"):
            fail("%s: %s field %r must set options_hook" % (pid, ftype, key))
        if ftype == "info" and not field.get("status_hook"):
            fail("%s: info field %r must set status_hook" % (pid, key))

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    check_registry(root)
    check_typography(root)
    if errors:
        for e in errors:
            print("error: %s" % e, file=sys.stderr)
        print("\n%d problem(s) found." % len(errors), file=sys.stderr)
        return 1
    print("registry.json and every plugin manifest agree. typography is clean!")
    return 0

if __name__ == "__main__":
    sys.exit(main())
