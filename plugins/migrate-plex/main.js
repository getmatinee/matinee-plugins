// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Anna Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Plex Watch State Migration
// The admin links a Plex account via the plex.tv/link PIN flow or pastes a token, maps Plex users to Matinee accounts, and a scheduler-driven job copies watched flags and resume positions per user.
// External shared users migrate watched flags only, from the server history

'use strict'

var PAGE_SIZE = 200
var TICK_BUDGET_MS = 55000
var STATUS_CACHE_MS = 30000

var statusCache = null
var PLEXTV = 'https://plex.tv'
var PIN_MAX_AGE_MS = 15 * 60 * 1000

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

// X-Plex-Client-Identifier that plex.tv needs and binds access to it
function clientId() {
  var id = matinee.storage.get('plex.clientId')
  if (!id) {
    id = 'matinee-' + randToken(24)
    matinee.storage.set('plex.clientId', id)
  }
  return id
}

function plexHeaders(token) {
  var headers = {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': clientId(),
    'X-Plex-Product': 'Matinee',
    'X-Plex-Version': String(matinee.manifest.version)
  }
  if (token) headers['X-Plex-Token'] = token
  return headers
}

function plexRequest(method, url, token) {
  // The user's Plex server often has a self-signed cert, while plex.tv does not
  var insecure = url.indexOf(PLEXTV) !== 0
  var res = matinee.http.fetch(url, { method: method, headers: plexHeaders(token), insecure: insecure })
  if (res.status >= 400) {
    throw new Error('Plex API error ' + res.status + ' for ' + url.split('?')[0])
  }
  return JSON.parse(res.body)
}

function baseUrl() {
  var cfg = matinee.getConfig()
  return String(cfg.server_url || '').replace(/\/+$/, '')
}

function ownerToken() {
  var auth = loadJSON('auth')
  if (auth && auth.token) return auth.token
  var cfg = matinee.getConfig()
  return String(cfg.plex_token || '') || null
}

function checkPin() {
  var pin = loadJSON('pin')
  if (!pin || !pin.id) return null
  if (Date.now() - Number(pin.createdAt || 0) > PIN_MAX_AGE_MS) {
    matinee.storage.delete('pin')
    return null
  }
  try {
    var data = plexRequest('GET', PLEXTV + '/api/v2/pins/' + encodeURIComponent(pin.id), null)
    if (data && data.authToken) {
      saveJSON('auth', { token: String(data.authToken), linkedAt: Date.now() })
      matinee.storage.delete('pin')
      statusCache = null
      matinee.log('Plex account linked')
      return String(data.authToken)
    }
    dbg('pin poll: not yet authorized')
  } catch (e) {
    // invalid pin
    matinee.storage.delete('pin')
  }
  return null
}

matinee.http.onRequest('connect', function () {
  var res = matinee.http.fetch(PLEXTV + '/api/v2/pins', {
    method: 'POST',
    headers: plexHeaders(null)
  })
  if (res.status >= 400) {
    return { status: 502, body: JSON.stringify({ error: 'plex.tv rejected the link request (' + res.status + ').' }) }
  }
  var data
  try {
    data = JSON.parse(res.body)
  } catch (e) {
    return { status: 502, body: JSON.stringify({ error: 'plex.tv returned an invalid response.' }) }
  }
  if (!data || !data.id || !data.code) {
    return { status: 502, body: JSON.stringify({ error: 'plex.tv returned no link code.' }) }
  }
  saveJSON('pin', { id: data.id, code: data.code, createdAt: Date.now() })
  return { body: JSON.stringify({ message: 'Enter code ' + data.code + ' at https://plex.tv/link.' }) }
})

