// Copyright (C) 2023-2026 Matinee
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Spotify Playlist Sync
// The admin connects his Spotify account via OAuth, picks a playlist to sync and the scheduler-driven job mirrors them into Matinee playlists
// unavailable tracks are recorded as "not available -> ghost tracks". In the web UI they are rendered greyed-out and if possible with artist / album information.

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

function randToken(n) {
  var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  var out = ''
  for (var i = 0; i < n; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return out
}

// Convert JS string to array of UTF-8 byte values
function utf8Bytes(str) {
  var bytes = []
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i)
    if (c < 0x80) {
      bytes.push(c)
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1)
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        )
      } else {
        bytes.push(0xef, 0xbf, 0xbd)
      }
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return bytes
}

var SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) | 0
}

// Return the 32-byte digest as array of byte values -> used for the PKCE S256 code challenge
function sha256Bytes(str) {
  var bytes = utf8Bytes(str)
  var bitLen = bytes.length * 8

  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  var hi = Math.floor(bitLen / 0x100000000)
  var lo = bitLen >>> 0
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff)
  bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff)

  var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  var w = new Array(64)

  for (var off = 0; off < bytes.length; off += 64) {
    var t
    for (t = 0; t < 16; t++) {
      w[t] =
        (bytes[off + t * 4] << 24) |
        (bytes[off + t * 4 + 1] << 16) |
        (bytes[off + t * 4 + 2] << 8) |
        bytes[off + t * 4 + 3]
    }
    for (t = 16; t < 64; t++) {
      var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (t = 0; t < 64; t++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      var ch = (e & f) ^ (~e & g)
      var temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      var maj = (a & b) ^ (a & c) ^ (b & c)
      var temp2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
    h5 = (h5 + f) | 0
    h6 = (h6 + g) | 0
    h7 = (h7 + h) | 0
  }

  var words = [h0, h1, h2, h3, h4, h5, h6, h7]
  var out = []
  for (var i = 0; i < 8; i++) {
    out.push((words[i] >>> 24) & 0xff, (words[i] >>> 16) & 0xff, (words[i] >>> 8) & 0xff, words[i] & 0xff)
  }
  return out
}

function b64Encode(bytes, chars, pad) {
  var out = ''
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i]
    var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += chars.charAt(b0 >> 2)
    out += chars.charAt(((b0 & 0x03) << 4) | (b1 >> 4))
    out += i + 1 < bytes.length ? chars.charAt(((b1 & 0x0f) << 2) | (b2 >> 6)) : pad
    out += i + 2 < bytes.length ? chars.charAt(b2 & 0x3f) : pad
  }
  return out
}

// RFC 4648 base64url without padding -> PKCE code_challenge
function base64UrlNoPad(bytes) {
  return b64Encode(bytes, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', '')
}

function b64(str) {
  return b64Encode(utf8Bytes(str), 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', '=')
}

// Title and album normalization for fuzzy matching
function normalize(s) {
  if (!s) return ''
  s = String(s).toLowerCase()
  try {
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  } catch (e) {
  }
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(/\[[^\]]*\]/g, ' ')
  s = s.replace(
    /\s*-\s*(remaster(ed)?(\s+\d{4})?|live|mono(\s+version)?|stereo(\s+version)?|single\s+version|radio\s+edit|album\s+version|bonus\s+track|deluxe(\s+edition)?|extended(\s+mix|\s+version)?|acoustic(\s+version)?|demo)\s*$/,
    ' '
  )
  s = s.replace(/[^a-z0-9 ]+/g, ' ')
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/^\s+|\s+$/g, '')
  return s
}

function rateBlocked() {
  var until = Number(matinee.storage.get('rate.retryAfter') || '0')
  return until > Date.now()
}

// Authenticated GET against the Spotify API
// a 429 records the back-off deadline and throws {rateLimited: true}
// a 401 throws {expired: true} and any other status >= 400 throws an Error.
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
    headers['Authorization'] = 'Basic ' + b64(String(cfg.client_id || '') + ':' + String(cfg.client_secret))
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

  var state = randToken(32)
  var verifier = randToken(64)
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
    params.code_challenge = base64UrlNoPad(sha256Bytes(verifier))
  }
  return { redirect: ACCOUNTS + '/authorize?' + qs(params) }
})

