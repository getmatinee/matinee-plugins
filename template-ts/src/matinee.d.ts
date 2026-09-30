// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Type declarations for the Matinee plugin host API

// Admin fields use named HTTP hooks. Buttons POST to `action`, multiselect loads
// `{value, label}` choices from `options_hook`, and info reads text from `status_hook`
interface MatineeConfigField {
  key: string
  label: string
  type?: 'text' | 'password' | 'number' | 'boolean' | 'button' | 'multiselect' | 'info' | 'usermatch'
  required?: boolean
  description?: string
  action?: string
  options_hook?: string
  status_hook?: string
}

// What an info field's status_hook returns. While the modal polls, busy
// shows a spinner and progress, from 0 to 100, fills a bar
interface MatineeStatusResponse {
  text: string
  busy?: boolean
  progress?: number
  hide?: string[]
}

// User matching stores a remote-to-local value map under its config key.
// An empty map selects the suggested matches
interface MatineeUserMatchOptions {
  remote: Array<{ value: string; label: string; disabled?: boolean; note?: string }>
  local: Array<{ value: string; label: string }>
  suggested: Record<string, string>
}

interface MatineeManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  icon?: string
  main?: string
  matinee_min?: string
  scopes?: string[]
  config?: MatineeConfigField[]
}

interface MatineeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  // Skips TLS verification e.g. for a self-signed LAN server
  insecure?: boolean
}

interface MatineeFetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

// Named hooks require admin authentication at /api/plugins/<id>/hook/<name>.
// The onCallback handler is public at /api/plugins/<id>/callback
interface MatineeHookRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: string
  // The API origin, such as https://host/api
  baseUrl: string
  // The web app origin, such as https://host
  webUrl: string
  // The plugin's own callback cookies by name. No other cookie reaches a plugin
  cookies: Record<string, string>
}

// Only a callback answer sets cookies. A negative maxAge deletes one, zero keeps it for the browser session
interface MatineeHookCookie {
  name: string
  value: string
  maxAge?: number
}

interface MatineeHookResponse {
  status?: number
  body?: string
  contentType?: string
  // An http or https address or a path. Any other scheme fails the call
  redirect?: string
  cookies?: MatineeHookCookie[]
}

interface MatineePlaylistSummary {
  id: string
  name: string
  owner_username: string
  track_count: number
}

interface MatineePlaylistTrack {
  media_file_id: string
  title: string
  album: string
}

interface MatineeGhostTrack {
  id: string
  title: string
  artist: string
  album: string
  source: string
  external_id: string
}

interface MatineeTrackSearchResult {
  media_file_id: string
  title: string
  album: string
  library_id: string
}

interface MatineeSearchResult {
  id: string | number
  title: string
  year?: number
  release_date?: string
  overview?: string
  poster_url?: string
  backdrop_url?: string
}

interface MatineeDetails {
  id: string | number
  // Movies carry title, tv series carry name
  title?: string
  name?: string
  overview?: string
  release_date?: string
  first_air_date?: string
  year?: number
  poster_url?: string
  backdrop_url?: string
  genres?: string[]
  rating?: number
  rating_votes?: number
  runtime?: number
  imdb_id?: string
}

interface MatineeUser {
  id: string
  username: string
}

interface MatineeProviderQuery {
  type: 'movie' | 'episode'
  tmdb?: number
  imdb?: string
  tvdb?: number
  season?: number
  episode?: number
}

interface MatineeWatchState {
  media_file_id: string
  watched: boolean
  position_seconds: number
  last_played_at?: string
}

interface MatineeSetStateOptions {
  watched?: boolean
  positionSeconds?: number
  lastPlayedAt?: string
}

// Who a sign-in provider says the user is. id is the stable identifier the
// Matinee account stays linked to, and admin left out keeps the flag as it is
interface MatineeIdentity {
  id: string
  username: string
  email?: string
  first_name?: string
  last_name?: string
  admin?: boolean
}

