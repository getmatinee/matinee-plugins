// Copyright (C) 2023-2026 Matinee
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Type declarations for the Matinee plugin host API

// One admin-editable setting rendered in Settings -> Plugins -> Configure.
// Hook-driven fields wire a config row to a named matinee.http.onRequest
// hook: `button` POSTs its `action` hook, `multiselect` loads choices as
// [{value, label}] from `options_hook`, and `info` shows read-only text
// ({text} or a plain string body) from `status_hook`
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

// What an info field's status_hook returns; busy shows a spinner and
// progress (0-100) a bar while the modal polls.
interface MatineeStatusResponse {
  text: string
  busy?: boolean
  progress?: number
  hide?: string[] // config field keys to hide while the plugin runs
}

// What a usermatch field's options_hook returns; the field stores
// { [remoteValue]: localValue } under its config key, empty meaning
// "use the suggested matches".
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
  capabilities?: string[]
  scopes?: string[]
  config?: MatineeConfigField[]
}

interface MatineeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  // Skips TLS verification (self-signed LAN server only); SSRF blocks stay.
  insecure?: boolean
}

interface MatineeFetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

// Inbound HTTP named hooks (matinee.http.onRequest) are served
// admin-authenticated at /api/plugins/<id>/hook/<name>; the single OAuth
// callback (matinee.http.onCallback) is public at /api/plugins/<id>/callback.
interface MatineeHookRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: string
  baseUrl: string // e.g. https://host/api
  webUrl: string // e.g. https://host
}

interface MatineeHookResponse {
  status?: number
  body?: string
  contentType?: string
  redirect?: string
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
  title?: string // for movies
  name?: string // for tv series
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

interface MatineeHost {
  manifest: MatineeManifest
  version: number
  getConfig(): Record<string, unknown>
  log(...args: unknown[]): void
  // Dropped unless the server's debug logging toggle is on.
  debug(...args: unknown[]): void
  // Reports a running task to the Activities dropdown. Refresh it with the
  // same key on every tick (stale entries drop out after 5 minutes);
  // done removes it and message then shows as an admin success toast.
  activity(def: { key: string; title?: string; progress?: number; done?: boolean; message?: string }): void
  http: {
    fetch(url: string, options?: MatineeFetchOptions): MatineeFetchResult
    onRequest(name: string, handler: (req: MatineeHookRequest) => MatineeHookResponse | void): void
    onCallback(handler: (req: MatineeHookRequest) => MatineeHookResponse | void): void
  }
  // storage requires the "storage" scope; absent (undefined) when the
  // manifest does not declare it.
  storage: {
    get(key: string): string | null
    set(key: string, value: string): void
    delete(key: string): void
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
}

declare const matinee: MatineeHost
