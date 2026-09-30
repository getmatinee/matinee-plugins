// Copyright (C) 2024-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Node tests for ldap-sso against a scripted directory, covering the three
// verdicts of authenticate, the admin group verdict and the filter escaping.
// Run them from the repository root with node --test "plugins/**/*.test.js"

'use strict'

var test = require('node:test')
var assert = require('node:assert')

var config = {}
var directory = { binds: [], searches: [], entries: [], refuse: [] }

function fakeConnection() {
  return {
    search: function (req) {
      directory.searches.push(req)
      return directory.entries
    },
    close: function () {}
  }
}

global.matinee = {
  manifest: { name: 'LDAP Single Sign-on', version: 'test' },
  log: function () {},
  debug: function () {},
  getConfig: function () { return config },
  auth: { registerProvider: function () {} },
  http: { onRequest: function () {} },
  ldap: {
    connect: function (opts) {
      directory.binds.push(opts)
      if (directory.refuse.indexOf(opts.bindDn) !== -1) return null
      return fakeConnection()
    },
    escapeFilter: function (s) { return s.replace(/[*()\\]/g, function (c) { return '\\' + c.charCodeAt(0).toString(16) }) },
    escapeDN: function (s) { return s.replace(/[,+"\\<>;=]/g, function (c) { return '\\' + c }) }
  }
}

var plugin = require('./main.js')

function reset(cfg, entries, refuse) {
  config = cfg
  directory = { binds: [], searches: [], entries: entries || [], refuse: refuse || [] }
}

var annaEntry = {
  dn: 'CN=Anna,OU=People,DC=example,DC=com',
  attributes: {
    objectGUID: ['guid-anna'],
    sAMAccountName: ['anna'],
    mail: ['anna@example.com'],
    givenName: ['Anna'],
    sn: ['Reber'],
    memberOf: ['CN=Staff,OU=Groups,DC=example,DC=com', 'cn=matinee admins, ou=groups, dc=example, dc=com']
  }
}

var serviceConfig = {
  url: 'ldaps://dc.example.com',
  bind_dn: 'CN=svc,DC=example,DC=com',
  bind_password: 'svc-pw',
  user_base_dn: 'DC=example,DC=com',
  user_filter: '(&(objectClass=user)(sAMAccountName={username}))',
  admin_group_dn: 'CN=Matinee Admins,OU=Groups,DC=example,DC=com'
}

test('a service-account lookup binds as the found user and maps the entry', function () {
  reset(serviceConfig, [annaEntry])
  var identity = plugin.authenticate('anna', 'secret')
  assert.deepStrictEqual(identity, {
    id: 'guid-anna',
    username: 'anna',
    email: 'anna@example.com',
    first_name: 'Anna',
    last_name: 'Reber',
    admin: true
  })
  assert.strictEqual(directory.binds.length, 2)
  assert.strictEqual(directory.binds[0].bindDn, 'CN=svc,DC=example,DC=com')
  assert.strictEqual(directory.binds[1].bindDn, annaEntry.dn)
  assert.strictEqual(directory.binds[1].password, 'secret')
})

test('an unknown name answers null and a refused password answers false', function () {
  reset(serviceConfig, [])
  assert.strictEqual(plugin.authenticate('nobody', 'secret'), null)
  reset(serviceConfig, [annaEntry], [annaEntry.dn])
  assert.strictEqual(plugin.authenticate('anna', 'wrong'), false)
})

test('a refused service account throws instead of reporting a wrong password', function () {
  reset(serviceConfig, [annaEntry], ['CN=svc,DC=example,DC=com'])
  assert.throws(function () { plugin.authenticate('anna', 'secret') }, /service account/)
})

test('the login name is escaped before it enters the filter', function () {
  reset(serviceConfig, [])
  plugin.authenticate('an*na)(x', 'secret')
  assert.strictEqual(directory.searches[0].filter, '(&(objectClass=user)(sAMAccountName=an\\2ana\\29\\28x))')
})

test('without an admin group the admin flag is left to Matinee', function () {
  var cfg = {}
  for (var key in serviceConfig) cfg[key] = serviceConfig[key]
  cfg.admin_group_dn = ''
  reset(cfg, [annaEntry])
  var identity = plugin.authenticate('anna', 'secret')
  assert.strictEqual(identity.admin, undefined)
})

test('a direct bind through the user DN template reads the profile as the user', function () {
  reset({
    url: 'ldaps://ipa.example.com',
    user_base_dn: 'cn=users,cn=accounts,dc=example,dc=com',
    user_filter: '(uid={username})',
    user_dn_template: 'uid={username},cn=users,cn=accounts,dc=example,dc=com',
    id_attr: 'ipaUniqueID',
    username_attr: 'uid'
  }, [{ dn: 'uid=anna,cn=users,cn=accounts,dc=example,dc=com', attributes: { ipaUniqueID: ['ipa-1'], uid: ['anna'] } }])
  var identity = plugin.authenticate('anna', 'secret')
  assert.strictEqual(directory.binds.length, 1)
  assert.strictEqual(directory.binds[0].bindDn, 'uid=anna,cn=users,cn=accounts,dc=example,dc=com')
  assert.strictEqual(identity.id, 'ipa-1')
  assert.strictEqual(identity.username, 'anna')
})

test('the DN is the fallback id and DN comparison ignores case and spacing', function () {
  var identity = plugin.identityFromEntry({ dn: 'CN=x', attributes: { sAMAccountName: ['x'] } }, plugin.settings({}), 'x')
  assert.strictEqual(identity.id, 'CN=x')
  assert.ok(plugin.sameDN('cn=A, ou=B', 'CN=a,OU=b'))
  assert.ok(!plugin.sameDN('cn=A,ou=B', 'cn=A,ou=C'))
})