interface MatineeLDAPEntry {
  dn: string
  attributes: Record<string, string[]>
}

interface MatineeLDAPConnection {
  search(req: {
    baseDn: string
    filter: string
    attributes?: string[]
    scope?: 'sub' | 'one' | 'base'
    sizeLimit?: number
  }): MatineeLDAPEntry[]
  close(): void
}

interface MatineeHost {
  manifest: MatineeManifest
  version: number
  getConfig(): Record<string, unknown>
  log(...args: unknown[]): void
  // Dropped unless the server's debug logging toggle is on
  debug(...args: unknown[]): void
  // Activities expire after five minutes without a refresh under the same key.
  // done removes the entry and message shows an admin success toast
  activity(def: { key: string; title?: string; progress?: number; done?: boolean; message?: string }): void
  http: {
    fetch(url: string, options?: MatineeFetchOptions): MatineeFetchResult
    onRequest(name: string, handler: (req: MatineeHookRequest) => MatineeHookResponse | void): void
    onCallback(handler: (req: MatineeHookRequest) => MatineeHookResponse | void): void
  }
  // Requires the "storage" scope and is undefined when the manifest does not
  // declare it
  storage: {
    get(key: string): string | null
    set(key: string, value: string): void
    delete(key: string): void
  }
  crypto: {
    // Unpadded base64url text of that many random bytes, 32 by default
    randomToken(bytes?: number): string
    sha256(text: string, encoding?: 'hex' | 'base64url'): string
    base64(text: string, variant?: 'std' | 'url'): string
    // Reads either alphabet, with or without padding
    base64Decode(text: string): string
  }
  on(event: 'media.added' | 'scan.completed' | 'job.completed', handler: (payload: any) => void): void
  schedule(everyMinutes: number, fn: () => void): void
  playlists: {
    list(): MatineePlaylistSummary[]
    get(playlistId: string): { id: string; name: string; tracks: MatineePlaylistTrack[]; ghost_tracks: MatineeGhostTrack[] }
    create(ownerUsername: string, name: string): string
    addTrack(playlistId: string, mediaFileId: string): void
    removeTrack(playlistId: string, mediaFileId: string): void
    addGhostTrack(
      playlistId: string,
      def: { title: string; artist?: string; album?: string; source?: string; external_id?: string; position?: number }
    ): string
    removeGhostTrack(ghostId: string): void
    clearGhostTracks(playlistId: string, source: string): void
  }
  music: {
    searchTracks(query: string): MatineeTrackSearchResult[]
  }
  users: {
    list(): MatineeUser[]
  }
  media: {
    findByProviderIds(def: MatineeProviderQuery): string[]
  }
  watch: {
    getStates(userId: string): MatineeWatchState[]
    setState(userId: string, mediaFileId: string, opts: MatineeSetStateOptions): void
  }
  registerMetadataProvider(def: {
    id: string
    mediaTypes?: Array<'movie' | 'tv_series'>
    search(query: string, year: number | null, mediaType: string): MatineeSearchResult[]
    details(id: string, mediaType: string): MatineeDetails
  }): void
  registerScanner(def: {
    id: string
    parseMovie?(path: string): { title: string; year?: number } | null
    parseEpisode?(path: string): { season?: number; episode: number; title?: string } | null
  }): void
  // Requires the auth scope. authenticate returns an identity, null for an unknown user,
  // false for a refused password, or throws on lookup failure. Redirect providers issue callback tickets
  auth: {
    registerProvider(def: {
      name?: string
      redirect?: boolean
      authenticate?(username: string, password: string): MatineeIdentity | null | false
    }): void
    issueTicket(identity: MatineeIdentity): string
  }
  // Requires the "ldap" scope. connect answers null when the bind was refused
  ldap: {
    connect(opts: { url: string; bindDn?: string; password?: string; insecure?: boolean; startTls?: boolean }): MatineeLDAPConnection | null
    escapeFilter(value: string): string
    escapeDN(value: string): string
  }
}

declare const matinee: MatineeHost