// The public callback endpoint
matinee.http.onCallback(function (req) {
  var fail = { redirect: (req.webUrl || '') + '/settings/plugins?spotify=error' }

  var pending = loadJSON('oauth.pending')
  matinee.storage.delete('oauth.pending')

  var query = req.query || {}
  if (!pending || !pending.state || !pending.verifier) return fail
  if (query.error || !query.code) return fail
  if (query.state !== pending.state) return fail
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
    // The profile lookup is cosmetic; a failure does not matter.
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

function containsEitherWay(a, b) {
  return a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1
}

// Decides which local candidate a Spotify track maps to, or null for none.
// The title must match exactly or by containment after normalize(). The
// artist is a veto: when the candidate and the Spotify track both name one
// and no listed Spotify artist containment-matches it, the candidate is out,
// however good the rest looks. Without artist evidence on both sides the
// album has to agree instead, or an exact title on a random compilation
// would pass again. Survivors rank by title exactness, then album
// agreement, then lowest media_file_id, so ties resolve the same way on
// every run. Pure on purpose: the repo's node tests load it.
function chooseTrack(tr, candidates) {
  var cleanTitle = normalize(tr.name)
  if (!cleanTitle || !candidates || candidates.length === 0) return null

  var spotifyArtists = []
  var artists = tr.artists || []
  for (var i = 0; i < artists.length; i++) {
    var name = normalize(artists[i] && artists[i].name)
    if (name) spotifyArtists.push(name)
  }
  var spotifyAlbum = normalize(tr.album && tr.album.name)

  var best = null
  var bestTitleRank = 0
  var bestAlbumRank = 0
  for (var j = 0; j < candidates.length; j++) {
    var c = candidates[j]
    var title = normalize(c.title)

    var titleRank = 0
    if (title && title === cleanTitle) {
      titleRank = 2
    } else if (title && containsEitherWay(title, cleanTitle)) {
      titleRank = 1
    }
    if (titleRank === 0) continue

    var candArtist = normalize(c.artist)
    var artistKnown = !!candArtist && spotifyArtists.length > 0
    if (artistKnown) {
      var agrees = false
      for (var k = 0; k < spotifyArtists.length; k++) {
        if (containsEitherWay(spotifyArtists[k], candArtist)) {
          agrees = true
          break
        }
      }
      if (!agrees) continue
    }

    var album = normalize(c.album)
    var albumRank = 0
    if (!spotifyAlbum) {
      albumRank = 1
    } else if (album && album === spotifyAlbum) {
      albumRank = 2
    } else if (album && containsEitherWay(album, spotifyAlbum)) {
      albumRank = 1
    }
    if (!artistKnown && albumRank === 0) continue

    var better =
      titleRank > bestTitleRank ||
      (titleRank === bestTitleRank && albumRank > bestAlbumRank) ||
      (titleRank === bestTitleRank && albumRank === bestAlbumRank &&
        best !== null && String(c.media_file_id) < String(best.media_file_id))
    if (best === null || better) {
      best = c
      bestTitleRank = titleRank
      bestAlbumRank = albumRank
    }
  }
  return best
}

// Search the playlist owner's libraries with the cleaned title and first
// artist, then let chooseTrack pick.
function matchTrack(tr, ownerUsername) {
  var cleanTitle = normalize(tr.name)
  if (!cleanTitle) return null

  var firstArtist = ''
  if (tr.artists && tr.artists.length > 0 && tr.artists[0] && tr.artists[0].name) {
    firstArtist = tr.artists[0].name
  }
  var candidates = matinee.music.searchTracks({
    title: cleanTitle,
    artist: firstArtist,
    username: ownerUsername
  })
  return chooseTrack(tr, candidates)
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
        fields: 'total,items(item(id,name,type,artists(name),album(name)))'
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
          position: cursor.offset + k
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
    // A page shorter than requested is Spotify's end signal; advancing by
    // the real item count keeps the offsets aligned with it.
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

// Works for most of the tick, reserving room for a slow step so a long page
// can never run into the host's 60s call interrupt. The reserve jumps to any
// new worst case but decays toward recent step times afterwards, so one
// early outlier does not throttle the whole run.
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

// Node sees this during the repo's tests; inside goja there is no module
// object and the block never runs.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalize: normalize, chooseTrack: chooseTrack }
}
