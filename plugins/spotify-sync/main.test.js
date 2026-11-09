// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Tests the request spotify-sync sends to the server's track matcher, its OAuth callback and its sync hooks

'use strict'

var test = require('node:test')
var assert = require('node:assert')

// main.js registers its hooks at load time, so the host stub has to exist before the require
var store = {}
var callback = null
var hooks = {}
var config = {}
var tick = null
global.matinee = {
  manifest: { version: 'test' },
  log: function () {},
  debug: function () {},
  getConfig: function () { return config },
  schedule: function (minutes, fn) { tick = fn },
  storage: {
    get: function (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null },
    set: function (key, value) { store[key] = value },
    delete: function (key) { delete store[key] }
  },
  http: {
    fetch: function () { throw new Error('no network in tests') },
    onRequest: function (name, fn) { hooks[name] = fn },
    onCallback: function (fn) { callback = fn }
  }
}

var plugin = require('./main.js')
var matchTrack = plugin.matchTrack

test('the server matcher gets every artist, the duration and the ISRC of a track', function () {
  var asked = null
  global.matinee.music = {
    matchTrack: function (def) {
      asked = def
      return { media_file_id: 'file-1' }
    }
  }
  var answer = matchTrack({
    name: 'Shut Your Mouth',
    artists: [{ name: 'PAIN' }, { name: 'Peter Tagtgren' }],
    album: { name: 'Dancing with the Dead' },
    duration_ms: 203000,
    external_ids: { isrc: 'SEWNM0500101' }
  }, 'michael')
  assert.deepStrictEqual(asked, {
    title: 'Shut Your Mouth',
    artists: ['PAIN', 'Peter Tagtgren'],
    album: 'Dancing with the Dead',
    duration_ms: 203000,
    isrc: 'SEWNM0500101',
    username: 'michael'
  })
  assert.strictEqual(answer.media_file_id, 'file-1')
})

test('a track without duration or ISRC still reaches the matcher with empty values', function () {
  var asked = null
  global.matinee.music = {
    matchTrack: function (def) {
      asked = def
      return null
    }
  }
  assert.strictEqual(matchTrack({ name: 'Home', artists: [{ name: 'Sia' }] }, 'michael'), null)
  assert.strictEqual(asked.duration_ms, 0)
  assert.strictEqual(asked.isrc, '')
  assert.strictEqual(asked.album, '')
})

test('a stray callback hit does not cancel the connect in progress', function () {
  store = {}
  var pending = JSON.stringify({ state: 'right', verifier: 'v', redirectUri: 'https://host/api/plugins/spotify-sync/callback', createdAt: Date.now() })
  store['oauth.pending'] = pending
  var answer = callback({ query: { state: 'forged', code: 'x' }, webUrl: 'https://host' })
  assert.match(answer.redirect, /spotify=error$/)
  assert.strictEqual(store['oauth.pending'], pending)

  answer = callback({ query: { state: 'right', error: 'access_denied' }, webUrl: 'https://host' })
  assert.match(answer.redirect, /spotify=error$/)
  assert.strictEqual(store['oauth.pending'], undefined)
})

function hook(name, req) {
  return JSON.parse(hooks[name](req || { webUrl: 'https://host' }).body)
}

test('the connection row carries no sync progress, the sync status row below "Sync now" does', function () {
  store = { 'oauth.tokens': JSON.stringify({ access_token: 'a' }), 'oauth.profile': JSON.stringify({ name: 'Mi Re' }) }
  store['sync.cursor'] = JSON.stringify({ playlists: ['a', 'b', 'c', 'd'], idx: 1, offset: 120, total: 300 })
  var connection = hook('status')
  assert.strictEqual(connection.text, 'Connected as Mi Re.')
  assert.strictEqual(connection.busy, undefined)

  var last = hook('sync-status')
  assert.strictEqual(last.text, 'Syncing playlist 2 of 4, track 120 of 300')
  assert.strictEqual(last.busy, true)
  assert.strictEqual(last.progress, 25)

  store = {}
  assert.deepStrictEqual(hook('sync-status'), { text: 'No sync has run yet.', busy: false })
})

test('"Sync now" during a run adds the newly ticked playlists to that run and keeps its place', function () {
  store = { 'sync.cursor': JSON.stringify({ playlists: ['a', 'b'], idx: 1, offset: 40, total: 90 }) }
  config = { playlists: ['a', 'b', 'c', 'd'] }
  assert.strictEqual(hook('sync-now').message, 'Added 2 playlists to the running sync.')
  var cursor = JSON.parse(store['sync.cursor'])
  assert.deepStrictEqual(cursor.playlists, ['a', 'b', 'c', 'd'])
  assert.strictEqual(cursor.idx, 1)
  assert.strictEqual(cursor.offset, 40)

  assert.strictEqual(hook('sync-now').message, 'A sync is already running.')
  assert.strictEqual(store['sync.request'], undefined)

  store = {}
  assert.deepStrictEqual(hook('sync-now'), {})
  assert.strictEqual(store['sync.request'], '1')
  config = {}
})

// The host runs hooks and ticks of one plugin one at a time, so "Sync now" always lands between two ticks
test('playlists added by "Sync now" between two ticks are synced by the next tick', function () {
  var failNext = true
  var created = []
  store = { 'oauth.tokens': JSON.stringify({ access_token: 'a', expires_at: Date.now() + 3600000 }), 'sync.request': '1' }
  config = { playlists: ['a'], owner_username: 'michael' }
  global.matinee.music = { matchTrack: function () { return { media_file_id: 'file' } } }
  global.matinee.playlists = {
    create: function (owner, name) { created.push(name); return 'pl-' + name },
    clearGhostTracks: function () {},
    addTrack: function () {},
    addGhostTrack: function () {},
    reconcileTracks: function () { return 0 }
  }
  global.matinee.http.fetch = function (url) {
    var id = /\/v1\/playlists\/([^/?]+)/.exec(url)[1]
    if (url.indexOf('/items?') === -1) return { status: 200, headers: {}, body: JSON.stringify({ name: id }) }
    if (failNext) {
      failNext = false
      return { status: 500, headers: {}, body: '' }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ total: 1, items: [{ item: { id: 't-' + id, name: 'T', type: 'track' } }] }) }
  }

  tick()
  assert.deepStrictEqual(JSON.parse(store['sync.cursor']).playlists, ['a'])

  config = { playlists: ['a', 'b'], owner_username: 'michael' }
  assert.strictEqual(hook('sync-now').message, 'Added 1 playlist to the running sync.')

  tick()
  assert.deepStrictEqual(created, ['a', 'b'])
  assert.strictEqual(store['sync.cursor'], undefined)
  assert.strictEqual(JSON.parse(store['sync.last']).stats.matched, 2)
  global.matinee.http.fetch = function () { throw new Error('no network in tests') }
  config = {}
})