// Matches remote users to Matinee accounts by name
function matchUsers(remoteUsers) {
  var locals = matinee.users.list()
  var byName = {}
  for (var i = 0; i < locals.length; i++) {
    byName[String(locals[i].username).toLowerCase()] = locals[i]
  }
  var out = []
  for (var j = 0; j < remoteUsers.length; j++) {
    var remote = remoteUsers[j]
    var local = byName[String(remote.name).toLowerCase()] || null
    out.push({
      remoteId: remote.id,
      remoteName: remote.name,
      protected: remote.protected === true,
      external: remote.external === true,
      accountId: remote.accountId || null,
      matineeId: local ? local.id : null,
      matineeName: local ? local.username : null
    })
  }
  return out
}

function resolvePairs(matched, logSkips) {
  var cfg = matinee.getConfig()
  var pairs = cfg.user_pairs
  var hasPairs = pairs && typeof pairs === 'object' && Object.keys(pairs).length > 0
  var locals = matinee.users.list()
  var byId = {}
  for (var i = 0; i < locals.length; i++) {
    byId[String(locals[i].id)] = locals[i]
  }
  var out = []
  for (var j = 0; j < matched.length; j++) {
    var m = matched[j]
    if (m.protected) {
      if (logSkips && (hasPairs ? pairs[m.remoteId] : m.matineeId)) {
        matinee.log('skipping ' + m.remoteName + ': PIN protected home user')
      }
      continue
    }
    if (hasPairs) {
      var localId = pairs[m.remoteId]
      if (!localId) continue
      var local = byId[String(localId)]
      if (!local) {
        if (logSkips) matinee.log('skipping ' + m.remoteName + ': assigned Matinee user no longer exists')
        continue
      }
      out.push({ remoteId: m.remoteId, remoteName: m.remoteName, external: m.external, accountId: m.accountId, matineeId: local.id, matineeName: local.username })
    } else if (m.matineeId) {
      out.push({ remoteId: m.remoteId, remoteName: m.remoteName, external: m.external, accountId: m.accountId, matineeId: m.matineeId, matineeName: m.matineeName })
    }
  }
  return out
}

// Fetches the owner, the Plex Home users and the external shared accounts.
// External accounts can only migrate watched flags, read from the server's
// playback history.
function fetchRemoteUsers(token) {
  var out = []
  var seen = {}
  var me = plexRequest('GET', PLEXTV + '/api/v2/user', token)
  var ownerName = String(me.username || me.title || 'owner')
  out.push({ id: 'owner', name: ownerName })
  seen[ownerName.toLowerCase()] = true
  try {
    var home = plexRequest('GET', PLEXTV + '/api/v2/home/users', token)
    var users = (home && home.users) || []
    for (var i = 0; i < users.length; i++) {
      var u = users[i]
      if (!u || !u.uuid) continue
      if (u.admin === true) continue
      var hname = String(u.username || u.title || u.uuid)
      seen[hname.toLowerCase()] = true
      out.push({ id: String(u.uuid), name: hname, protected: u.protected === true })
    }
  } catch (e) {
    // No Plex Home -> owner only
  }
  try {
    var accounts = plexRequest('GET', baseUrl() + '/accounts', token)
    var list = ((accounts && accounts.MediaContainer) || {}).Account || []
    for (var j = 0; j < list.length; j++) {
      var a = list[j]
      if (!a || String(a.id) === '1' || !a.name) continue
      var aname = String(a.name)
      if (seen[aname.toLowerCase()]) continue
      seen[aname.toLowerCase()] = true
      out.push({ id: 'acct:' + a.id, accountId: String(a.id), name: aname, external: true })
    }
  } catch (e) {
    // Servers without the accounts endpoint migrate the owner and home users only
  }
  return out
}

function userToken(user, token) {
  if (user.remoteId === 'owner') return token
  var data = plexRequest('POST', PLEXTV + '/api/v2/home/users/' + encodeURIComponent(user.remoteId) + '/switch', token)
  if (!data || !data.authToken) throw new Error('no token for home user ' + user.remoteName)
  dbg('resolved token for home user ' + user.remoteName)
  return String(data.authToken)
}

// Per-user PMS tokens live in memory only -> After a restart the token is simply resolved again on first use.
var userTokens = {}

