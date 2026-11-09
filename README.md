# matinee-plugins

Official community plugin registry for [Matinee](https://github.com/getmatinee/matinee). Matinee servers consume the raw registry file:

```
https://raw.githubusercontent.com/getmatinee/matinee-plugins/main/registry.json
```

Every Matinee server ships with this repository preconfigured as the default registry. Documentation for plugin authors lives in [docs/plugin-api.md](docs/plugin-api.md) for the host API, manifest and config schema, and in [docs/registry.md](docs/registry.md) for the registry format.

## Repository layout

```
registry.json          the index Matinee reads (name, plugins, versions)
plugins/<id>/          one folder per plugin (manifest.json + main.js + README.md)
docs/                  plugin developer documentation
template-ts/           TypeScript starter for new plugins
scripts/validate.py    checks registry.json against the manifests (runs in CI)
scripts/gojacheck/     compiles every entrypoint with goja, the server's JavaScript engine (runs in CI)
scripts/package.sh     builds a release zip, for plugins that need one
```

## Branches and release channels

`main` is the **stable** channel, what every Matinee server reads by default. `dev` is the **development** channel and the default branch of this repository, where changes and new plugins are tested. Publishing a plugin is merging `dev` into `main`.

In Matinee, admins switch this registry between the two channels with the "Release channel" selector of the Catalog section under Server settings -> Plugins, where Stable is `main` and Development is `dev`. The choice applies only to the stock Matinee registry, which is built in and cannot be removed. Custom registries are always read from their stable branch.

This works because a version's `source` is relative, so it resolves against whichever branch served the `registry.json` that named it:

```
main/registry.json + source "plugins/hello-world/"
  -> .../matinee-plugins/main/plugins/hello-world/

dev/registry.json  + the same source
  -> .../matinee-plugins/dev/plugins/hello-world/
```

To run a private variant of a plugin, fork this repository, change the plugin ids, and add your fork as an additional registry. A fork is always read from its stable branch, so publish on `main`. Two registries listing the same id do not mix. The stock registry always wins, and among custom registries the one added first does, no matter how high the other's version is.

## Publishing a new plugin version

1. Bump `version` in `plugins/<id>/manifest.json`.
2. Update the version entry in `registry.json`:

   ```json
   { "version": "1.0.1", "matinee_min": "2.1.0", "source": "plugins/<id>/" }
   ```

3. From the repository root, run `python3 scripts/validate.py` and `node --test "plugins/**/*.test.js"`. The first prints `registry.json and every plugin manifest agree` and the second reports every test as passed. A plugin's tests live next to it as `*.test.js` files, which never ship in the installed plugin.
4. From `scripts/gojacheck`, run `go run . ../../plugins/*/main.js`, which needs Go and prints `ok:` for every entrypoint that goja, the server's JavaScript engine, compiles. CI runs all three checks.
5. Open a pull request against `dev`.

Servers only see a change once the version is bumped in **both** files. Editing a plugin without a bump does not roll out. A registry entry and its `plugins/<id>/` directory must be merged `dev` -> `main` together.

### The three-file rule

A source install fetches exactly three files: `manifest.json`, the entrypoint named by `manifest.json`, and the optional `manifest.icon`. The server runs only the entrypoint and has no module loader, so a plugin is one JavaScript file. The TypeScript template bundles to a single `main.js`.

A plugin whose built `main.js` is not committed, or whose archive lives on another origin, uses `download` plus `sha256` in place of `source`. `scripts/package.sh plugins/<id>` builds that zip from the same three files, runs `npm run build` first when the plugin has a `package.json`, writes `dist/<id>-<version>.zip` and prints its sha256. The checksum is mandatory for zips.

A version sets exactly one of `source` or `download`. Setting both, or neither, is rejected.

## Contributing

Open a PR against `dev` adding `plugins/<your-id>/` and a `registry.json` entry. Rules:

- `id` is kebab-case and unique, and the manifest `id` must match the registry id. Never rename a published id or move a published `plugins/<id>/` directory, because installs are keyed by id and source installs fetch exact paths.
- `name`, `author`, `description`, `homepage`, `scopes` and `matinee_min` must match between `registry.json` and the manifest. The catalog renders them before a plugin is installed, which is why they are duplicated.
- Declare plugin `scopes`. The allowed values are `storage`, `network`, `metadata-providers`, `scanners`, `watch-states`, `playlists`, `auth` and `ldap`. Admins approve them at every install and update, the server enforces every one of them, and it refuses a plugin that asks for any other scope.
- Set `matinee_min` to the oldest server version you tested against.
- ASCII only. No em-dashes, curly quotes, ellipses, arrows or bullets, in code, docs or user-facing strings.
- Text an admin reads follows the Matinee UI text rules. This covers manifest labels and descriptions, button and status answers, activity titles and messages, and log lines. A failure reads "Could not ...", never "Failed to", "Unable to" or "Please". A count takes the plural it needs, never `(s)`. A full sentence ends with a period, a label or fragment does not, and a UI name is quoted with straight double quotes. Manifest texts use no semicolons, no " - " or " / " connectors and no "&".
- A plugin logs through `matinee.log()`, which reaches the server log. Do not log once per media item, because `media.added` fires thousands of times during a scan. Count, and report once on `scan.completed`, the way `hello-world` does.
- Use `matinee.debug()` for page or progress detail, which is only shown while the server's debug logging toggle is on, and `matinee.log()` for phase summaries. The host logs every `matinee.http.fetch` at debug level automatically, so do not log your own HTTP calls.

`scripts/validate.py` enforces the manifest rules, the typography rule and the mechanical part of the UI text rules, and runs in CI on every PR.

## Support the project

Matinee is free software. You can support its maintenance through [GitHub Sponsors](https://github.com/sponsors/getmatinee) or [Ko-fi](https://ko-fi.com/matinee). Building the apps from source and the TV app are free of charge. See [Support the project](https://github.com/getmatinee/matinee/blob/main/README.md#support-the-project).

## License

AGPL-3.0-or-later, for the registry tooling and the official plugins alike.
