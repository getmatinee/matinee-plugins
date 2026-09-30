// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Mirrors selected Spotify playlists into Matinee. Unmatched tracks stay in the playlist
// as unavailable entries and are matched again after each music scan

'use strict'

var SOURCE = 'spotify'
var PAGE_SIZE = 40
var MAX_PLAYLIST_RETRIES = 3
var AUTO_SYNC_MS = 48 * 60 * 60 * 1000
var PENDING_MAX_AGE_MS = 10 * 60 * 1000
var ACCOUNTS = 'https://accounts.spotify.com'
var API = 'https://api.spotify.com'
var OAUTH_SCOPE = 'playlist-read-private playlist-read-collaborative'
var TICK_BUDGET_MS = 55000

function dbg(msg) {
  if (typeof matinee.debug === 'function') matinee.debug(msg)
}

function act(def) {
  if (typeof matinee.activity === 'function') matinee.activity(def)
}

function loadJSON(key) {
  var raw = matinee.storage.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

function saveJSON(key, value) {
  matinee.storage.set(key, JSON.stringify(value))
}

function qs(obj) {
  var parts = []
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(obj[key])))
    }
  }
  return parts.join('&')
}

function rateBlocked() {
  var until = Number(matinee.storage.get('rate.retryAfter') || '0')
  return until > Date.now()
}

// HTTP 429 sets `rateLimited` and records a retry deadline. HTTP 401 sets `expired`.
// Other HTTP failures throw an Error
function spotifyGet(url, tokens) {
  var res = matinee.http.fetch(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + tokens.access_token }
  })
  if (res.status === 429) {
    var retryAfter = Number(res.headers['retry-after'])
    if (!isFinite(retryAfter) || retryAfter < 1) retryAfter = 5
    matinee.storage.set('rate.retryAfter', String(Date.now() + (retryAfter + 1) * 1000))
    throw { rateLimited: true }
  }
  if (res.status === 401) {
    throw { expired: true }
  }
  if (res.status >= 400) {
    var err = new Error('Spotify API error ' + res.status + ' for ' + url.split('?')[0] + ': ' + String(res.body).slice(0, 200))
    err.status = res.status
    throw err
  }
  return JSON.parse(res.body)
}

function tokenRequest(params) {
  var cfg = matinee.getConfig()
  var headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  params.client_id = String(cfg.client_id || '')
  if (cfg.client_secret) {
    headers['Authorization'] = 'Basic ' + matinee.crypto.base64(String(cfg.client_id || '') + ':' + String(cfg.client_secret))
  }
  return matinee.http.fetch(ACCOUNTS + '/api/token', {
    method: 'POST',
    headers: headers,
    body: qs(params)
  })
}

function ensureTokens() {
  var tokens = loadJSON('oauth.tokens')
  if (!tokens || !tokens.access_token) return null
  if (Date.now() < Number(tokens.expires_at || 0) - 60000) return tokens
  if (!tokens.refresh_token) return null

  var res = tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
  if (res.status !== 200) {
    matinee.log('token refresh failed (' + res.status + '): ' + String(res.body).slice(0, 200))
    return null
  }
  var data
  try {
    data = JSON.parse(res.body)
  } catch (e) {
    matinee.log('token refresh returned an invalid response')
    return null
  }
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000
  }
  saveJSON('oauth.tokens', tokens)
  return tokens
}

function redirectUriFor(req) {
  return req.baseUrl + '/plugins/spotify-sync/callback'
}

matinee.http.onRequest('connect', function (req) {
  var cfg = matinee.getConfig()
  if (!cfg.client_id) {
    return { status: 400, body: JSON.stringify({ error: 'Enter your Spotify Client ID and save the configuration first.' }) }
  }

  var state = matinee.crypto.randomToken(32)
  var verifier = matinee.crypto.randomToken(48)
  var redirectUri = redirectUriFor(req)
  saveJSON('oauth.pending', {
    state: state,
    verifier: verifier,
    redirectUri: redirectUri,
    createdAt: Date.now()
  })

  var params = {
    response_type: 'code',
    client_id: String(cfg.client_id),
    redirect_uri: redirectUri,
    state: state,
    scope: OAUTH_SCOPE,
    show_dialog: 'true'
  }
  if (!cfg.client_secret) {
    params.code_challenge_method = 'S256'
    params.code_challenge = matinee.crypto.sha256(verifier, 'base64url')
  }
  return { redirect: ACCOUNTS + '/authorize?' + qs(params) }
})