function tokenFor(user) {
  if (!userTokens[user.remoteId]) {
    userTokens[user.remoteId] = userToken(user, ownerToken())
  }
  return userTokens[user.remoteId]
}

function guidsOf(item) {
  var out = {}
  var guids = (item && item.Guid) || []
  for (var i = 0; i < guids.length; i++) {
    var id = guids[i] && guids[i].id
    if (!id) continue
    var m = /^(tmdb|imdb|tvdb):\/\/(.+)$/.exec(String(id))
    if (m) out[m[1]] = m[2]
  }
  return out
}

function providerQuery(kind, ids, season, episode) {
  var q = { type: kind }
  var tmdb = parseInt(ids.tmdb, 10)
  var tvdb = parseInt(ids.tvdb, 10)
  if (isFinite(tmdb) && tmdb > 0) q.tmdb = tmdb
  if (isFinite(tvdb) && tvdb > 0) q.tvdb = tvdb
  if (ids.imdb) q.imdb = ids.imdb
  if (kind === 'episode') {
    q.season = season
    q.episode = episode
  }
  return q
}

function hasProviderIds(ids) {
  return Boolean(ids.tmdb || ids.imdb || ids.tvdb)
}

function formatTime(ms) {
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  } catch (e) {
    return String(ms)
  }
}

// Converts Plex lastViewedAt to RFC3339
function rfc3339(unixSeconds) {
  var n = Number(unixSeconds)
  if (!isFinite(n) || n <= 0) return ''
  try {
    return new Date(n * 1000).toISOString()
  } catch (e) {
    return ''
  }
}

function sectionPage(token, sectionKey, itemType, offset) {
  var url = baseUrl() + '/library/sections/' + encodeURIComponent(sectionKey) + '/all?' + qs({
    type: itemType,
    includeGuids: 1,
    'X-Plex-Container-Start': offset,
    'X-Plex-Container-Size': PAGE_SIZE
  })
  var data = plexRequest('GET', url, token)
  return (data && data.MediaContainer) || {}
}

matinee.http.onRequest('status', function () {
  var lines = []
  var token = ownerToken()
  if (!token) {
    token = checkPin()
  }
  var pin = loadJSON('pin')
  if (!token && pin && pin.code) {
    return { body: JSON.stringify({ text: 'Enter code ' + pin.code + ' at https://plex.tv/link.' }) }
  }
  if (!token) {
    return { body: JSON.stringify({ text: 'Not linked. Use "Connect Plex account" (or paste a token) and save.' }) }
  }
  // Linked from here on, so the manual token field is redundant and hidden
  var hide = ['plex_token']
  var cfg = matinee.getConfig()
  if (!cfg.server_url) {
    return { body: JSON.stringify({ text: 'Linked. Enter the Plex server URL and save.', hide: hide }) }
  }
  var text
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    text = statusCache.text
  } else {
    try {
      var identity = plexRequest('GET', baseUrl() + '/identity', token)
      var mc = (identity && identity.MediaContainer) || {}
      lines.push('Connected to Plex server (version ' + (mc.version || 'unknown') + ').')
      var matched = matchUsers(fetchRemoteUsers(token))
      var resolved = resolvePairs(matched, false)
      var names = []
      for (var i = 0; i < resolved.length; i++) {
        names.push(resolved[i].remoteName + ' -> ' + resolved[i].matineeName)
      }
      var line = matched.length + ' Plex users (owner, home and external shared), ' + resolved.length + ' will be migrated'
      line += names.length ? ': ' + names.join(', ') + '.' : '.'
      lines.push(line)
      text = lines.join('\n')
    } catch (e) {
      text = 'Not connected: ' + (e && e.message ? e.message : String(e)) + ' Check the server URL and link state.'
    }
    statusCache = { at: Date.now(), text: text }
  }
  return { body: JSON.stringify({ text: text, hide: hide }) }
})

