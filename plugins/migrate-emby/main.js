// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Anna Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Copies Emby watched flags and resume positions into mapped Matinee accounts

'use strict'

var PAGE_SIZE = 200
var TICK_BUDGET_MS = 55000
var STATUS_CACHE_MS = 30000

var statusCache = null

function dbg(msg) {
  if (typeof matinee.debug === 'function') matinee.debug(msg)
}

function act(def) {
  if (typeof matinee.activity === 'function') matinee.activity(def)
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many)
}

function sentence(text) {
  text = String(text).trim()
  return /[.!?]$/.test(text) ? text : text + '.'
}

var PHASES = { seriesmap: 'matching series', items: 'copying watch states', reconcile: 'unwatching items', nextuser: 'finishing the user' }

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

function baseUrl() {
  var cfg = matinee.getConfig()
  return String(cfg.server_url || '').replace(/\/+$/, '')
}

function embyGet(path, params) {
  var cfg = matinee.getConfig()
  var url = baseUrl() + path
  if (params) url += (path.indexOf('?') === -1 ? '?' : '&') + qs(params)
  var res = matinee.http.fetch(url, {
    method: 'GET',
    headers: { 'X-Emby-Token': String(cfg.api_key || '') },
    insecure: Boolean(cfg.insecure)
  })
  if (res.status >= 400) {
    throw new Error('Emby answered ' + res.status + ' for ' + path.split('?')[0])
  }
  return JSON.parse(res.body)
}

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
      matineeId: local ? local.id : null,
      matineeName: local ? local.username : null
    })
  }
  return out
}

// Explicit user pairs take precedence over name matches. Deleted Matinee accounts are skipped
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
    if (hasPairs) {
      var localId = pairs[m.remoteId]
      if (!localId) continue
      var local = byId[String(localId)]
      if (!local) {
        if (logSkips) matinee.log('skipping ' + m.remoteName + ': assigned Matinee user no longer exists')
        continue
      }
      out.push({ remoteId: m.remoteId, remoteName: m.remoteName, matineeId: local.id, matineeName: local.username })
    } else if (m.matineeId) {
      out.push({ remoteId: m.remoteId, remoteName: m.remoteName, matineeId: m.matineeId, matineeName: m.matineeName })
    }
  }
  return out
}

function fetchRemoteUsers() {
  var users = embyGet('/Users')
  var out = []
  for (var i = 0; i < users.length; i++) {
    if (users[i] && users[i].Id) out.push({ id: String(users[i].Id), name: String(users[i].Name || users[i].Id) })
  }
  return out
}

function providerIdsOf(item) {
  var ids = item && item.ProviderIds
  if (!ids) return {}
  var out = {}
  for (var key in ids) {
    if (Object.prototype.hasOwnProperty.call(ids, key)) {
      out[key.toLowerCase()] = String(ids[key] || '')
    }
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

function formatTime(ms) {
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  } catch (e) {
    return String(ms)
  }
}

function rfc3339(raw) {
  if (!raw) return ''
  try {
    var t = new Date(String(raw))
    if (isNaN(t.getTime())) return ''
    return t.toISOString()
  } catch (e) {
    return ''
  }
}

// Cached briefly, because the modal polls this every few seconds and each answer costs two Emby round trips
matinee.http.onRequest('status', function () {
  var cfg = matinee.getConfig()
  if (!cfg.server_url || !cfg.api_key) {
    return { body: JSON.stringify({ text: 'Enter the Emby server URL and API key, then save.' }) }
  }
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return { body: statusCache.body }
  }
  var lines = []
  try {
    var info = embyGet('/System/Info')
    lines.push('Connected to ' + (info.ServerName || 'Emby') + ' (version ' + (info.Version || 'unknown') + ').')
    var matched = matchUsers(fetchRemoteUsers())
    var resolved = resolvePairs(matched, false)
    var names = []
    for (var i = 0; i < resolved.length; i++) {
      names.push(resolved[i].remoteName + ' -> ' + resolved[i].matineeName)
    }
    lines.push(plural(matched.length, 'Emby user', 'Emby users') + ', ' + resolved.length + ' paired for the migration')
    if (names.length) lines.push(names.join(', '))
  } catch (e) {
    var errBody = JSON.stringify({ text: 'Could not connect. ' + sentence(e && e.message ? e.message : String(e)) + ' Check the server URL and API key.' })
    statusCache = { at: Date.now(), body: errBody }
    return { body: errBody }
  }
  var body = JSON.stringify({ text: lines.join('\n') })
  statusCache = { at: Date.now(), body: body }
  return { body: body }
})

