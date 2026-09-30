// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Node tests for the request spotify-sync sends to the server's track matcher.
// Run them from the repository root with node --test "plugins/**/*.test.js"

'use strict'

var test = require('node:test')
var assert = require('node:assert')

// main.js registers its hooks at load time, so the host object has to exist
// before the require. Only the surface touched at top level is stubbed
var store = {}
var callback = null
global.matinee = {
  manifest: { version: 'test' },
  log: function () {},
  debug: function () {},
  getConfig: function () { return {} },
  schedule: function () {},
  storage: {
    get: function (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null },
    set: function (key, value) { store[key] = value },
    delete: function (key) { delete store[key] }
  },
  http: {
    fetch: function () { throw new Error('no network in tests') },
    onRequest: function () {},
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

// The callback is public, so an unauthenticated hit with a wrong state must leave the admin's connect in progress alone
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