matinee.http.onCallback(function (req) {
  var fail = { redirect: (req.webUrl || '') + '/settings/plugins?spotify=error' }

  var pending = loadJSON('oauth.pending')
  var query = req.query || {}
  // Only the answer to the connect in progress may end it, so a stray hit on the public callback cannot cancel it
  if (!pending || !pending.state || !pending.verifier || query.state !== pending.state) return fail
  matinee.storage.delete('oauth.pending')
  if (query.error || !query.code) return fail
  if (Date.now() - Number(pending.createdAt || 0) > PENDING_MAX_AGE_MS) return fail

  var cfg = matinee.getConfig()
  var params = {
    grant_type: 'authorization_code',
    code: query.code,
    redirect_uri: pending.redirectUri
  }
  if (!cfg.client_secret) {
    params.code_verifier = pending.verifier
  }
  var res = tokenRequest(params)
  if (res.status !== 200) {
    matinee.log('token exchange failed (' + res.status + '): ' + String(res.body).slice(0, 200))
    return fail
  }

  var data
  try {
    data = JSON.parse(res.body)
  } catch (e) {
    matinee.log('token exchange returned invalid JSON')
    return fail
  }
  if (!data.access_token) return fail

  saveJSON('oauth.tokens', {
    access_token: data.access_token,
    refresh_token: data.refresh_token || '',
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000
  })

  try {
    var me = spotifyGet(API + '/v1/me', { access_token: data.access_token })
    saveJSON('oauth.profile', { id: me.id || '', name: me.display_name || me.id || '' })
  } catch (e) {
    // The profile lookup is cosmetic and a failure does not matter
  }

  matinee.log('Spotify account connected')
  return { redirect: (req.webUrl || '') + '/settings/plugins?spotify=connected' }
})

function syncablePlaylist(p, ownerId) {
  if (!ownerId) return true
  if (p.collaborative === true) return true
  return !!(p.owner && String(p.owner.id) === ownerId)
}

matinee.http.onRequest('playlists', function () {
  if (rateBlocked()) {
    return { status: 503, body: JSON.stringify({ error: 'Spotify rate limit reached, try again in a moment.' }) }
  }
  var tokens = ensureTokens()
  if (!tokens) {
    return { status: 400, body: JSON.stringify({ error: 'Connect your Spotify account first.' }) }
  }

  var profile = loadJSON('oauth.profile')
  if (!profile || !profile.id) {
    try {
      var me = spotifyGet(API + '/v1/me', tokens)
      profile = { id: me.id || '', name: me.display_name || me.id || '' }
      saveJSON('oauth.profile', profile)
    } catch (e) {
    }
  }
  var ownerId = profile && profile.id ? String(profile.id) : ''

  var options = []
  var url = API + '/v1/me/playlists?limit=50'
  var pages = 0
  try {
    while (url && pages < 10) {
      var page = spotifyGet(url, tokens)
      var items = page.items || []
      for (var i = 0; i < items.length; i++) {
        var p = items[i]
        if (!p || !p.id) continue
        if (!syncablePlaylist(p, ownerId)) continue
        var counts = p.items || p.tracks
        var total = counts && typeof counts.total === 'number' ? counts.total : 0
        options.push({ value: p.id, label: (p.name || p.id) + ' (' + total + ' tracks)' })
      }
      url = page.next || null
      pages++
    }
  } catch (e) {
    if (e && e.rateLimited) {
      return { status: 503, body: JSON.stringify({ error: 'Spotify rate limit reached, try again in a moment.' }) }
    }
    if (e && e.expired) {
      return { status: 400, body: JSON.stringify({ error: 'Spotify session expired, reconnect your account.' }) }
    }
    throw e
  }
  return { body: JSON.stringify({ options: options }) }
})

