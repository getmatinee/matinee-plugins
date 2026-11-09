# Writing Matinee plugins

Matinee plugins are small JavaScript programs that run inside the server in an isolated runtime, one VM and one executor thread per plugin. They have **no ambient authority**: no filesystem, no process access, their entire world is the `matinee` host object documented below.

Plugins are installed, enabled, disabled, configured and removed live. No server restart is ever needed.

## Anatomy

A plugin is a directory, or a zip archive, containing at least:

```
manifest.json   id, name and version are required, everything else is optional
main.js         the entrypoint, named by manifest "main" and main.js by default
```

A source install fetches exactly three files: `manifest.json`, the entrypoint, and the optional `manifest.icon`. The server runs only the entrypoint and has no module loader, so shared code is bundled into it or copied, as described in [snippets.md](snippets.md). [registry.md](registry.md) describes source and zip installs.

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
    { "key": "api_key", "label": "API key", "type": "password", "required": true },
    { "key": "interval", "label": "Sync interval in minutes", "type": "number" }
  ]
}
```

- `id`: unique, kebab-case, and must match the registry id. Never change it after publishing, because installs are keyed by it.
- `matinee_min`: oldest compatible server version. Enforced twice: the catalog only offers compatible versions, and the server refuses to load an installed plugin whose manifest demands a newer server.
- `scopes`: the permissions the plugin requests. Admins approve them at install and update. See [Scopes](#scopes).

### Config fields

`config` fields are rendered automatically in the dialog that the Configure button opens under Server settings -> Plugins. Saving the config reloads an enabled plugin, so its top-level code re-runs with the new values.

| `type` | Renders as | Extra attributes |
|---|---|---|
| `text` | text input | |
| `password` | masked input. The server stores the value as entered and never sends it back to the browser | |
| `number` | numeric input | |
| `boolean` | checkbox | |
| `button` | button that POSTs a named hook, after the form has saved its pending change | `action` (required): the hook name. The hook's JSON body may carry `message` (shown as a notice), `config` (values filled into the form and saved) and `redirect` (an http, https or relative address the browser opens) |
| `multiselect` | checkbox list loaded from a hook | `options_hook` (required): hook returning `{options: [{value, label}]}` |
| `info` | read-only status text from a hook, polled while the dialog is open | `status_hook` (required): hook returning `{text, busy?, progress?, hide?}` |
| `usermatch` | two-column matcher: drag local users onto remote rows | `options_hook` (required), see below |

All types accept `key` (required), `label` (required), `required` and `description`, which renders as a hint below the field. Neither the dialog nor the server enforces `required`, so a plugin checks its own config. Keys starting with `_` are conventionally hook-only rows that store no value, such as `_status` and `_run`.

The three hook attributes wire config rows to `matinee.http.onRequest` handlers, documented below. Hook-driven rows only work while the plugin is running.

`info` responses report live state from a long-running job. The dialog polls every `info` hook every 5 seconds while it is open and the page is visible. `busy: true` shows a spinner, and `progress: 0-100` renders a progress bar. A response may also set `hide: ["key", ...]` to hide other config fields by key, for example to hide a manual-token fallback once an OAuth link succeeds. The list is re-evaluated on every poll.

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
  return { redirect: (req.webUrl || '') + '/settings/plugins' }
})
```

