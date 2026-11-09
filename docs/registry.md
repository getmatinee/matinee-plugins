# The plugin registry format

A registry is any HTTPS URL serving a `registry.json`. A plain GitHub repository URL works too: Matinee rewrites it to `raw.githubusercontent.com/<owner>/<repo>/<branch>/registry.json`, trying `main` then `master`. Only the stock Matinee registry follows the release channel chosen on the Catalog section, and its Development channel reads the `dev` branch. Every other registry is always read from its stable branch.

Everything the server fetches for a registry travels over https: the index, every `source` and `download` it resolves, and every redirect on the way. An `http://` reference or a redirect to one fails the fetch.

```json
{
  "name": "My Registry",
  "plugins": [{
    "id": "my-plugin",
    "name": "My Plugin",
    "description": "What it does.",
    "author": "you",
    "homepage": "https://github.com/you/my-plugin",
    "icon": "https://example.com/my-plugin/icon.png",
    "scopes": ["storage", "network"],
    "versions": [{
      "version": "1.0.0",
      "matinee_min": "2.1.0",
      "source": "plugins/my-plugin/"
    }]
  }]
}
```

`name`, `description`, `author`, `homepage` and `scopes` are duplicated from the manifest so the catalog can render them before anything is installed, and the newest version's `matinee_min` repeats the manifest's. `validate.py` keeps the copies identical. The catalog and the installed plugin list show `icon` as given, so it is an absolute URL the browser can load.

A version sets exactly one of `source` or `download`. Setting both, or neither, is rejected when the registry is fetched.

## `source`: install from the repository

`source` names a directory holding `manifest.json` and the file named by `manifest.main`. It is resolved **relative to the URL `registry.json` was fetched from**, so the same `registry.json` works unchanged on every branch that serves it. That is what makes the `dev` branch possible: test there, merge to `main` to publish. No zip, no checksum, no build artifacts committed.

Exactly three files are fetched: `manifest.json`, `manifest.main`, and the optional `manifest.icon`. The server runs only the entrypoint and has no module loader, so a plugin is one JavaScript file.

There is no `sha256` for `source`, deliberately. A relative source comes from the same origin as the registry index, so a hash sitting beside the code it describes authenticates nothing that TLS does not already.

## `download`: install from a zip

```json
{ "version": "1.0.0", "matinee_min": "2.1.0", "download": "https://example.com/releases/my-plugin-1.0.0.zip", "sha256": "<sha256>" }
```

Use this when the built entrypoint is not committed next to the manifest, or when the archive lives on a different origin than the registry. `sha256` is **required**. The server refuses to install a zip version without one, and rejects the archive when the hash does not match. An archive is at most 20 MB, packed and unpacked, with at most 2000 entries, and its `manifest.json` sits at the top or inside one top-level directory.

`scripts/package.sh plugins/<id>` builds the zip from `manifest.json`, the entrypoint and the icon, running `npm run build` first when the plugin has a `package.json`. It writes `dist/<id>-<version>.zip` and prints the sha256 to put in the registry.

A relative `download` resolves against the registry URL, exactly like `source`. Prefer relative references, because an absolute URL pins one branch's artifact for every branch.

## Adding a registry to a server

The stock Matinee registry is built in, fixed and undeletable. Its Stable and Development choice is the "Release channel" selector of the Catalog section under Server settings -> Plugins. Admins add further registry URLs with "Add registry" in the Registries section of the same page, HTTPS only. The server fetches the registry once when it is added and refuses an address that does not answer a valid `registry.json`. Its plugins are merged into the same catalog, always read from the registry's stable branch.

Install and update work the same way for every registry:

1. The catalog offers the newest version whose `matinee_min` the server meets, and hides a plugin that asks for a scope the server does not know.
2. The admin confirms the install or update in a dialog that lists the scopes of the registry entry.
3. The web app sends the approved scopes with the request. When the registry entry lists a scope outside them, for example because the registry changed after the catalog loaded, the server answers 409 with the code `plugins.scopeConsentRequired` and the missing `scopes`, and the web app reloads the catalog so the next attempt shows the new list.
4. The server refuses a version older than the installed one, fetches the files, verifies the `sha256` for zips, and checks that the manifest `id` matches the registry id and that the manifest asks for no scope the registry entry leaves out.
5. The server swaps the files into place, enables the plugin and starts it. Config and storage of an updated plugin stay as they were.

When two registries list the same plugin id, **the stock registry always wins**. Among custom registries the one added first wins, regardless of version. To test the `dev` branch of this repository, switch the channel selector on the Catalog section to Development rather than adding a second registry alongside it. For a fork, change the plugin ids.