// Plex users, Matinee accounts, and the name-based auto matches for the usermatch config field.
matinee.http.onRequest('users', function () {
  var token = ownerToken() || checkPin()
  if (!token) {
    return { status: 400, body: JSON.stringify({ error: 'Link your Plex account first.' }) }
  }
  var matched = matchUsers(fetchRemoteUsers(token))
  var remote = []
  var suggested = {}
  for (var i = 0; i < matched.length; i++) {
    var m = matched[i]
    var entry = { value: m.remoteId, label: m.remoteName }
    if (m.protected) {
      entry.disabled = true
      entry.note = 'PIN protected, cannot be migrated'
    } else {
      if (m.external) entry.note = 'Watched flags only (from Plex history)'
      if (m.matineeId) suggested[m.remoteId] = m.matineeId
    }
    remote.push(entry)
  }
  var locals = matinee.users.list()
  var local = []
  for (var j = 0; j < locals.length; j++) {
    local.push({ value: locals[j].id, label: locals[j].username })
  }
  return { body: JSON.stringify({ remote: remote, local: local, suggested: suggested }) }
})

matinee.http.onRequest('run', function () {
  var cfg = matinee.getConfig()
  if (!cfg.server_url) {
    return { status: 400, body: JSON.stringify({ error: 'Enter the Plex server URL first.' }) }
  }
  if (!ownerToken()) {
    return { status: 400, body: JSON.stringify({ error: 'Link your Plex account first.' }) }
  }
  if (loadJSON('run.cursor')) {
    return { body: JSON.stringify({ message: 'Migration already running.' }) }
  }
  matinee.storage.set('run.request', '1')
  return { body: JSON.stringify({}) }
})

function runProgress(cursor) {
  var w = cursor.sections.length ? Math.min(cursor.sectionIdx / cursor.sections.length, 1) : 0
  if (cursor.phase === 'history') w = 0.5
  if (cursor.phase === 'reconcile' || cursor.phase === 'nextuser') w = 1
  var base = cursor.users.length ? (cursor.userIdx + w) / cursor.users.length : 0
  return Math.min(99, Math.floor(base * 100))
}

matinee.http.onRequest('last-run', function () {
  var lines = []
  var cursor = loadJSON('run.cursor')
  var queued = !cursor && matinee.storage.get('run.request') === '1'
  if (queued) {
    lines.push('Queued.')
  }
  if (cursor) {
    var user = cursor.users[cursor.userIdx]
    lines.push(
      'Running (' + (cursor.fullSync ? 'full sync' : 'additive') + '): user ' +
      (cursor.userIdx + 1) + ' of ' + cursor.users.length +
      (user ? ' (' + user.remoteName + ')' : '') + ', phase ' + cursor.phase + '.'
    )
  }
  var last = loadJSON('run.last')
  if (last && last.completedAt) {
    lines.push('Last run: ' + formatTime(last.completedAt) + (last.fullSync ? ' (full sync).' : '.'))
    for (var i = 0; i < (last.users || []).length; i++) {
      var u = last.users[i]
      lines.push(
        u.name + ': ' + u.updated + ' updated, ' + u.skipped + ' already current, ' +
        u.unmatched + ' unmatched' + (last.fullSync ? ', ' + u.unwatched + ' unwatched' : '') + '.'
      )
    }
  }
  if (!lines.length) lines.push('Never run.')
  var payload = { text: lines.join('\n'), busy: !!cursor || queued }
  if (cursor) payload.progress = runProgress(cursor)
  else if (queued) payload.progress = 0
  return { body: JSON.stringify(payload) }
})

