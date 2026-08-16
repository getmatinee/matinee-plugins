# Writing Matinee plugins

Matinee plugins are small JavaScript programs that run inside the server in an isolated runtime, one VM and one executor thread per plugin. They have **no ambient authority**: no filesystem, no process access, their entire world is the `matinee` host object documented below.

Plugins are installed, enabled, disabled, configured and removed live. No server restart is ever needed.

## Anatomy

A plugin is a directory, or a zip archive, containing at least:

```
manifest.json   required: id, name, version, entrypoint, config schema
main.js         the entrypoint (name configurable via manifest "main")
```

A source install fetches exactly three files: `manifest.json`, the entrypoint, and the optional `manifest.icon`. A plugin that needs more files must ship a zip, described in [registry.md](registry.md).

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

- `id`: unique, kebab-case, and must match the registry id. Never change it after publishing, because installs are keyed by it.
- `matinee_min`: oldest compatible server version. Enforced twice: the catalog only offers compatible versions, and the server refuses to load an installed plugin whose manifest demands a newer server.
- `capabilities`: catalog badges describing what the plugin does. Canonical values are `events`, `migration`, `playlists`, `oauth`, `metadata_provider` and `scanner`.
- `scopes`: the permissions the plugin requests. Admins see them at install. See [Scopes](#scopes).

### Config fields

`config` fields are rendered automatically in Settings -> Plugins -> Configure. Saving the config reloads the plugin, so `init` code re-runs with the new values.

| `type` | Renders as | Extra attributes |
|---|---|---|
| `text` | text input | |
| `password` | masked input, stored as-is | |
| `number` | numeric input | |
| `boolean` | checkbox | |
| `button` | button that POSTs a named hook | `action` (required): the hook name |
| `multiselect` | checkbox list loaded from a hook | `options_hook` (required): hook returning `{options: [{value, label}]}` |
| `info` | read-only status text from a hook, polled while the modal is open | `status_hook` (required): hook returning `{text, busy?, progress?, hide?}` |
| `usermatch` | two-column matcher: drag local users onto remote rows | `options_hook` (required), see below |

All types accept `key` (required), `label` (required), `required`, `description`. Keys starting with `_` are conventionally hook-only rows that store no value, such as `_status` and `_run`.

The three hook attributes wire config rows to `matinee.http.onRequest` handlers, documented below. Hook-driven rows only work while the plugin is running.

`info` responses report live state from a long-running job. `busy: true` makes the UI show a spinner and keep polling every few seconds, and `progress: 0-100` renders a progress bar. A response may also set `hide: ["key", ...]` to hide other config fields by key while the plugin is running, for example to hide a manual-token fallback once an OAuth link succeeds. The list is re-evaluated on every poll.

`usermatch` renders one row per remote user with a drop zone. The admin drags a Matinee user chip onto a row, or picks it from the row's select, to match the pair. Its `options_hook` returns:

```json
{
  "remote": [{ "value": "remote-id", "label": "john",
               "disabled": true, "note": "why this row cannot be matched" }],
  "local": [{ "value": "matinee-user-id", "label": "johnny" }],
  "suggested": { "remote-id": "matinee-user-id" }
}
```

The field stores `{ "remote-id": "matinee-user-id" }` under its config key. An empty or absent value means the admin never touched the matcher, so treat that as "use the suggested matches". Once the admin changes anything, the whole mapping is saved explicitly.

## Inbound HTTP: hooks and the OAuth callback

```js
matinee.http.onRequest('run', function (req) {
  return { status: 200, body: JSON.stringify({ ok: true }), contentType: 'application/json' }
})
matinee.http.onCallback(function (req) {
  return { redirect: req.webUrl + '/settings/plugins' }
})
```

- Named hooks are served at `POST/GET /api/plugins/<id>/hook/<name>`, **admin-authenticated**. They power `button` (`action`), `multiselect` (`options_hook`) and `info` (`status_hook`) rows.
- The callback is served at `GET /api/plugins/<id>/callback`, **unauthenticated** and rate-limited. It exists for OAuth redirects, so validate your own state nonce.
- `req` carries `method`, `path`, `query`, `headers`, `body`, plus `baseUrl` for the API origin and `webUrl` for the web app origin. `Authorization` and `Cookie` headers are stripped before the request reaches the plugin.
- Return `{status, body, contentType}` or `{redirect}`. A hook that runs while the plugin is wedged returns 503 to the caller.

## The `matinee` host API (v1)

| Call | Scope | Description |
|---|---|---|
| `matinee.manifest` | - | your parsed manifest |
| `matinee.version` | - | host API version (currently `1`) |
| `matinee.getConfig()` | - | admin-entered config values |
| `matinee.log(...args)` | - | log to the plugin's log ring (visible in the UI) and the server log |
| `matinee.debug(...args)` | - | verbose logging; dropped unless the server's debug logging toggle is on |
| `matinee.storage.get(key)` / `.set(key, value)` / `.delete(key)` | `storage` | persistent per-plugin key/value store (strings; JSON-encode objects) |
| `matinee.activity({key, title, progress?, done?, message?})` | - | report a running task to the Activities dropdown, see below |
| `matinee.on(event, handler)` | - | subscribe to server events |
| `matinee.schedule(everyMinutes, fn)` | - | recurring task; first run one interval after load; minimum 1 minute |
| `matinee.http.onRequest(name, fn)` / `.onCallback(fn)` | - | inbound hooks, see above |
| `matinee.http.fetch(url, {method, headers, body, insecure})` | `network` | outbound HTTP(S); returns `{status, headers, body}` |
| `matinee.playlists.*`, `matinee.music.*` | `playlists` | playlist sync surface, see below |
| `matinee.users.*`, `matinee.media.*`, `matinee.watch.*` | `watch-states` | watch-state migration surface, see below |
| `matinee.registerMetadataProvider(def)` | `metadata-providers` | metadata extension point |
| `matinee.registerScanner(def)` | `scanners` | filename-parser extension point |

### Scopes

Canonical scopes: `storage`, `network`, `playlists`, `watch-states`, `metadata-providers`, `scanners`.

Scopes are shown to the admin at install time, and the server enforces them:

- `network`: without it, `matinee.http.fetch` throws.
- `playlists`: without it, `matinee.playlists` and `matinee.music` do not exist.
- `watch-states`: without it, `matinee.users`, `matinee.media` and `matinee.watch` do not exist.
- `storage`: without it, `matinee.storage` does not exist.
- `metadata-providers`: without it, `matinee.registerMetadataProvider` does not exist.
- `scanners`: without it, `matinee.registerScanner` does not exist.

A plugin that registers a scanner replaces how filenames are parsed for every library, so that scope is the widest one an admin can grant. It is deliberately separate from `metadata-providers`, since adding a metadata source is a much smaller request.

### Activities

Long-running work can appear in the web UI's Activities dropdown:

```js
matinee.activity({ key: 'migration', title: 'Migrating anna (1 of 2)', progress: 42 })
matinee.activity({ key: 'migration', done: true, message: 'Migration complete: 2 user(s)' })
```

Call it with the same `key` on every scheduler tick to keep the entry alive, because entries not refreshed for 5 minutes drop out automatically. `done: true` removes the entry, and a `message` alongside it is shown to admins as a success toast. `progress` is 0-100 and optional.

### Debug logging

`matinee.log` is for phase summaries such as started, per-user result and completed. Use `matinee.debug` for page and progress detail. Debug lines only exist while the admin has Settings -> Server -> Debug logging enabled. Toggling applies instantly and needs no reload. While it is off the lines are dropped, not buffered, so enable debug before starting a run.

The host also logs every `matinee.http.fetch` at debug level automatically, with method, endpoint with the query string stripped, status and duration. Plugins do not need to log their own HTTP calls.

### Limits

- Any single entry point (init, event handler, schedule, hook) is interrupted after **60 seconds**. Split long work into schedule ticks or cursor state.
- `matinee.http.fetch`: 30 second timeout, 10 MB response cap, http(s) only. Link-local and cloud-metadata addresses (169.254.0.0/16, fe80::/10) are blocked at connect time, while private LAN addresses are allowed. Pass `{ insecure: true }` to skip TLS certificate verification for that request, for example against a self-signed LAN media server. Use it only for the user's own configured server, never for public endpoints. The address blocks still apply.
- The per-plugin job queue holds 64 pending calls. Events beyond that are dropped rather than blocking the server.

### Events

| Event | Payload |
|---|---|
| `media.added` | `{media_id, title, media_type, library_id, library_name}` |
| `scan.completed` | `{job_id, job_type, library_id, library_name, status}` |
| `job.completed` | same as above, fired for every job type |

These three are the only events the server emits today. Subscribing to any other name never fires. Handlers run on the plugin's own single thread, in emit order, so a counter incremented on `media.added` is complete by the time `scan.completed` arrives.

`media.added` fires once per new item, thousands of times during a first scan. Do not log from it. Count in the handler and report once on `scan.completed`, the way `hello-world` does.

### Extension points

**Metadata provider**: participates in the global and per-library provider priority exactly like TMDB and TVDB, and is offered in the manual-match dialog:

```js
matinee.registerMetadataProvider({
  id: 'anidb',
  mediaTypes: ['movie', 'tv_series'],
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

**Playlist sync** (scope `playlists`): everything a sync plugin such as Spotify needs. Tracks that exist locally are added as regular entries. Tracks that do not are recorded as **ghost tracks** and shown greyed-out as "Not available" with artist and album in the playlist. The `(source, external_id)` pair makes `addGhostTrack` idempotent across re-syncs.

```js
matinee.playlists.list()                        // [{id, name, owner_username, track_count}]
matinee.playlists.get(id)                       // {id, name, tracks, ghost_tracks}
matinee.playlists.create(ownerUsername, name)   // returns id (existing one if the name is taken)
matinee.playlists.addTrack(playlistId, mediaFileId, {source, external_id, position})
matinee.playlists.reconcileTracks(playlistId, source, seenExternalIds) // returns removed count
matinee.playlists.removeTrack(playlistId, mediaFileId)
matinee.playlists.addGhostTrack(playlistId, {title, artist, album, source, external_id, position})
matinee.playlists.removeGhostTrack(ghostId)
matinee.playlists.clearGhostTracks(playlistId, source)
matinee.music.searchTracks({title, artist, username}) // [{media_file_id, title, album, artist, library_id}]
```

`addTrack`'s third argument is optional. Called without it, the track is appended at the end and a duplicate is ignored. A sync that passes `source`, `external_id` and the upstream `position` gets upsert semantics instead: the row keeps following the external track, a re-sync updates its position, and the same external id resolving to a different local file replaces the old row. After a full pass, `reconcileTracks` drops the source's rows whose external id was not seen this time. Rows without a source are user-added, and neither call ever touches them.

`searchTracks` accepts an object or a bare title string. Matching is normalized on both sides, lower case with punctuation collapsed to spaces, so a title like "Don't Stop Me Now" is found from its cleaned form. Results rank exact title matches first, then artist agreement. Pass the playlist owner as `username` and the search honors that user's library grants. Leaving it out searches every library, admins included.

**Watch states** (scope `watch-states`): read users and per-user watch progress, resolve media by provider id, and write watched flags and resume positions. Used by the Emby and Plex migration plugins.

```js
matinee.users.list()                            // [{id, username}]
matinee.media.findByProviderIds({               // -> [media_file_id]
  type: 'movie',                                // or 'episode'
  tmdb, imdb, tvdb,
  season, episode,
})
matinee.watch.getStates(userId)                 // [{media_file_id, watched, position_seconds, last_played_at?}]
matinee.watch.setState(userId, mediaFileId, {
  watched, positionSeconds, lastPlayedAt,
})
```

**Scanner (filename parser)**: selectable per library in the library edit dialog, overriding how filenames are parsed, for example for anime release naming. Return `null` to fall back to the default parsing. The season is still derived from the folder structure, and loose files stay in season 1.

```js
matinee.registerScanner({
  id: 'anime-scanner',
  parseMovie: function (path) { return { title: 'Title', year: 2020 } },
  parseEpisode: function (path) { return { episode: 7, title: 'Optional' } },
})
```

## Lifecycle

- **Install**: the admin picks the plugin in the catalog and approves its scopes. The server stages the files, validates the manifest, atomically swaps them into place and starts the plugin.
- **Enable / disable**: starts or stops the plugin's VM. State in `matinee.storage` survives.
- **Config save**: reloads the plugin with a fresh VM, so the entrypoint re-runs.
- **Update**: same as install. The catalog offers it when the registry lists a different version than the installed one.
- **Uninstall**: stops the plugin, deletes its directory and its storage.

Because a reload restarts the VM, keep durable state in `matinee.storage`, not in module globals.

## Publishing

See [registry.md](registry.md) for the registry format and the repository's [README](../README.md) for the dev -> main contribution workflow.
