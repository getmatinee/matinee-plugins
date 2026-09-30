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
  "scopes": ["storage", "network"],
  "config": [
    { "key": "api_key", "label": "API Key", "type": "password", "required": true },
    { "key": "interval", "label": "Sync interval (min)", "type": "number" }
  ]
}
```

- `id`: unique, kebab-case, and must match the registry id. Never change it after publishing, because installs are keyed by it.
- `matinee_min`: oldest compatible server version. Enforced twice: the catalog only offers compatible versions, and the server refuses to load an installed plugin whose manifest demands a newer server.
- `scopes`: the permissions the plugin requests. Admins see them at install. See [Scopes](#scopes).

### Config fields

`config` fields are rendered automatically in Settings -> Plugins -> Configure. Saving the config reloads the plugin, so `init` code re-runs with the new values.

| `type` | Renders as | Extra attributes |
|---|---|---|
| `text` | text input | |
| `password` | masked input, stored as-is | |
| `number` | numeric input | |
| `boolean` | checkbox | |
| `button` | button that POSTs a named hook | `action` (required): the hook name. The hook's JSON body may carry `message` (shown as a notice), `config` (values filled into the form, unsaved until Save) and `redirect` (an http, https or relative address the browser opens) |
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
- The callback is served at `GET /api/plugins/<id>/callback`, **unauthenticated** and rate-limited. It exists for OAuth redirects, so validate your own state nonce. A body it returns is served with `Content-Security-Policy: sandbox`, so the page renders without scripts and without access to the Matinee origin.
- `req` carries `method`, `path`, `query`, `headers`, `body`, plus `baseUrl` for the API origin, `webUrl` for the web app origin and `cookies`, the plugin's own callback cookies by name. `Authorization` and `Cookie` headers are stripped before the request reaches the plugin, and no other cookie is handed over.
- Return `{status, body, contentType}` or `{redirect}`. A redirect must be an http or https address or a path, and any other scheme fails the call. A hook that runs while the plugin is wedged returns 503 to the caller.
- A callback answer may add `cookies: [{name, value, maxAge}]`, at most four, to bind a sign-in to the browser that started it. The server sets them HttpOnly, SameSite=Lax and, on https, Secure, under a name only this plugin reads, and the browser sends them back only to this plugin's URLs. A name is 1 to 32 letters, digits or underscores, a value at most 1024 characters without spaces, quotes, commas or semicolons. A negative `maxAge` deletes the cookie. Named hooks cannot set cookies.

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
| `matinee.crypto.randomToken(bytes?)` / `.sha256(text, 'hex' \| 'base64url')` / `.base64(text, 'std' \| 'url')` / `.base64Decode(text)` | - | OAuth state, PKCE and header encoding from the server's standard library. `randomToken` answers unpadded base64url of 32 random bytes by default, `base64Decode` reads either alphabet with or without padding |
| `matinee.playlists.*`, `matinee.music.*` | `playlists` | playlist sync surface, see below |
| `matinee.users.*`, `matinee.media.*`, `matinee.watch.*` | `watch-states` | watch-state migration surface, see below |
| `matinee.registerMetadataProvider(def)` | `metadata-providers` | metadata extension point |
| `matinee.registerScanner(def)` | `scanners` | filename-parser extension point |
| `matinee.auth.registerProvider(def)` / `.issueTicket(identity)` | `auth` | sign-in provider surface, see below |
| `matinee.ldap.connect(opts)` / `.escapeFilter(s)` / `.escapeDN(s)` | `ldap` | LDAP connections for sign-in plugins, see below |

### Scopes

Canonical scopes: `storage`, `network`, `playlists`, `watch-states`, `metadata-providers`, `scanners`, `auth`, `ldap`.

Scopes are shown to the admin at install time, and the server enforces them. The admin approves the scopes the registry entry lists, so the `scopes` of `manifest.json` must not name one the registry entry leaves out, and a scope the server does not know makes the install fail. An update whose registry entry lists more scopes than the admin approved asks the admin again.

- `network`: without it, `matinee.http.fetch` throws.
- `playlists`: without it, `matinee.playlists` and `matinee.music` do not exist.
- `watch-states`: without it, `matinee.users`, `matinee.media` and `matinee.watch` do not exist.
- `storage`: without it, `matinee.storage` does not exist.
- `metadata-providers`: without it, `matinee.registerMetadataProvider` does not exist.
- `scanners`: without it, `matinee.registerScanner` does not exist.
- `auth`: without it, `matinee.auth` does not exist.
- `ldap`: without it, `matinee.ldap` does not exist.

A plugin that registers a scanner replaces how filenames are parsed for every library whose scanner setting selects it, and a plugin with `auth` decides who may sign in, so those two are the widest scopes an admin can grant. They are deliberately separate from `metadata-providers`, since adding a metadata source is a much smaller request.

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

These three are the only events the server emits today. Subscribing to any other name never fires. Handlers run on the plugin's own single thread, in emit order, so a counter incremented on `media.added` has seen every delivered event by the time `scan.completed` arrives. A plugin whose queue is full while the server emits misses that event, so treat the count as a report, not as an inventory.

`media.added` fires once per new top-level item, a film, a series, a music album or an audiobook, thousands of times during a first scan. Do not log from it. Count in the handler and report once on `scan.completed`, the way `hello-world` does.

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

**Playlist sync** (scope `playlists`): everything a sync plugin such as Spotify needs. Tracks that exist locally are added as regular entries. Tracks that do not are recorded as **ghost tracks** and shown greyed-out as "Not available" with artist and album in the playlist. The `(source, external_id)` pair makes `addGhostTrack` idempotent across re-syncs. After every music scan the server matches all ghost tracks again and turns the ones it now finds into regular entries at their position, and a file that disappears leaves its playlist entries behind as ghost tracks.

```js
matinee.playlists.list()                        // [{id, name, owner_username, track_count}]
matinee.playlists.get(id)                       // {id, name, tracks, ghost_tracks}
matinee.playlists.create(ownerUsername, name)   // returns id (existing one if the name is taken)
matinee.playlists.addTrack(playlistId, mediaFileId, {source, external_id, position})
matinee.playlists.reconcileTracks(playlistId, source, seenExternalIds) // returns removed count
matinee.playlists.removeTrack(playlistId, mediaFileId)
matinee.playlists.addGhostTrack(playlistId, {title, artist, album, source, external_id, position, duration_ms, isrc})
matinee.playlists.removeGhostTrack(ghostId)
matinee.playlists.clearGhostTracks(playlistId, source)
matinee.music.matchTrack({title, artists, album, duration_ms, isrc, username}) // {media_file_id} or null
matinee.music.searchTracks({title, artist, username}) // [{media_file_id, title, album, artist, library_id}]
```

`addTrack`'s third argument is optional. Called without it, the track is appended at the end and a duplicate is ignored. A sync that passes `source`, `external_id` and the upstream `position` gets upsert semantics instead: the row keeps following the external track, a re-sync updates its position, and the same external id resolving to a different local file replaces the old row. After a full pass, `reconcileTracks` drops the source's rows whose external id was not seen this time. Rows without a source are user-added, and neither call ever touches them.

`matchTrack` answers the one local file the track names, or `null`. A file with the same ISRC wins outright. Otherwise the title has to match after its markers are taken off, and a marker that names a different recording, such as "(Live)", "(Instrumental)" or "(Remix)", has to be present on both sides, while "(Remastered 2011)" or "(Radio Edit)" count for nothing. One of the `artists` has to agree with the file's artist or, when the file has none, with the album artist, and a duration more than 15 seconds off rejects the file. Among the files that pass, the closest duration ranks first, then the exact album, then the shortest title. A ghost track stored with `duration_ms` and `isrc` is matched by the same rules after every music scan. Pass the playlist owner as `username` so only that user's libraries are searched.

`searchTracks` accepts an object or a bare title string and lists files whose title or artist contains the query, exact titles first and then the ones whose artist contains `artist`. It is meant for plugins that let a person choose from the list, not for matching. Pass the playlist owner as `username` and the search honors that user's library grants. Leaving it out searches every library, admins included.

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

**Sign-in provider** (scope `auth`): lets a directory or an identity provider sign users in. A user the provider vouches for gets a Matinee account on first sign-in, a local account with the same username is linked to the provider identity and loses its local password, and linked accounts cannot change or reset a password in Matinee. While any provider is registered, self-registration and password reset are switched off server-wide. One password provider and one redirect provider may run at a time.

A **password provider** checks the login form's credentials:

```js
matinee.auth.registerProvider({
  name: 'Active Directory',
  authenticate: function (username, password) {
    // return { id, username, email?, first_name?, last_name?, admin? }
    // return null   when the directory does not know the username
    // return false  when the directory refused the password
    // throw         when the directory could not be asked
  },
})
```

`id` is the stable identifier the account stays linked to, such as an objectGUID or a subject claim, and `username` becomes the Matinee username. `admin` set to a boolean puts the account's administrator flag under the directory's control on every sign-in, with the last administrator never demoted. Left out, the flag stays as Matinee has it. A `null` verdict lets the server fall back to a local account of that name, which is how clients without the login page's local-account switch still reach one, so answer `false` rather than `null` whenever the directory knew the name.

A **redirect provider** signs in through the browser instead. The login page sends the browser to `GET /api/plugins/<id>/callback?start=1`, and the plugin's callback handles both that start and the provider's return:

```js
matinee.auth.registerProvider({ name: 'Keycloak', redirect: true })
matinee.http.onCallback(function (req) {
  if (req.query.start) return { redirect: authorizationUrl(req) }
  var identity = exchangeCode(req.query.code, req.query.state)
  var ticket = matinee.auth.issueTicket(identity)
  return { redirect: req.webUrl + '/login?sso_ticket=' + ticket }
})
```

`issueTicket` takes the same identity shape and returns a one-time ticket the login page trades for a session within two minutes. Send a failure back as `/login?sso_error=<message>` and the page shows it. Validate your own state nonce, because the callback is public.

**LDAP** (scope `ldap`): connections to a directory, which the JavaScript runtime cannot open itself. `connect` binds and returns a connection, or `null` when the directory refused the credentials, and throws when it could not be reached. A DN with an empty password is refused without asking the directory, since that would be an unauthenticated bind.

```js
var conn = matinee.ldap.connect({
  url: 'ldaps://dc1.example.com:636',
  bindDn: 'CN=svc,DC=example,DC=com',   // empty for anonymous bind
  password: '...',
  insecure: false,
  startTls: false,
})
if (conn) {
  var entries = conn.search({
    baseDn: 'DC=example,DC=com',
    filter: '(sAMAccountName=' + matinee.ldap.escapeFilter(username) + ')',
    attributes: ['objectGUID', 'mail', 'memberOf'],
    scope: 'sub',                       // sub, one or base
    sizeLimit: 2,                       // at most 500
  })
  // entries: [{ dn, attributes: { name: [values] } }]
  conn.close()
}
```

Attribute values that are not valid UTF-8, such as an objectGUID, arrive as lowercase hex. A plugin may hold four connections at a time and has to close them, though an unload closes whatever is left. Connections time out after ten seconds, and the address blocks of `matinee.http.fetch` apply.

## Lifecycle

- **Install**: the admin picks the plugin in the catalog and approves its scopes. The server stages the files, validates the manifest, atomically swaps them into place and starts the plugin.
- **Enable / disable**: starts or stops the plugin's VM. State in `matinee.storage` survives.
- **Config save**: reloads the plugin with a fresh VM, so the entrypoint re-runs.
- **Update**: same as install. The catalog offers it when the registry lists a newer version than the installed one.
- **Uninstall**: stops the plugin, deletes its directory and its storage.

Because a reload restarts the VM, keep durable state in `matinee.storage`, not in module globals.

## Publishing

See [registry.md](registry.md) for the registry format and the repository's [README](../README.md) for the dev -> main contribution workflow.