function startRun() {
  matinee.storage.delete('run.request')
  userTokens = {}
  var cfg = matinee.getConfig()
  var token = ownerToken()
  if (!token) {
    matinee.log('migration skipped: Plex account not linked')
    return null
  }
  var matched
  try {
    matched = matchUsers(fetchRemoteUsers(token))
  } catch (e) {
    matinee.log('migration skipped: ' + (e && e.message ? e.message : String(e)))
    return null
  }
  var resolved = resolvePairs(matched, true)
  var users = []
  for (var i = 0; i < resolved.length; i++) {
    var m = resolved[i]
    users.push({
      remoteId: m.remoteId,
      remoteName: m.remoteName,
      external: m.external === true,
      accountId: m.accountId || null,
      matineeId: m.matineeId,
      stats: { updated: 0, skipped: 0, unmatched: 0, unwatched: 0 }
    })
  }
  if (!users.length) {
    matinee.log('migration skipped: no Plex user is matched to a Matinee account')
    return null
  }
  var cursor = {
    users: users,
    userIdx: 0,
    phase: 'sections',
    sections: [],
    sectionIdx: 0,
    offset: 0,
    fullSync: cfg.full_sync === true,
    startedAt: Date.now()
  }
  saveJSON('run.cursor', cursor)
  matinee.log('migration started: ' + users.length + ' user(s), ' + (cursor.fullSync ? 'full sync' : 'additive'))
  return cursor
}

// Lists the movie and show sections with the current user's token, so per-user library restrictions apply naturally
function stepSections(cursor) {
  var user = cursor.users[cursor.userIdx]
  matinee.log('migrating ' + user.remoteName + ' (' + (cursor.userIdx + 1) + ' of ' + cursor.users.length + ')')
  if (user.external) {
    cursor.offset = 0
    cursor.phase = 'history'
    return
  }
  var data = plexRequest('GET', baseUrl() + '/library/sections', tokenFor(user))
  var dirs = ((data && data.MediaContainer) || {}).Directory || []
  cursor.sections = []
  for (var i = 0; i < dirs.length; i++) {
    var d = dirs[i]
    if (!d || !d.key) continue
    if (d.type === 'movie') cursor.sections.push({ key: String(d.key), kind: 'movie' })
    else if (d.type === 'show') cursor.sections.push({ key: String(d.key), kind: 'show' })
  }
  saveJSON('run.seriesmap', {})
  dbg(user.remoteName + ': ' + cursor.sections.length + ' section(s)')
  cursor.sectionIdx = 0
  cursor.offset = 0
  cursor.phase = cursor.sections.length ? nextSectionPhase(cursor) : 'nextuser'
}

function nextSectionPhase(cursor) {
  return cursor.sections[cursor.sectionIdx].kind === 'movie' ? 'movies' : 'shows'
}

// Applies one source item's watch data to every mapped local file
function applyItem(user, item, files, states, universe, sourceWatched, fullSync) {
  var watched = Number(item.viewCount) > 0
  var position = Math.floor(Number(item.viewOffset || 0) / 1000)
  var lastPlayed = rfc3339(item.lastViewedAt)

  for (var i = 0; i < files.length; i++) {
    var fileId = files[i]
    if (fullSync) {
      universe[fileId] = true
      if (watched) sourceWatched[fileId] = true
    }
    var existing = states[fileId]
    if (fullSync) {
      var samePos = existing && Math.floor(existing.position_seconds) === position
      if (existing && existing.watched === watched && samePos) {
        user.stats.skipped++
        continue
      }
      var opts = { watched: watched, positionSeconds: position }
      if (lastPlayed) opts.lastPlayedAt = lastPlayed
      matinee.watch.setState(user.matineeId, fileId, opts)
      user.stats.updated++
      continue
    }
    if (watched) {
      if (existing && existing.watched) {
        user.stats.skipped++
        continue
      }
      var wopts = { watched: true }
      if (lastPlayed) wopts.lastPlayedAt = lastPlayed
      matinee.watch.setState(user.matineeId, fileId, wopts)
      user.stats.updated++
      continue
    }
    if (position > 0) {
      if (existing && (existing.watched || existing.position_seconds >= position)) {
        user.stats.skipped++
        continue
      }
      var popts = { positionSeconds: position }
      if (lastPlayed) popts.lastPlayedAt = lastPlayed
      matinee.watch.setState(user.matineeId, fileId, popts)
      user.stats.updated++
    }
  }
}

var stateCache = null