function formatTime(ms) {
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  } catch (e) {
    return String(ms)
  }
}

matinee.http.onRequest('status', function (req) {
  var lines = []

  var tokens = loadJSON('oauth.tokens')
  if (tokens && tokens.access_token) {
    var profile = loadJSON('oauth.profile')
    lines.push('Connected as ' + (profile && profile.name ? profile.name : 'Spotify user') + '.')
  } else {
    lines.push('Not connected.')
    lines.push('Redirect URI for your Spotify app:\n' + redirectUriFor(req))
  }

  var cursor = loadJSON('sync.cursor')
  var queued = !cursor && matinee.storage.get('sync.request') === '1'
  if (queued) {
    lines.push('Sync queued.')
  }
  if (cursor && cursor.playlists) {
    var line = 'Sync running: playlist ' + (cursor.idx + 1) + ' of ' + cursor.playlists.length
    if (cursor.total >= 0) {
      line += ', track ' + Math.min(cursor.offset, cursor.total) + ' of ' + cursor.total
    }
    lines.push(line + '.')
  }

  var last = loadJSON('sync.last')
  if (last && last.completedAt) {
    lines.push(
      'Last sync: ' + formatTime(last.completedAt) + ', ' +
      (last.stats ? last.stats.matched : 0) + ' matched, ' +
      (last.stats ? last.stats.ghosts : 0) + ' not available.'
    )
  }

  if (rateBlocked()) {
    lines.push('Spotify rate limit reached, waiting until ' + formatTime(Number(matinee.storage.get('rate.retryAfter'))) + '.')
  }

  var payload = { text: lines.join('\n'), busy: !!cursor || queued }
  if (cursor && cursor.playlists) {
    payload.progress = Math.min(99, Math.floor((cursor.idx / cursor.playlists.length) * 100))
  } else if (queued) {
    payload.progress = 0
  }
  return { body: JSON.stringify(payload) }
})

matinee.http.onRequest('sync-now', function () {
  if (loadJSON('sync.cursor')) {
    return { body: JSON.stringify({ message: 'Sync already running.' }) }
  }
  matinee.storage.set('sync.request', '1')
  return { body: JSON.stringify({}) }
})

// The server tries ISRC before title, artist and duration. Unmatched tracks remain
// unavailable until a music scan can match them
function matchTrack(tr, ownerUsername) {
  var artists = []
  var credits = tr.artists || []
  for (var i = 0; i < credits.length; i++) {
    if (credits[i] && credits[i].name) artists.push(credits[i].name)
  }
  var isrc = tr.external_ids && tr.external_ids.isrc ? String(tr.external_ids.isrc) : ''
  return matinee.music.matchTrack({
    title: tr.name || '',
    artists: artists,
    album: (tr.album && tr.album.name) || '',
    duration_ms: Number(tr.duration_ms) || 0,
    isrc: isrc,
    username: ownerUsername
  })
}