- Named hooks are served at `/api/plugins/<id>/hook/<name>` for any HTTP method, **admin-authenticated**, and refused with 403 on a device in kids mode. They power `button` (`action`), `multiselect` (`options_hook`) and `info` (`status_hook`) rows. A hook name is matched without regard to case.
- The callback is served at `GET /api/plugins/<id>/callback`, **unauthenticated** and limited to 30 requests per 5 minutes per client address and plugin. It exists for OAuth redirects, so validate your own state nonce. It answers 404 while the plugin is stopped or has registered no callback.
- `req` carries `method`, `path`, `query` with the first value of each parameter, `headers` with lower-case names, `body` up to 1 MiB, plus `baseUrl`, `webUrl` and `cookies`. `baseUrl` is the public API URL ending in `/api`, taken from Server settings -> General -> Public addresses or else built from the request, where `X-Forwarded-Host` and `X-Forwarded-Proto` count only from an address in `TRUSTED_PROXIES`. `webUrl` is the configured public web URL, and empty when none is set. `cookies` holds the plugin's own callback cookies by name. `Authorization` and `Cookie` headers are stripped before the request reaches the plugin, and no other cookie is handed over.
- Return `{status, body, contentType}` or `{redirect}`. The default content type is `application/json` for a named hook and `text/html; charset=utf-8` for the callback. Every body is served with `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`, so plugin markup renders without scripts and without access to the Matinee origin.
- A redirect must be an http or https address or a relative path, and any other scheme fails the call. The callback answers a redirect with a 302. A named hook hands it to the web app as JSON `{"redirect": ...}`, and the config dialog opens it.
- A hook call answers 503 when the plugin's queue is full, 404 while the plugin is stopped or the hook is not registered, and 502 with the error text when the handler throws or returns something invalid.
- A callback answer may add `cookies: [{name, value, maxAge}]`, at most four, to bind a sign-in to the browser that started it. The server sets each one as a cookie named `mtp_<id>_<name>`, HttpOnly, SameSite=Lax and, when `baseUrl` is https, Secure, without a Path attribute, so the browser sends it back only to URLs under `/api/plugins/<id>/`. The plugin reads it back under `<name>` in `req.cookies`, and the prefix keeps plugins from reading or setting each other's cookies. A name is 1 to 32 letters, digits or underscores, a value at most 1024 characters without spaces, quotes, commas or semicolons. A negative `maxAge` deletes the cookie, and 0 keeps it for the browser session. Named hooks cannot set cookies.

## The `matinee` host API (v1)

| Call | Scope | Description |
|---|---|---|
| `matinee.manifest` | - | your parsed manifest |
| `matinee.version` | - | host API version (currently `1`) |
| `matinee.getConfig()` | - | admin-entered config values |
| `matinee.log(...args)` | - | log to the plugin's log ring of 200 lines, shown under Logs in its config dialog, and to the server log |
| `matinee.debug(...args)` | - | verbose logging; dropped unless the server's debug logging toggle is on |
| `matinee.storage.get(key)` / `.set(key, value)` / `.delete(key)` | `storage` | persistent per-plugin key/value store of strings, so JSON-encode objects. `get` answers `null` for a missing key |
| `matinee.activity({key, title, progress?, done?, message?})` | - | report a running task to the Activities dropdown, see below |
| `matinee.on(event, handler)` | - | subscribe to server events |
| `matinee.schedule(everyMinutes, fn)` | - | recurring task; first run one interval after load; minimum 1 minute |
| `matinee.http.onRequest(name, fn)` / `.onCallback(fn)` | - | inbound hooks, see above |
| `matinee.http.fetch(url, {method, headers, body, insecure})` | `network` | outbound HTTP(S); returns `{status, headers, body}` |
| `matinee.crypto.randomToken(bytes?)` / `.sha256(text, 'hex' \| 'base64url')` / `.base64(text, 'std' \| 'url')` / `.base64Decode(text)` | - | OAuth state, PKCE and header encoding from the server's standard library. `randomToken` answers unpadded base64url of 1 to 256 random bytes, 32 by default. `sha256` defaults to hex, and `base64url` gives a PKCE S256 challenge. `base64` defaults to padded standard base64, while `url` is unpadded base64url. `base64Decode` reads either alphabet with or without padding |
| `matinee.playlists.*`, `matinee.music.*` | `playlists` | playlist sync surface, see below |
| `matinee.users.*`, `matinee.media.*`, `matinee.watch.*` | `watch-states` | watch-state migration surface, see below |
| `matinee.registerMetadataProvider(def)` | `metadata-providers` | metadata extension point |
| `matinee.registerScanner(def)` | `scanners` | filename-parser extension point |
| `matinee.auth.registerProvider(def)` / `.issueTicket(identity)` | `auth` | sign-in provider surface, see below |
| `matinee.ldap.connect(opts)` / `.escapeFilter(s)` / `.escapeDN(s)` | `ldap` | LDAP connections for sign-in plugins, see below |

### Scopes

Canonical scopes: `storage`, `network`, `playlists`, `watch-states`, `metadata-providers`, `scanners`, `auth`, `ldap`.

The admin approves the scopes the registry entry lists, at every install and every update, and the server enforces them:

- The web app sends the approved scopes with the install or update. When the registry entry lists a scope outside them, the server answers 409 with the code `plugins.scopeConsentRequired` and the missing `scopes`, and nothing is installed.
- The `scopes` of `manifest.json` must not name one the registry entry leaves out, or the install fails.
- A scope the server does not know hides the plugin from the catalog, refuses its install, and keeps an installed manifest that names one from loading.

