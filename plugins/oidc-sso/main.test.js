// Copyright (C) 2024-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Node tests for the pure half of oidc-sso, meaning the id token decoding, the
// claim mapping and the state nonce bookkeeping.
// Run them from the repository root with node --test "plugins/**/*.test.js"

'use strict'

var test = require('node:test')
var assert = require('node:assert')

var config = {}
var store = {}

global.matinee = {
  manifest: { id: 'oidc-sso', name: 'OpenID Connect Single Sign-on', version: 'test' },
  log: function () {},
  debug: function () {},
  getConfig: function () { return config },
  auth: { registerProvider: function () {}, issueTicket: function () { return 'ticket' } },
  http: {
    fetch: function () { throw new Error('no network in tests') },
    onRequest: function () {},
    onCallback: function () {}
  },
  storage: {
    get: function (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null },
    set: function (key, value) { store[key] = value },
    delete: function (key) { delete store[key] }
  }
}

var plugin = require('./main.js')

function jwt(payload) {
  var body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return 'eyJhbGciOiJSUzI1NiJ9.' + body + '.signature'
}

test('the id token payload decodes with padding-free base64url and non-ASCII names', function () {
  var claims = plugin.idTokenClaims(jwt({ sub: 'abc', name: 'Zoë Müller', groups: ['a'] }))
  assert.strictEqual(claims.sub, 'abc')
  assert.strictEqual(claims.name, 'Zoë Müller')
  assert.deepStrictEqual(claims.groups, ['a'])
  assert.throws(function () { plugin.idTokenClaims('not-a-jwt') }, /JWT/)
})

test('claims map onto the identity and the admin group decides the admin flag', function () {
  config = { admin_group: 'matinee-admins' }
  var cfg = plugin.settings()
  var identity = plugin.identityFromClaims({
    sub: 'sub-1',
    preferred_username: 'anna',
    email: 'anna@example.com',
    given_name: 'Anna',
    family_name: 'Reber',
    groups: ['staff', 'matinee-admins']
  }, cfg)
  assert.deepStrictEqual(identity, {
    id: 'sub-1',
    username: 'anna',
    email: 'anna@example.com',
    first_name: 'Anna',
    last_name: 'Reber',
    admin: true
  })
  assert.strictEqual(plugin.identityFromClaims({ sub: 's', preferred_username: 'x', groups: ['staff'] }, cfg).admin, false)
  assert.strictEqual(plugin.identityFromClaims({ sub: 's', preferred_username: 'x' }, cfg).admin, false)
})

test('without an admin group the admin flag is left to Matinee and custom claims apply', function () {
  config = { username_claim: 'upn', email_claim: 'mail' }
  var identity = plugin.identityFromClaims({ sub: 's', upn: 'anna@corp', mail: 'a@corp.test', groups: ['x'] }, plugin.settings())
  assert.strictEqual(identity.username, 'anna@corp')
  assert.strictEqual(identity.email, 'a@corp.test')
  assert.strictEqual(identity.admin, undefined)
  assert.throws(function () { plugin.identityFromClaims({ sub: 's' }, plugin.settings()) }, /upn/)
  assert.throws(function () { plugin.identityFromClaims({ upn: 'x' }, plugin.settings()) }, /sub/)
})

test('a state nonce is spent once and ages out', function () {
  store = {}
  var now = 1000000
  plugin.rememberState('fresh', now)
  plugin.rememberState('stale', now - 11 * 60 * 1000)
  assert.strictEqual(plugin.consumeState('stale', now), false)
  assert.strictEqual(plugin.consumeState('fresh', now), true)
  assert.strictEqual(plugin.consumeState('fresh', now), false)
  assert.strictEqual(plugin.consumeState('unknown', now), false)
})

test('the web origin falls back to the API origin without its /api suffix', function () {
  assert.strictEqual(plugin.webBase({ baseUrl: 'https://host/api', webUrl: 'https://watch.example.test/' }), 'https://watch.example.test')
  assert.strictEqual(plugin.webBase({ baseUrl: 'https://host/api', webUrl: '' }), 'https://host')
})