// A sync starts on a manual request, or when auto sync is enabled and the last completed run is older than the interval
function startSync() {
  var cfg = matinee.getConfig()
  var requested = matinee.storage.get('sync.request') === '1'

  var due = false
  if (!requested && cfg.auto_sync) {
    var last = loadJSON('sync.last')
    due = !last || !last.completedAt || Date.now() - Number(last.completedAt) > AUTO_SYNC_MS
  }
  if (!requested && !due) return null

  var selected = cfg.playlists
  if (!selected || !selected.length) {
    if (requested) {
      matinee.storage.delete('sync.request')
      matinee.log('sync skipped: no playlists selected')
    }
    return null
  }
  if (!cfg.owner_username) {
    if (requested) {
      matinee.storage.delete('sync.request')
      matinee.log('sync skipped: no playlist owner configured')
    }
    return null
  }
  var tokens = ensureTokens()
  if (!tokens) {
    if (requested) {
      matinee.storage.delete('sync.request')
      matinee.log('sync skipped: Spotify account not connected')
    }
    return null
  }

  matinee.storage.delete('sync.request')
  var playlists = []
  for (var i = 0; i < selected.length; i++) playlists.push(String(selected[i]))
  var cursor = {
    playlists: playlists,
    idx: 0,
    offset: 0,
    total: -1,
    matineePlaylistId: null,
    spotifyName: '',
    seen: [],
    stats: { matched: 0, ghosts: 0 },
    startedAt: Date.now()
  }
  saveJSON('sync.cursor', cursor)
  matinee.log('sync started: ' + playlists.length + ' playlist(s)')
  return cursor
}

function advancePlaylist(cursor) {
  cursor.idx++
  cursor.offset = 0
  cursor.total = -1
  cursor.matineePlaylistId = null
  cursor.spotifyName = ''
  cursor.seen = []
  cursor.retries = 0
  if (cursor.idx < cursor.playlists.length) {
    saveJSON('sync.cursor', cursor)
    return false
  }
  saveJSON('sync.last', { completedAt: Date.now(), stats: cursor.stats })
  matinee.storage.delete('sync.cursor')
  matinee.log('sync complete: ' + cursor.stats.matched + ' matched, ' + cursor.stats.ghosts + ' not available')
  act({ key: 'sync', done: true, message: 'Spotify sync complete: ' + cursor.stats.matched + ' matched, ' + cursor.stats.ghosts + ' not available' })
  return true
}