What each scope unlocks:

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
matinee.activity({ key: 'migration', done: true, message: 'Migration complete for 2 users' })
```

Call it with the same `key` on every scheduler tick to keep the entry alive, because entries not refreshed for 5 minutes drop out automatically. `done: true` removes the entry, and a `message` alongside it is shown to admins as a success toast, prefixed with the plugin name. `progress` is 0-100 and optional. Stopping the plugin removes its entries.

### Debug logging

`matinee.log` is for phase summaries such as started, per-user result and completed. Use `matinee.debug` for page and progress detail. Debug lines only exist while the admin has "Enable debug logging" switched on under Server settings -> General -> Diagnostics. Toggling applies instantly and needs no reload. While it is off the lines are dropped, not buffered, so enable debug before starting a run.

The host also logs every `matinee.http.fetch` at debug level automatically, with method, endpoint with the query string stripped, status and duration. Plugins do not need to log their own HTTP calls.

### Limits

- Any single entry point (init, event handler, schedule, hook) is interrupted after **60 seconds**. Split long work into schedule ticks or cursor state.
- `matinee.http.fetch`: 30 second timeout, http(s) only, and a response body cut off after 10 MiB. Link-local, multicast, unspecified and cloud-metadata addresses, such as 169.254.0.0/16, fe80::/10 and fd00:ec2::254, are blocked at connect time after DNS, while loopback and private LAN addresses are allowed. Fetches go out directly and ignore proxy settings. Pass `{ insecure: true }` to skip TLS certificate verification for that request, for example against a self-signed LAN media server. Use it only for the user's own configured server, never for public endpoints. The address blocks still apply. Without a `User-Agent` header the request carries `Matinee-Plugin/<id>`.
- `matinee.storage`: a key is at most 256 bytes, a value at most 64 KiB, and one plugin's keys and values together at most about 8 MiB. `set` throws past a limit.
- The per-plugin job queue holds 64 pending calls. Events and schedule runs beyond that are dropped, and hooks answer 503, rather than blocking the server.

### Events

| Event | Payload |
|---|---|
| `media.added` | `{media_id, title, media_type, library_id, library_name}` |
| `scan.completed` | `{job_id, job_type, library_id, library_name, status}`, fired when a scan finishes successfully |
| `job.completed` | same as above, fired when any library job ends, such as a scan or a metadata refresh, with `status` `completed`, `failed` or `cancelled` |

These three are the only events the server emits today. Subscribing to any other name never fires. Handlers run on the plugin's own single thread, in emit order, so a counter incremented on `media.added` has seen every delivered event by the time `scan.completed` arrives. A plugin whose queue is full while the server emits misses that event, so treat the count as a report, not as an inventory.

`media.added` fires once per new top-level item of every media type, with `media_type` set to `movie`, `documentary`, `tv_series`, `documentary_series`, `music` for an album, or `audiobook`. A first scan fires it thousands of times. Do not log from it. Count in the handler and report once on `scan.completed`, the way `hello-world` does.

### Extension points

**Metadata provider** (scope `metadata-providers`): participates in the global and per-library provider priority exactly like TMDB and TVDB, and is offered in the manual-match dialog. `mediaTypes` accepts `movie` and `tv_series` and defaults to both. The `id` must not be a built-in provider's:

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
matinee.playlists.addGhostTrack(playlistId, {title, artist, album, source, external_id, position, duration_ms, isrc}) // returns id
matinee.playlists.removeGhostTrack(ghostId)
matinee.playlists.clearGhostTracks(playlistId, source)
matinee.music.matchTrack({title, artists, album, duration_ms, isrc, username}) // {media_file_id} or null
matinee.music.searchTracks({title, artist, username}) // [{media_file_id, title, album, artist, library_id}]
```

`addTrack`'s third argument is optional. Called without it, the track is appended at the end and a duplicate is ignored. A sync that passes `source`, `external_id` and the upstream `position` gets upsert semantics instead: the row keeps following the external track, a re-sync updates its position, the same external id resolving to a different local file replaces the old row, and a ghost track with the same `source` and `external_id` is removed. After a full pass, `reconcileTracks` drops the source's rows whose external id was not seen this time. Rows without a source are user-added, and neither call ever touches them.