function loadStates(user) {
  if (!stateCache || stateCache.userId !== user.matineeId) {
    var map = {}
    var stored = matinee.watch.getStates(user.matineeId)
    for (var s = 0; s < stored.length; s++) map[stored[s].media_file_id] = stored[s]
    stateCache = { userId: user.matineeId, map: map }
  }
  return stateCache.map
}

function advancePage(cursor, container) {
  var total = Number(container.totalSize)
  if (!isFinite(total)) total = Number(container.size) || 0
  var user = cursor.users[cursor.userIdx]
  dbg(
    user.remoteName + ' section ' + cursor.sections[cursor.sectionIdx].key + ' ' + cursor.phase + ': ' +
    (container.Metadata || []).length + ' items at offset ' + cursor.offset + ' of ' + total +
    ' (' + user.stats.updated + ' updated, ' + user.stats.skipped + ' current, ' + user.stats.unmatched + ' unmatched)'
  )
  cursor.offset += PAGE_SIZE
  return cursor.offset >= total || !(container.Metadata || []).length
}

function stepMovies(cursor) {
  var user = cursor.users[cursor.userIdx]
  var container = sectionPage(tokenFor(user), cursor.sections[cursor.sectionIdx].key, 1, cursor.offset)
  var items = container.Metadata || []
  var states = loadStates(user)
  var universe = cursor.fullSync ? loadJSON('run.universe') || {} : {}
  var sourceWatched = cursor.fullSync ? loadJSON('run.watched') || {} : {}
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (!item) continue
    var relevant = cursor.fullSync || Number(item.viewCount) > 0 || Number(item.viewOffset) > 0
    if (!relevant) continue
    var ids = guidsOf(item)
    if (!hasProviderIds(ids)) {
      user.stats.unmatched++
      continue
    }
    var files = matinee.media.findByProviderIds(providerQuery('movie', ids))
    if (!files.length) {
      user.stats.unmatched++
      continue
    }
    applyItem(user, item, files, states, universe, sourceWatched, cursor.fullSync)
  }
  if (cursor.fullSync) {
    saveJSON('run.universe', universe)
    saveJSON('run.watched', sourceWatched)
  }
  if (advancePage(cursor, container)) {
    cursor.offset = 0
    cursor.phase = 'nextsection'
  }
}

function stepShows(cursor) {
  var user = cursor.users[cursor.userIdx]
  var container = sectionPage(tokenFor(user), cursor.sections[cursor.sectionIdx].key, 2, cursor.offset)
  var items = container.Metadata || []
  var map = loadJSON('run.seriesmap') || {}
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (item && item.ratingKey) map[String(item.ratingKey)] = guidsOf(item)
  }
  saveJSON('run.seriesmap', map)
  if (advancePage(cursor, container)) {
    cursor.offset = 0
    cursor.phase = 'episodes'
  }
}

function stepEpisodes(cursor) {
  var user = cursor.users[cursor.userIdx]
  var container = sectionPage(tokenFor(user), cursor.sections[cursor.sectionIdx].key, 4, cursor.offset)
  var items = container.Metadata || []
  var map = loadJSON('run.seriesmap') || {}
  var states = loadStates(user)
  var universe = cursor.fullSync ? loadJSON('run.universe') || {} : {}
  var sourceWatched = cursor.fullSync ? loadJSON('run.watched') || {} : {}
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (!item) continue
    var relevant = cursor.fullSync || Number(item.viewCount) > 0 || Number(item.viewOffset) > 0
    if (!relevant) continue
    var ids = map[String(item.grandparentRatingKey || '')] || {}
    var season = Number(item.parentIndex)
    var episode = Number(item.index)
    if (!hasProviderIds(ids) || !isFinite(season) || !isFinite(episode)) {
      user.stats.unmatched++
      continue
    }
    var files = matinee.media.findByProviderIds(providerQuery('episode', ids, season, episode))
    if (!files.length) {
      user.stats.unmatched++
      continue
    }
    applyItem(user, item, files, states, universe, sourceWatched, cursor.fullSync)
  }
  if (cursor.fullSync) {
    saveJSON('run.universe', universe)
    saveJSON('run.watched', sourceWatched)
  }
  if (advancePage(cursor, container)) {
    cursor.offset = 0
    cursor.phase = 'nextsection'
  }
}