function syncStep(cursor) {
  if (rateBlocked()) return false

  var tokens = ensureTokens()
  if (!tokens) {
    matinee.storage.delete('sync.cursor')
    matinee.log('sync aborted: Spotify account no longer connected')
    return false
  }

  var cfg = matinee.getConfig()
  try {
    var spotifyId = cursor.playlists[cursor.idx]

    var starting = !cursor.matineePlaylistId
    if (starting) {
      var meta = spotifyGet(API + '/v1/playlists/' + encodeURIComponent(spotifyId) + '?fields=name', tokens)
      cursor.spotifyName = meta.name || 'Spotify playlist'
    }

    var page = spotifyGet(
      API + '/v1/playlists/' + encodeURIComponent(spotifyId) + '/items?' + qs({
        limit: PAGE_SIZE,
        offset: cursor.offset,
        fields: 'total,items(item(id,name,type,duration_ms,external_ids(isrc),artists(name),album(name)))'
      }),
      tokens
    )
    cursor.total = Number(page.total) || 0

    if (starting) {
      cursor.matineePlaylistId = matinee.playlists.create(String(cfg.owner_username || ''), cursor.spotifyName)
      matinee.playlists.clearGhostTracks(cursor.matineePlaylistId, SOURCE)
      cursor.seen = []
      saveJSON('sync.cursor', cursor)
      dbg('playlist "' + cursor.spotifyName + '" (' + (cursor.idx + 1) + ' of ' + cursor.playlists.length + '): starting')
    }

    var items = page.items || []
    var used = 0
    for (var k = 0; k < items.length; k++) {
      var tr = items[k] && (items[k].item || items[k].track)
      if (!tr || !tr.id) continue
      if (tr.type && tr.type !== 'track') continue
      used++

      var match = matchTrack(tr, String(cfg.owner_username || ''))
      if (match) {
        matinee.playlists.addTrack(cursor.matineePlaylistId, match.media_file_id, {
          source: SOURCE,
          external_id: tr.id,
          position: cursor.offset + k
        })
        cursor.seen.push(tr.id)
        cursor.stats.matched++
      } else {
        var artistNames = []
        var artists = tr.artists || []
        for (var a = 0; a < artists.length; a++) {
          if (artists[a] && artists[a].name) artistNames.push(artists[a].name)
        }
        matinee.playlists.addGhostTrack(cursor.matineePlaylistId, {
          title: tr.name || 'Unknown',
          artist: artistNames.join(', '),
          album: (tr.album && tr.album.name) || '',
          source: SOURCE,
          external_id: tr.id,
          position: cursor.offset + k,
          duration_ms: Number(tr.duration_ms) || 0,
          isrc: (tr.external_ids && tr.external_ids.isrc) || ''
        })
        cursor.stats.ghosts++
      }
    }

    if (items.length > 0 && used === 0) {
      matinee.log('warning: Spotify returned ' + items.length + ' unreadable entries for "' + cursor.spotifyName + '", the API response format may have changed')
    }

    dbg(
      'playlist "' + cursor.spotifyName + '": ' + used + ' of ' + items.length + ' entries at offset ' + cursor.offset +
      ' of ' + cursor.total + ' (' + cursor.stats.matched + ' matched, ' + cursor.stats.ghosts + ' not available)'
    )
    // Spotify signals the end with a short page
    cursor.offset += items.length
    if (cursor.offset >= cursor.total || items.length < PAGE_SIZE) {
      var removed = matinee.playlists.reconcileTracks(cursor.matineePlaylistId, SOURCE, cursor.seen || [])
      if (removed > 0) {
        dbg('playlist "' + cursor.spotifyName + '": dropped ' + removed + ' track(s) no longer on Spotify')
      }
      matinee.log('synced "' + cursor.spotifyName + '" (' + cursor.total + ' tracks)')
      return !advancePlaylist(cursor)
    }
    cursor.retries = 0
    saveJSON('sync.cursor', cursor)
    return true
  } catch (e) {
    if (e && (e.rateLimited || e.expired)) {
      saveJSON('sync.cursor', cursor)
      dbg('sync paused: ' + (e.rateLimited ? 'rate limited' : 'token expired'))
      return false
    }

    var label = '"' + (cursor.spotifyName || cursor.playlists[cursor.idx]) + '"'
    var reason = e && e.status === 403
      ? 'Spotify only serves the tracks of playlists you own or collaborate on'
      : (e && e.message ? e.message : String(e)) + ' at offset ' + cursor.offset

    cursor.retries = (cursor.retries || 0) + 1
    if (cursor.retries >= MAX_PLAYLIST_RETRIES || (e && e.status === 403)) {
      matinee.log('skipping ' + label + ': ' + reason)
      return !advancePlaylist(cursor)
    }
    saveJSON('sync.cursor', cursor)
    matinee.log('sync error on ' + label + ' (attempt ' + cursor.retries + ' of ' + MAX_PLAYLIST_RETRIES + ', will retry): ' + reason)
    return false
  }
}

// Reserve time for the next page before the host's 60-second interrupt.
// Decay the estimate so one slow page does not throttle the entire sync
matinee.schedule(1, function () {
  var cursor = loadJSON('sync.cursor')
  if (!cursor) {
    cursor = startSync()
    if (!cursor) return
  }
  var start = Date.now()
  var maxStep = 5000
  while (true) {
    var reserve = maxStep * 1.5
    if (Date.now() - start + reserve > TICK_BUDGET_MS) break
    var t0 = Date.now()
    var ok = syncStep(cursor)
    var took = Date.now() - t0
    maxStep = took > maxStep ? took : maxStep * 0.7 + took * 0.3
    if (!ok) break
    cursor = loadJSON('sync.cursor')
    if (!cursor) break
  }
  if (cursor && loadJSON('sync.cursor')) {
    act({
      key: 'sync',
      title: 'Syncing "' + cursor.spotifyName + '" (' + (cursor.idx + 1) + ' of ' + cursor.playlists.length + ')',
      progress: Math.min(99, Math.floor((cursor.idx / cursor.playlists.length) * 100))
    })
  }
})

matinee.log('spotify-sync v' + matinee.manifest.version + ' loaded')

// Node tests import this function. Goja provides no module object
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { matchTrack: matchTrack }
}
