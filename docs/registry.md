# The plugin registry format

A registry is any HTTPS URL serving a `registry.json`. A plain GitHub repository URL works too: Matinee rewrites it to `raw.githubusercontent.com/<owner>/<repo>/<branch>/registry.json`, trying `main` then `master`. Only the stock Matinee registry follows the release channel chosen on the Catalog section. Every other registry is always read from its stable branch.

```json
{
  "name": "My Registry",
  "plugins": [{
    "id": "my-plugin",
    "name": "My Plugin",
    "description": "..",
    "author": "you",
    "homepage": "https://github.com/you/my-plugin",
    "icon": "https://../icon.png",
    "scopes": ["storage", "network"],
    "versions": [{
      "version": "1.0.0",
      "matinee_min": "2.1.0",
      "source": "plugins/my-plugin/"
    }]
  }]
}
```

`description` and `scopes` are duplicated from the manifest so the catalog can render them before anything is installed. `validate.py` keeps the copies identical.

A version sets exactly one of `source` or `download`. Setting both, or neither, is rejected when the registry is fetched.

## `source`: install from the repository

`source` names a directory holding `manifest.json` and the file named by `manifest.main`. It is resolved **relative to the URL `registry.json` was fetched from**, so the same `registry.json` works unchanged on every branch that serves it. That is what makes the `dev` branch possible: test there, merge to `main` to publish. No zip, no checksum, no build artifacts committed.

Exactly three files are fetched: `manifest.json`, `manifest.main`, and the optional `manifest.icon`. A plugin that needs more must ship a zip.

There is no `sha256` for `source`, deliberately. The registry index and the source files come from the same origin, so a hash sitting beside the code it describes authenticates nothing that TLS does not already.

## `download`: install from a zip

```json
{ "version": "1.0.0", "matinee_min": "2.1.0", "download": "https://../my-plugin.zip", "sha256": "<sha256>" }
```

Use this when a plugin ships more than the three files above, or when the archive lives on a different origin than the registry. `sha256` is **required**. The server refuses to install a zip version without one, and rejects the archive when the hash does not match. Build the zip and print its hash with `scripts/package.sh`.

A relative `download` resolves against the registry URL, exactly like `source`. Prefer relative references, because an absolute URL pins one branch's artifact for every branch.

## Adding a registry to a server

The stock Matinee registry is built in, fixed and undeletable. Its Stable and Development choice sits on the Catalog section of the plugin settings. Admins add further registry URLs under Settings -> Plugins -> Registries, HTTPS only. Their plugins are merged into the same catalog with a one-click install, always read from the registry's stable branch. On install Matinee checks `matinee_min`, verifies the `sha256` for zips, and shows the requested scopes for approval.

When two registries list the same plugin id, **the stock registry always wins**. Among custom registries the one added first wins, regardless of version. To test the `dev` branch of this repository, switch the channel selector on the Catalog section to Development rather than adding a second registry alongside it. For a fork, change the plugin ids.
