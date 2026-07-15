# Writing Matinee plugins

Matinee plugins are small JavaScript programs that run inside the server in an
isolated runtime (one VM and one executor thread per plugin). They have **no
ambient authority**: no filesystem, no process access, their entire world is
the `matinee` host object documented below.

Plugins are installed, enabled, disabled, configured and removed live; no
server restart is ever needed.

## Anatomy

A plugin is a directory (or a zip archive) containing at least:

```
manifest.json   required: id, name, version, entrypoint, config schema
main.js         the entrypoint (name configurable via manifest "main")
```

A source install fetches exactly three files: `manifest.json`, the entrypoint,
and the optional `manifest.icon`. A plugin that needs more files must ship a
zip (see [registry.md](registry.md)).

### manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does.",
  "author": "you",
  "homepage": "https://github.com/you/my-plugin",
  "main": "main.js",
  "matinee_min": "2.1.0",
  "capabilities": ["events"],
  "scopes": ["storage", "network"],
  "config": [
    { "key": "api_key", "label": "API Key", "type": "password", "required": true },
    { "key": "interval", "label": "Sync interval (min)", "type": "number" }
  ]
}
```

- `id`: unique, kebab-case; must match the registry id. Never change it after
  publishing; installs are keyed by it.
- `matinee_min`: oldest compatible server version. Enforced twice: the catalog
  only offers compatible versions, and the server refuses to load an installed
  plugin whose manifest demands a newer server.
- `capabilities`: catalog badges describing what the plugin does. Canonical
  values: `events`, `migration`, `playlists`, `oauth`, `metadata_provider`,
  `scanner`.
- `scopes`: the permissions the plugin requests; admins see them at install.
  See [Scopes](#scopes).

### Config fields

`config` fields are rendered automatically in Settings -> Plugins ->
Configure. Saving the config reloads the plugin, so `init` code re-runs with
the new values.

| `type` | Renders as | Extra attributes |
|---|---|---|
| `text` | text input | |
| `password` | masked input, stored as-is | |
| `number` | numeric input | |
| `boolean` | checkbox | |
| `button` | button that POSTs a named hook | `action` (required): the hook name |
| `multiselect` | checkbox list loaded from a hook | `options_hook` (required): hook returning `[{value, label}]` |
| `info` | read-only status text from a hook | `status_hook` (required): hook returning `{text}` or a string body |

All types accept `key` (required), `label` (required), `required`,
`description`. Keys starting with `_` are conventionally hook-only rows that
store no value (`_status`, `_run`).

The three hook attributes wire config rows to `matinee.http.onRequest`
handlers (below). Hook-driven rows only work while the plugin is running.

## Inbound HTTP: hooks and the OAuth callback

```js
matinee.http.onRequest('run', function (req) {
  return { status: 200, body: JSON.stringify({ ok: true }), contentType: 'application/json' }
})
matinee.http.onCallback(function (req) {
  return { redirect: req.webUrl + '/settings/plugins' }
})
```

- Named hooks are served at `POST/GET /api/plugins/<id>/hook/<name>`,
  **admin-authenticated**. They power `button` (`action`), `multiselect`
  (`options_hook`) and `info` (`status_hook`) rows.
- The callback is served at `GET /api/plugins/<id>/callback`,
  **unauthenticated** (rate-limited). It exists for OAuth redirects; validate
  your own state nonce.
- `req` carries `method`, `path`, `query`, `headers`, `body`, plus `baseUrl`
  (the API origin) and `webUrl` (the web app origin). `Authorization` and
  `Cookie` headers are stripped before the request reaches the plugin.
- Return `{status, body, contentType}` or `{redirect}`. A hook that runs
  while the plugin is wedged returns 503 to the caller.

## The `matinee` host API (v1)

| Call | Scope | Description |
|---|---|---|
| `matinee.manifest` | - | your parsed manifest |
| `matinee.version` | - | host API version (currently `1`) |
| `matinee.getConfig()` | - | admin-entered config values |
| `matinee.log(...args)` | - | log to the plugin's log ring (visible in the UI) and the server log |
| `matinee.debug(...args)` | - | verbose logging; dropped unless the server's debug logging toggle is on |
| `matinee.storage.get(key)` / `.set(key, value)` / `.delete(key)` | - | persistent per-plugin key/value store (strings; JSON-encode objects) |
| `matinee.on(event, handler)` | - | subscribe to server events |
| `matinee.schedule(everyMinutes, fn)` | - | recurring task; first run one interval after load; minimum 1 minute |
| `matinee.http.onRequest(name, fn)` / `.onCallback(fn)` | - | inbound hooks, see above |
| `matinee.http.fetch(url, {method, headers, body})` | `network` | outbound HTTP(S); returns `{status, headers, body}` |
| `matinee.playlists.*`, `matinee.music.*` | `playlists` | playlist sync surface, see below |
| `matinee.users.*`, `matinee.media.*`, `matinee.watch.*` | `watch-states` | watch-state migration surface, see below |
| `matinee.registerMetadataProvider(def)` | - | metadata extension point |
| `matinee.registerScanner(def)` | - | filename-parser extension point |

### Scopes

Canonical scopes: `storage`, `network`, `playlists`, `watch-states`.

Scopes are shown to the admin at install time, and the server enforces them:

- `network`: without it, `matinee.http.fetch` throws.
- `playlists`: without it, `matinee.playlists` and `matinee.music` do not
  exist.
- `watch-states`: without it, `matinee.users`, `matinee.media` and
  `matinee.watch` do not exist.
- `storage`: declare it when you persist data; `matinee.storage` is currently
  available regardless, but declare what you use.

### Debug logging

`matinee.log` is for phase summaries (started, per-user result, completed);
use `matinee.debug` for page/progress detail. Debug lines only exist while
the admin has Settings -> Server -> Debug logging enabled (toggling applies
instantly, no reload); while it is off they are dropped, not buffered, so
enable debug before starting a run.

The host also logs every `matinee.http.fetch` at debug level automatically,
with method, endpoint (query string stripped), status and duration.
Plugins do not need to log their own HTTP calls.

### Limits

- Any single entry point (init, event handler, schedule, hook) is interrupted
  after **60 seconds**. Split long work into schedule ticks or cursor state.
- `matinee.http.fetch`: 30 second timeout, 10 MB response cap, http(s) only.
  Link-local and cloud-metadata addresses (169.254.0.0/16, fe80::/10) are
  blocked at connect time; private LAN addresses are allowed.
- The per-plugin job queue holds 64 pending calls; events beyond that are
  dropped rather than blocking the server.

### Events

| Event | Payload |
|---|---|
| `media.added` | `{media_id, title, media_type, library_id, library_name}` |
| `scan.completed` | `{job_id, job_type, library_id, library_name, status}` |
| `job.completed` | same as above, fired for every job type |

These three are the only events the server emits today; subscribing to any
other name never fires. Handlers run on the plugin's own single thread, in
emit order, so a counter incremented on `media.added` is complete by the time
`scan.completed` arrives.

`media.added` fires once per new item, thousands of times during a first
scan. Do not log from it. Count in the handler and report once on
`scan.completed`, the way `hello-world` does.

### Extension points

**Metadata provider**: participates in the global and per-library provider
priority exactly like TMDB/TVDB, and is offered in the manual-match dialog:

```js
matinee.registerMetadataProvider({
  id: 'anidb',                       // unique; built-in names are reserved
  mediaTypes: ['movie', 'tv_series'],// default: both
  search: function (query, year, mediaType) {
    // return [{id, title, year?, release_date?, overview?, poster_url?, backdrop_url?}]
  },
  details: function (id, mediaType) {
    // movies: {id, title, overview?, release_date?, poster_url?, backdrop_url?,
    //          genres?, rating?, rating_votes?, runtime?, imdb_id?}
    // tv:     same but `name` and `first_air_date`
  },
})
```

**Playlist sync** (scope `playlists`): everything a sync plugin (e.g.
Spotify) needs. Tracks that exist locally are added as regular entries;
tracks that don't are recorded as **ghost tracks** and shown greyed-out
("Not available") with artist/album in the playlist. `(source, external_id)`
makes `addGhostTrack` idempotent across re-syncs.

```js
matinee.playlists.list()                        // [{id, name, owner_username, track_count}]
matinee.playlists.get(id)                       // {id, name, tracks, ghost_tracks}
matinee.playlists.create(ownerUsername, name)   // returns id (existing one if the name is taken)
matinee.playlists.addTrack(playlistId, mediaFileId)
matinee.playlists.removeTrack(playlistId, mediaFileId)
matinee.playlists.addGhostTrack(playlistId, {title, artist, album, source, external_id, position})
matinee.playlists.removeGhostTrack(ghostId)
matinee.playlists.clearGhostTracks(playlistId, source)
matinee.music.searchTracks(query)               // [{media_file_id, title, album, library_id}]
```

**Watch states** (scope `watch-states`): read users and per-user watch
progress, resolve media by provider id, and write watched flags / resume
positions. Used by the Emby and Plex migration plugins.

```js
matinee.users.list()                            // [{id, username}]
matinee.media.findByProviderIds({               // -> [media_file_id]
  type: 'movie',                                // or 'episode'
  tmdb, imdb, tvdb,                             // any provider id you have
  season, episode,                              // episode only
})
matinee.watch.getStates(userId)                 // [{media_file_id, watched, position_seconds, last_played_at?}]
matinee.watch.setState(userId, mediaFileId, {   // merge: only the fields you pass change
  watched, positionSeconds, lastPlayedAt,       // lastPlayedAt is RFC3339
})
```

**Scanner (filename parser)**: selectable per library in the library edit
dialog; overrides how filenames are parsed (e.g. anime release naming).
Return `null` to fall back to the default parsing. The season is still
derived from the folder structure; loose files stay in season 1.

```js
matinee.registerScanner({
  id: 'anime-scanner',
  parseMovie: function (path) { return { title: 'Title', year: 2020 } },
  parseEpisode: function (path) { return { episode: 7, title: 'Optional' } },
})
```

## Lifecycle

- **Install**: the admin picks the plugin in the catalog, approves its
  scopes; the server stages the files, validates the manifest, atomically
  swaps them into place and starts the plugin.
- **Enable / disable**: starts or stops the plugin's VM; state in
  `matinee.storage` survives.
- **Config save**: reloads the plugin (fresh VM, entrypoint re-runs).
- **Update**: same as install; the catalog offers it when the registry lists
  a different version than the installed one.
- **Uninstall**: stops the plugin, deletes its directory and its storage.

Because a reload restarts the VM, keep durable state in `matinee.storage`,
not in module globals.

## Publishing

See [registry.md](registry.md) for the registry format and the repository's
[README](../README.md) for the dev -> main contribution workflow.