matinee.http.onRequest('users', function () {
  var cfg = matinee.getConfig()
  if (!cfg.server_url || !cfg.api_key) {
    return { status: 400, body: JSON.stringify({ error: 'Enter the Emby server URL and API key first.' }) }
  }
  var matched = matchUsers(fetchRemoteUsers())
  var remote = []
  var suggested = {}
  for (var i = 0; i < matched.length; i++) {
    var m = matched[i]
    remote.push({ value: m.remoteId, label: m.remoteName })
    if (m.matineeId) suggested[m.remoteId] = m.matineeId
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
  if (!cfg.server_url || !cfg.api_key) {
    return { status: 400, body: JSON.stringify({ error: 'Enter the Emby server URL and API key first.' }) }
  }
  if (loadJSON('run.cursor')) {
    return { body: JSON.stringify({ message: 'A migration is already running.' }) }
  }
  matinee.storage.set('run.request', '1')
  return { body: JSON.stringify({}) }
})

// Rough completion estimate made of finished users plus the current user's phase
function runProgress(cursor) {
  var frac = cursor.total > 0 ? Math.min(cursor.offset / cursor.total, 1) : 0
  var w = 0
  if (cursor.phase === 'items') w = cursor.fullSync ? frac : (cursor.pass + frac) / 2
  else if (cursor.phase === 'reconcile' || cursor.phase === 'nextuser') w = 1
  var base = cursor.users.length ? (cursor.userIdx + w) / cursor.users.length : 0
  return Math.min(99, Math.floor(base * 100))
}

matinee.http.onRequest('last-run', function () {
  var lines = []
  var cursor = loadJSON('run.cursor')
  var queued = !cursor && matinee.storage.get('run.request') === '1'
  if (queued) {
    lines.push('The migration is queued.')
  }
  if (cursor) {
    var user = cursor.users[cursor.userIdx]
    lines.push(
      'Migrating ' + (user ? user.remoteName + ', ' : '') + 'user ' + (cursor.userIdx + 1) + ' of ' + cursor.users.length +
      ', ' + (PHASES[cursor.phase] || cursor.phase) + (cursor.fullSync ? ', full sync' : '')
    )
  }
  var last = loadJSON('run.last')
  if (last && last.completedAt) {
    lines.push('Last run: ' + formatTime(last.completedAt) + (last.fullSync ? ', full sync' : ''))
    for (var i = 0; i < (last.users || []).length; i++) {
      var u = last.users[i]
      lines.push(
        u.name + ': ' + u.updated + ' updated, ' + u.skipped + ' already current, ' +
        u.unmatched + ' unmatched' + (last.fullSync ? ', ' + u.unwatched + ' unwatched' : '')
      )
    }
  }
  if (!lines.length) lines.push('The migration has not run yet.')
  var payload = { text: lines.join('\n'), busy: !!cursor || queued }
  if (cursor) payload.progress = runProgress(cursor)
  else if (queued) payload.progress = 0
  return { body: JSON.stringify(payload) }
})

function startRun() {
  matinee.storage.delete('run.request')
  var cfg = matinee.getConfig()
  var matched
  try {
    matched = matchUsers(fetchRemoteUsers())
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
      matineeId: m.matineeId,
      stats: { updated: 0, skipped: 0, unmatched: 0, unwatched: 0 }
    })
  }
  if (!users.length) {
    matinee.log('migration skipped: no Emby user is matched to a Matinee account')
    return null
  }
  var cursor = {
    users: users,
    userIdx: 0,
    phase: 'seriesmap',
    pass: 0,
    offset: 0,
    fullSync: cfg.full_sync === true,
    startedAt: Date.now()
  }
  saveJSON('run.seriesmap', {})
  saveJSON('run.cursor', cursor)
  matinee.log('migration started for ' + plural(users.length, 'user', 'users') + ', ' + (cursor.fullSync ? 'full sync' : 'additive'))
  return cursor
}

// Episode matching needs the provider IDs of each parent series
function stepSeriesMap(cursor) {
  var page = embyGet('/Items', {
    IncludeItemTypes: 'Series',
    Recursive: 'true',
    Fields: 'ProviderIds',
    StartIndex: cursor.offset,
    Limit: PAGE_SIZE
  })
  var map = loadJSON('run.seriesmap') || {}
  var items = page.Items || []
  for (var i = 0; i < items.length; i++) {
    if (items[i] && items[i].Id) map[String(items[i].Id)] = providerIdsOf(items[i])
  }
  saveJSON('run.seriesmap', map)
  var mapped = 0
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k)) mapped++
  }
  dbg('series map: ' + items.length + ' series at offset ' + cursor.offset + ' of ' + (Number(page.TotalRecordCount) || 0) + ', ' + mapped + ' mapped')
  cursor.offset += PAGE_SIZE
  if (!items.length || cursor.offset >= (Number(page.TotalRecordCount) || 0)) {
    matinee.log('series map complete: ' + mapped + ' series')
    cursor.phase = 'items'
    cursor.pass = 0
    cursor.offset = 0
  }
}