// The full-sync pass that clears local watched flags the source has since dropped
function stepReconcile(cursor) {
  var user = cursor.users[cursor.userIdx]
  var universe = loadJSON('run.universe') || {}
  var sourceWatched = loadJSON('run.watched') || {}
  var stored = matinee.watch.getStates(user.matineeId)
  for (var i = 0; i < stored.length; i++) {
    var st = stored[i]
    if (!st.watched) continue
    if (!universe[st.media_file_id]) continue
    if (sourceWatched[st.media_file_id]) continue
    matinee.watch.setState(user.matineeId, st.media_file_id, { watched: false, positionSeconds: 0 })
    user.stats.unwatched++
  }
  dbg('reconcile ' + user.remoteName + ': ' + user.stats.unwatched + ' unwatched')
  cursor.phase = 'nextuser'
}

function stepNextSection(cursor) {
  cursor.sectionIdx++
  cursor.offset = 0
  if (cursor.sectionIdx < cursor.sections.length) {
    cursor.phase = nextSectionPhase(cursor)
    return
  }
  cursor.phase = cursor.fullSync ? 'reconcile' : 'nextuser'
}

// Resolves Plex ratingKey to its provider ids, cached across the run.
function guidsForRatingKey(ratingKey) {
  if (!ratingKey) return {}
  var map = loadJSON('run.rkmap') || {}
  var key = String(ratingKey)
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key]
  var ids = {}
  try {
    var data = plexRequest('GET', baseUrl() + '/library/metadata/' + encodeURIComponent(key) + '?includeGuids=1', ownerToken())
    var meta = ((data && data.MediaContainer) || {}).Metadata || []
    if (meta.length) ids = guidsOf(meta[0])
  } catch (e) {
    // unresolvable ratingKey
  }
  map[key] = ids
  saveJSON('run.rkmap', map)
  return ids
}

function stepHistory(cursor) {
  var user = cursor.users[cursor.userIdx]
  var url = baseUrl() + '/status/sessions/history/all?' + qs({
    accountID: user.accountId,
    'X-Plex-Container-Start': cursor.offset,
    'X-Plex-Container-Size': PAGE_SIZE,
    sort: 'viewedAt:desc'
  })
  var container = ((plexRequest('GET', url, ownerToken()) || {}).MediaContainer) || {}
  var items = container.Metadata || []
  var states = loadStates(user)
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (!item) continue
    var files = []
    if (item.type === 'movie') {
      var mids = guidsForRatingKey(item.ratingKey)
      if (hasProviderIds(mids)) files = matinee.media.findByProviderIds(providerQuery('movie', mids))
    } else if (item.type === 'episode') {
      var sids = guidsForRatingKey(item.grandparentRatingKey)
      var season = Number(item.parentIndex)
      var episode = Number(item.index)
      if (hasProviderIds(sids) && isFinite(season) && isFinite(episode)) {
        files = matinee.media.findByProviderIds(providerQuery('episode', sids, season, episode))
      }
    }
    if (!files.length) {
      user.stats.unmatched++
      continue
    }
    var lastPlayed = rfc3339(item.viewedAt)
    for (var f = 0; f < files.length; f++) {
      var existing = states[files[f]]
      if (existing && existing.watched) {
        user.stats.skipped++
        continue
      }
      var opts = { watched: true }
      if (lastPlayed) opts.lastPlayedAt = lastPlayed
      matinee.watch.setState(user.matineeId, files[f], opts)
      user.stats.updated++
    }
  }
  var total = Number(container.totalSize)
  if (!isFinite(total)) total = Number(container.size) || 0
  dbg(user.remoteName + ' history: ' + items.length + ' at offset ' + cursor.offset + ' of ' + total +
    ' (' + user.stats.updated + ' updated, ' + user.stats.skipped + ' current, ' + user.stats.unmatched + ' unmatched)')
  cursor.offset += PAGE_SIZE
  if (cursor.offset >= total || !items.length) {
    cursor.phase = 'nextuser'
  }
}

