# matinee-plugins

Official community plugin registry for [Matinee](https://github.com/getmatinee/matinee).
Matinee servers consume the raw registry file:

```
https://raw.githubusercontent.com/getmatinee/matinee-plugins/main/registry.json
```

Every Matinee server ships with this repository preconfigured as the default
registry. Documentation for plugin authors lives in
[docs/plugin-api.md](docs/plugin-api.md) (host API, manifest and config
schema) and [docs/registry.md](docs/registry.md) (registry format).

## Repository layout

```
registry.json          the index Matinee reads (name, plugins, versions)
plugins/<id>/          one folder per plugin (manifest.json + main.js + README.md)
docs/                  plugin developer documentation
template-ts/           TypeScript starter for new plugins
scripts/validate.py    checks registry.json against the manifests (runs in CI)
scripts/package.sh     builds a release zip, for plugins that need one
```

## Branches and release channels

`main` is the **stable** channel: what every Matinee server reads by
default. `dev` is the **development** channel: where changes and new plugins
are tested. Publishing a plugin is merging `dev` into `main`.

In Matinee, admins can switch the default registry between the two channels
under Settings -> Plugins -> Registries (Stable -> `main`, Development ->
`dev`). The selector exists only on the default Matinee registry; custom
registries are read as-is.

This works because a version's `source` is relative, so it resolves against
whichever branch served the `registry.json` that named it:

```
main/registry.json + source "plugins/hello-world/"
  -> .../matinee-plugins/main/plugins/hello-world/

dev/registry.json  + the same source
  -> .../matinee-plugins/dev/plugins/hello-world/
```

To run a private variant of a plugin, fork this repository, change the plugin
ids, and add your fork as an additional registry. Two registries listing the
same id do not mix: the registry added first wins, no matter how high the
other's version is.

## Publishing a new plugin version

1. Bump `version` in `plugins/<id>/manifest.json`.
2. Update the version entry in `registry.json`:

   ```json
   { "version": "1.0.1", "matinee_min": "2.1.0", "source": "plugins/<id>/" }
   ```

3. Run `python3 scripts/validate.py`.
4. Open a pull request against `dev`.

Servers only see a change once the version is bumped in **both** files;
editing a plugin without a bump does not roll out. A registry entry and its
`plugins/<id>/` directory must be merged `dev` -> `main` together.

### The three-file rule

A source install fetches exactly three files: `manifest.json`, the entrypoint
named by `manifest.json`, and the optional `manifest.icon`. A plugin that
needs to ship more must build a zip with `scripts/package.sh` and use
`download` plus `sha256` in place of `source` (the checksum is mandatory for
zips). The TypeScript template bundles to a single `main.js`, so this rarely
comes up.

A version sets exactly one of `source` or `download`; setting both, or
neither, is rejected.

## Contributing

Open a PR against `dev` adding `plugins/<your-id>/` and a `registry.json`
entry. Rules:

- `id` is kebab-case and unique; the manifest `id` must match the registry
  id. Never rename a published id or move a published `plugins/<id>/`
  directory: installs are keyed by id and source installs fetch exact paths.
- `name`, `author`, `description`, `capabilities`, `scopes` and `matinee_min`
  must match between `registry.json` and the manifest. The catalog renders
  them before a plugin is installed, which is why they are duplicated.
- Declare honest `scopes`: admins approve them at install, and the server
  enforces `network`, `playlists` and `watch-states`.
- Set `matinee_min` to the oldest server version you tested against.
- ASCII only. No em-dashes, curly quotes, ellipses, arrows or bullets, in
  code, docs or user-facing strings.
- A plugin logs through `matinee.log()`, which reaches the server log. Do not
  log once per media item: `media.added` fires thousands of times during a
  scan. Count, and report once on `scan.completed`, the way `hello-world`
  does.

`scripts/validate.py` enforces the manifest rules and the typography rule,
and runs in CI on every PR.