function resolveItem(item, seriesMap) {
  if (item.Type === 'Movie') {
    var mids = providerIdsOf(item)
    if (!hasProviderIds(mids)) return []
    return matinee.media.findByProviderIds(providerQuery('movie', mids))
  }
  if (item.Type === 'Episode') {
    var ids = seriesMap[String(item.SeriesId || '')] || {}
    if (!hasProviderIds(ids)) return []
    var season = Number(item.ParentIndexNumber)
    var episode = Number(item.IndexNumber)
    if (!isFinite(season) || !isFinite(episode)) return []
    return matinee.media.findByProviderIds(providerQuery('episode', ids, season, episode))
  }
  return []
}

function writeState(userId, fileId, opts, states) {
  matinee.watch.setState(userId, fileId, opts)
  var state = states[fileId] || { media_file_id: fileId, watched: false, position_seconds: 0 }
  if (typeof opts.watched === 'boolean') state.watched = opts.watched
  if (typeof opts.positionSeconds === 'number') state.position_seconds = opts.positionSeconds
  if (opts.lastPlayedAt) state.last_played_at = opts.lastPlayedAt
  states[fileId] = state
}

// Default mode never regresses local state, while full sync mirrors the source values
function applyItem(user, item, files, states, universe, sourceWatched, fullSync) {
  var data = item.UserData || {}
  var watched = data.Played === true
  var position = Math.floor(Number(data.PlaybackPositionTicks || 0) / 10000000)
  var lastPlayed = rfc3339(data.LastPlayedDate)

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
      writeState(user.matineeId, fileId, opts, states)
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
      writeState(user.matineeId, fileId, wopts, states)
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
      writeState(user.matineeId, fileId, popts, states)
      user.stats.updated++
    }
  }
}

function stepItems(cursor) {
  var user = cursor.users[cursor.userIdx]
  if (cursor.offset === 0 && cursor.pass === 0) {
    matinee.log('migrating ' + user.remoteName + ' (' + (cursor.userIdx + 1) + ' of ' + cursor.users.length + ')')
  }
  var seriesMap = loadJSON('run.seriesmap') || {}
  var params = {
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Episode',
    Fields: 'ProviderIds',
    EnableUserData: 'true',
    StartIndex: cursor.offset,
    Limit: PAGE_SIZE
  }
  if (!cursor.fullSync) {
    params.Filters = cursor.pass === 0 ? 'IsPlayed' : 'IsResumable'
  }
  var page = embyGet('/Users/' + encodeURIComponent(user.remoteId) + '/Items', params)
  cursor.total = Number(page.TotalRecordCount) || 0

  var states = loadStates(user)
  var universe = cursor.fullSync ? loadJSON('run.universe') || {} : {}
  var sourceWatched = cursor.fullSync ? loadJSON('run.watched') || {} : {}

  var items = page.Items || []
  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    if (!item || !item.Id) continue
    var files = resolveItem(item, seriesMap)
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
  dbg(
    user.remoteName + (cursor.fullSync ? '' : ' pass ' + (cursor.pass + 1)) + ': ' + items.length +
    ' items at offset ' + cursor.offset + ' of ' + (Number(page.TotalRecordCount) || 0) +
    ' (' + user.stats.updated + ' updated, ' + user.stats.skipped + ' current, ' + user.stats.unmatched + ' unmatched)'
  )

  cursor.offset += PAGE_SIZE
  if (!items.length || cursor.offset >= (Number(page.TotalRecordCount) || 0)) {
    cursor.offset = 0
    if (!cursor.fullSync && cursor.pass === 0) {
      cursor.pass = 1
      return
    }
    cursor.phase = cursor.fullSync ? 'reconcile' : 'nextuser'
  }
}

// Full sync clears watched state only for files known to the source
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
  cursor.phase = 'items'
  cursor.pass = 0
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
    matinee.log('migration complete for ' + plural(cursor.users.length, 'user', 'users'))
    act({ key: 'migration', done: true, message: 'Emby migration finished for ' + plural(cursor.users.length, 'user', 'users') })
    return false
  }
  return true
}

function step(cursor) {
  try {
    if (cursor.phase === 'seriesmap') stepSeriesMap(cursor)
    else if (cursor.phase === 'items') stepItems(cursor)
    else if (cursor.phase === 'reconcile') stepReconcile(cursor)
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

// Reserve time for another page before the host's 60-second interrupt
matinee.schedule(1, function () {
  stateCache = null
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
      title: current
        ? 'Migrating ' + current.remoteName + ' (' + (cursor.userIdx + 1) + ' of ' + cursor.users.length + ')'
        : 'Migrating user ' + (cursor.userIdx + 1) + ' of ' + cursor.users.length,
      progress: runProgress(cursor)
    })
  }
})

matinee.log('migrate-emby v' + matinee.manifest.version + ' loaded')
