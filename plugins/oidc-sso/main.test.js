// Copyright (C) 2024-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Node tests for oidc-sso, from the id token decoding and the claim mapping to a whole sign-in against a
// fake provider. Run them from the repository root with node --test "plugins/**/*.test.js"

'use strict'

var test = require('node:test')
var assert = require('node:assert')
var nodeCrypto = require('node:crypto')

var config = {}
var store = {}
var fetches = []
var provider = {}

global.matinee = {
  manifest: { id: 'oidc-sso', name: 'OpenID Connect Single Sign-on', version: 'test' },
  log: function () {},
  debug: function () {},
  getConfig: function () { return config },
  auth: { registerProvider: function () {}, issueTicket: function () { return 'ticket' } },
  http: {
    fetch: function (url, opts) {
      fetches.push({ url: url, opts: opts })
      var answer = provider[url.split('?')[0]]
      if (!answer) throw new Error('no network in tests')
      return { status: 200, body: JSON.stringify(typeof answer === 'function' ? answer(opts) : answer) }
    },
    onRequest: function () {},
    onCallback: function () {}
  },
  crypto: {
    randomToken: function (n) { return nodeCrypto.randomBytes(n || 32).toString('base64url') },
    sha256: function (text, encoding) {
      return nodeCrypto.createHash('sha256').update(String(text), 'utf8').digest(encoding === 'base64url' ? 'base64url' : 'hex')
    },
    base64Decode: function (text) { return Buffer.from(String(text), 'base64url').toString('utf8') }
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

test('a started sign-in is spent once and ages out', function () {
  store = {}
  var now = 1000000
  plugin.rememberState('fresh', 'verifier', 'nonce', now)
  plugin.rememberState('stale', 'v', 'n', now - 11 * 60 * 1000)
  assert.strictEqual(plugin.consumeState('stale', now), null)
  assert.deepStrictEqual(plugin.consumeState('fresh', now), { verifier: 'verifier', nonce: 'nonce' })
  assert.strictEqual(plugin.consumeState('fresh', now), null)
  assert.strictEqual(plugin.consumeState('unknown', now), null)
})

// Provider at https://idp.test whose token endpoint answers with an id token carrying the given nonce
function fakeProvider(nonceFor) {
  provider = {
    'https://idp.test/.well-known/openid-configuration': {
      issuer: 'https://idp.test',
      authorization_endpoint: 'https://idp.test/auth',
      token_endpoint: 'https://idp.test/token'
    },
    'https://idp.test/token': function (opts) {
      var form = new URLSearchParams(opts.body)
      return { id_token: jwt({ iss: 'https://idp.test', aud: 'matinee', sub: 'sub-1', preferred_username: 'anna', nonce: nonceFor(form) }) }
    }
  }
}

function startSignIn() {
  var req = { baseUrl: 'https://host/api', webUrl: 'https://host', query: { start: '1' }, cookies: {} }
  var answer = plugin.start(req)
  var url = new URL(answer.redirect)
  return { answer: answer, url: url, state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce') }
}

test('a sign-in sends PKCE and a nonce and finishes in the browser that started it', function () {
  store = {}
  fetches = []
  config = { issuer: 'https://idp.test', client_id: 'matinee', client_secret: 'secret' }
  var started = null
  fakeProvider(function () { return started.nonce })
  started = startSignIn()
  assert.strictEqual(started.url.searchParams.get('code_challenge_method'), 'S256')
  assert.deepStrictEqual(started.answer.cookies, [{ name: 'state', value: started.state, maxAge: 600 }])

  var done = plugin.finish({ baseUrl: 'https://host/api', webUrl: 'https://host', query: { code: 'c', state: started.state }, cookies: { state: started.state } })
  assert.match(done.redirect, /sso_ticket=ticket$/)
  var tokenCall = fetches.filter(function (f) { return f.url === 'https://idp.test/token' })[0]
  var verifier = new URLSearchParams(tokenCall.opts.body).get('code_verifier')
  assert.strictEqual(nodeCrypto.createHash('sha256').update(verifier).digest('base64url'), started.url.searchParams.get('code_challenge'))
  assert.strictEqual(done.cookies[0].maxAge, -1)
})

test('a callback link opened in another browser does not sign that browser in', function () {
  store = {}
  config = { issuer: 'https://idp.test', client_id: 'matinee', client_secret: 'secret' }
  var started = null
  fakeProvider(function () { return started.nonce })
  started = startSignIn()
  assert.throws(function () {
    plugin.finish({ baseUrl: 'https://host/api', webUrl: 'https://host', query: { code: 'c', state: started.state }, cookies: {} })
  }, /another browser/)
})

test('an id token minted for another sign-in is refused', function () {
  store = {}
  config = { issuer: 'https://idp.test', client_id: 'matinee', client_secret: 'secret' }
  fakeProvider(function () { return 'replayed-nonce' })
  var started = startSignIn()
  assert.throws(function () {
    plugin.finish({ baseUrl: 'https://host/api', webUrl: 'https://host', query: { code: 'c', state: started.state }, cookies: { state: started.state } })
  }, /another sign-in/)
})

test('the web origin falls back to the API origin without its /api suffix', function () {
  assert.strictEqual(plugin.webBase({ baseUrl: 'https://host/api', webUrl: 'https://watch.example.test/' }), 'https://watch.example.test')
  assert.strictEqual(plugin.webBase({ baseUrl: 'https://host/api', webUrl: '' }), 'https://host')
})