`matchTrack` answers the one local file the track names, or `null`. A file with the same ISRC wins outright. Otherwise the title has to match after its markers are taken off, and a marker that names a different recording, such as "(Live)", "(Instrumental)" or "(Remix)", has to be present on both sides, while "(Remastered 2011)" or "(Radio Edit)" count for nothing. One of the `artists` has to agree with the file's artist or, when the file has none, with the album artist, and a duration more than 15 seconds off rejects the file. Among the files that pass, the closest duration ranks first, then the exact album, then the shortest title. A ghost track stored with `duration_ms` and `isrc` is matched by the same rules after every music scan. Pass the playlist owner as `username` so only that user's libraries are searched.

`searchTracks` accepts an object or a bare title string and lists up to 25 files whose title or artist contains the query, exact titles first and then the ones whose artist contains `artist`. It is meant for plugins that let a person choose from the list, not for matching. Pass the playlist owner as `username` and the search honors that user's library grants. Leaving it out searches every library, admins included.

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

`findByProviderIds` with `type: 'movie'` answers the files of movies and documentaries. `type: 'episode'` resolves a series or documentary series by its ids, then the episode by `season` and `episode`. Any one of `tmdb`, `imdb` or `tvdb` may match.

`setState` changes only the fields it is given and writes them as given. There is no newer-wins rule, so a present field overwrites the stored value even when that value is newer or further along, and a plugin that must never regress local progress compares against `getStates` first, the way the Emby and Plex migrations do outside their full sync. A field left out keeps the stored value, and a new row starts unwatched at position 0 with `last_played_at` set to now. `lastPlayedAt` is an RFC 3339 timestamp, and one that does not parse is ignored. The row's `updated_at` is backdated so that bulk writes never count as active streams.

**Scanner (filename parser)** (scope `scanners`): selectable per library in the library edit dialog, overriding how filenames are parsed, for example for anime release naming. Return `null` to fall back to the default parsing, and so does an episode without a positive `episode` or a movie without a `title`. The season still comes from the season folder, or for a file directly in the show folder from an `SxxEyy` code in its name and otherwise 1, so a returned `season` is ignored. A returned `title` replaces the episode title. A movie's `title` and `year` become `Title (Year)`, the same form the built-in parser produces.

```js
matinee.registerScanner({
  id: 'anime-scanner',
  parseMovie: function (path) { return { title: 'Title', year: 2020 } },
  parseEpisode: function (path) { return { episode: 7, title: 'Optional' } },
})
```

**Sign-in provider** (scope `auth`): lets a directory or an identity provider sign users in. A user the provider vouches for gets a Matinee account with the default library grants on first sign-in, a local account with the same username refuses the sign-in and keeps its password until an administrator links it with `POST /admin/users/:id/link`, and linked accounts cannot change or reset a password in Matinee. A username already linked to a different identity refuses the sign-in. While any provider is registered, self-registration and password reset are switched off server-wide. One password provider and one redirect provider may run at a time.

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
  return { redirect: (req.webUrl || '') + '/login?sso_ticket=' + encodeURIComponent(ticket) }
})
```

`issueTicket` takes the same identity shape and returns a one-time ticket the login page trades for a session within two minutes. Send a failure back as `/login?sso_error=<message>` and the page shows it. Validate your own state nonce, because the callback is public, and bind it to the browser with a callback cookie. With `webUrl` empty, the redirect above is relative to the API origin, which is right when the web app and the API share one. The oidc-sso plugin shows a fallback that strips `/api` from `baseUrl` instead.

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

- **Install**: the admin picks the plugin in the catalog and approves its scopes. The server stages the files, validates the manifest, swaps them into place, enables the plugin and starts it.
- **Enable / disable**: starts or stops the plugin's VM. State in `matinee.storage` survives.
- **Config save**: reloads an enabled plugin with a fresh VM, so the entrypoint re-runs. The settings dialog saves each changed field on its own, so one edit session can reload the plugin several times. An update carries only the changed keys, and a `null` removes a key.
- **Update**: same as install, including the scope approval. The catalog offers it when the registry lists a newer version than the installed one, and the server refuses a version older than the installed one. Config and storage survive.
- **Uninstall**: stops the plugin, deletes its directory, its config and its storage.

Because a reload restarts the VM, keep durable state in `matinee.storage`, not in module globals.

## Publishing

See [registry.md](registry.md) for the registry format and the repository's [README](../README.md) for the dev -> main contribution workflow.