// Goes to the next user or finishes the run with a summary
function stepNextUser(cursor) {
  var done = cursor.users[cursor.userIdx]
  matinee.log(
    'migrated ' + done.remoteName + ': ' + done.stats.updated + ' updated, ' +
    done.stats.skipped + ' already current, ' + done.stats.unmatched + ' unmatched' +
    (cursor.fullSync ? ', ' + done.stats.unwatched + ' unwatched' : '')
  )
  matinee.storage.delete('run.universe')
  matinee.storage.delete('run.watched')
  cursor.userIdx++
  cursor.phase = 'sections'
  cursor.offset = 0
  if (cursor.userIdx >= cursor.users.length) {
    var summary = { completedAt: Date.now(), fullSync: cursor.fullSync, users: [] }
    for (var i = 0; i < cursor.users.length; i++) {
      var u = cursor.users[i]
      summary.users.push({
        name: u.remoteName,
        updated: u.stats.updated,
        skipped: u.stats.skipped,
        unmatched: u.stats.unmatched,
        unwatched: u.stats.unwatched
      })
    }
    saveJSON('run.last', summary)
    matinee.storage.delete('run.cursor')
    matinee.storage.delete('run.seriesmap')
    matinee.storage.delete('run.rkmap')
    matinee.log('migration complete: ' + cursor.users.length + ' user(s)')
    act({ key: 'migration', done: true, message: 'Plex migration complete: ' + cursor.users.length + ' user(s)' })
    return false
  }
  return true
}

function step(cursor) {
  try {
    if (cursor.phase === 'sections') stepSections(cursor)
    else if (cursor.phase === 'history') stepHistory(cursor)
    else if (cursor.phase === 'movies') stepMovies(cursor)
    else if (cursor.phase === 'shows') stepShows(cursor)
    else if (cursor.phase === 'episodes') stepEpisodes(cursor)
    else if (cursor.phase === 'reconcile') stepReconcile(cursor)
    if (cursor.phase === 'nextsection') stepNextSection(cursor)
    if (cursor.phase === 'nextuser' && !stepNextUser(cursor)) return false
    if (cursor.retries) cursor.retries = 0
    saveJSON('run.cursor', cursor)
    return true
  } catch (e) {
    cursor.retries = (cursor.retries || 0) + 1
    saveJSON('run.cursor', cursor)
    matinee.log('migration error (attempt ' + cursor.retries + ', will retry): ' + (e && e.message ? e.message : String(e)))
    return false
  }
}

matinee.schedule(1, function () {
  stateCache = null
  if (!ownerToken()) checkPin()

  var cursor = loadJSON('run.cursor')
  if (!cursor) {
    if (matinee.storage.get('run.request') !== '1') return
    cursor = startRun()
    if (!cursor) return
  }
  var start = Date.now()
  var maxStep = 5000
  while (true) {
    var reserve = maxStep * 1.5
    if (Date.now() - start + reserve > TICK_BUDGET_MS) break
    var t0 = Date.now()
    var ok = step(cursor)
    var took = Date.now() - t0
    if (took > maxStep) maxStep = took
    if (!ok) break
    cursor = loadJSON('run.cursor')
    if (!cursor) break
  }
  if (cursor && loadJSON('run.cursor')) {
    var current = cursor.users[cursor.userIdx]
    act({
      key: 'migration',
      title: 'Migrating ' + (current ? current.remoteName : '') + ' (' + (cursor.userIdx + 1) + ' of ' + cursor.users.length + ')',
      progress: runProgress(cursor)
    })
  }
})

matinee.log('migrate-plex v' + matinee.manifest.version + ' loaded')
