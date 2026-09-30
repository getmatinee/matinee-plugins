// Copyright (C) 2024-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// LDAP Single Sign-on
// A password sign-in provider that checks the login form's credentials against an LDAP directory,
// looking the user up through a service account or binding straight through the user DN template

'use strict'

var PRESETS = {
  ad: {
    display_name: 'Active Directory',
    url: 'ldaps://dc1.example.com:636',
    insecure: false,
    start_tls: false,
    bind_dn: 'CN=matinee,OU=Service Accounts,DC=example,DC=com',
    user_base_dn: 'DC=example,DC=com',
    user_filter: '(&(objectClass=user)(objectCategory=person)(sAMAccountName={username}))',
    user_dn_template: '{username}@example.com',
    id_attr: 'objectGUID',
    username_attr: 'sAMAccountName',
    email_attr: 'mail',
    first_name_attr: 'givenName',
    last_name_attr: 'sn',
    admin_group_dn: 'CN=Matinee Admins,OU=Groups,DC=example,DC=com',
    group_attr: 'memberOf'
  },
  freeipa: {
    display_name: 'FreeIPA',
    url: 'ldaps://ipa.example.com:636',
    insecure: false,
    start_tls: false,
    bind_dn: 'uid=matinee,cn=sysaccounts,cn=etc,dc=example,dc=com',
    user_base_dn: 'cn=users,cn=accounts,dc=example,dc=com',
    user_filter: '(&(objectClass=posixAccount)(uid={username}))',
    user_dn_template: 'uid={username},cn=users,cn=accounts,dc=example,dc=com',
    id_attr: 'ipaUniqueID',
    username_attr: 'uid',
    email_attr: 'mail',
    first_name_attr: 'givenName',
    last_name_attr: 'sn',
    admin_group_dn: 'cn=matinee-admins,cn=groups,cn=accounts,dc=example,dc=com',
    group_attr: 'memberOf'
  }
}

var DEFAULTS = {
  id_attr: 'objectGUID',
  username_attr: 'sAMAccountName',
  email_attr: 'mail',
  first_name_attr: 'givenName',
  last_name_attr: 'sn',
  group_attr: 'memberOf'
}

function dbg(msg) {
  if (typeof matinee.debug === 'function') matinee.debug(msg)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// The admin's values with the defaults filled in for the attribute names left empty
function settings(raw) {
  var out = {}
  for (var key in raw) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key]
  }
  for (var name in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, name) && !text(out[name])) out[name] = DEFAULTS[name]
  }
  return out
}

function fill(template, username) {
  return template.split('{username}').join(username)
}

function attr(entry, name) {
  if (!entry || !entry.attributes) return ''
  var values = null
  for (var key in entry.attributes) {
    if (Object.prototype.hasOwnProperty.call(entry.attributes, key) && key.toLowerCase() === name.toLowerCase()) {
      values = entry.attributes[key]
      break
    }
  }
  return values && values.length ? String(values[0]) : ''
}

function attrs(entry, name) {
  if (!entry || !entry.attributes) return []
  for (var key in entry.attributes) {
    if (Object.prototype.hasOwnProperty.call(entry.attributes, key) && key.toLowerCase() === name.toLowerCase()) {
      return entry.attributes[key] || []
    }
  }
  return []
}

function sameDN(a, b) {
  return text(a).replace(/\s*,\s*/g, ',').toLowerCase() === text(b).replace(/\s*,\s*/g, ',').toLowerCase()
}

// Maps a directory entry onto the identity Matinee links the account to. The
// admin verdict is only given when an administrator group is configured
function identityFromEntry(entry, cfg, fallbackUsername) {
  var username = attr(entry, cfg.username_attr) || fallbackUsername
  var identity = {
    id: attr(entry, cfg.id_attr) || entry.dn,
    username: username,
    email: attr(entry, cfg.email_attr),
    first_name: attr(entry, cfg.first_name_attr),
    last_name: attr(entry, cfg.last_name_attr)
  }
  var adminGroup = text(cfg.admin_group_dn)
  if (adminGroup) {
    var groups = attrs(entry, cfg.group_attr)
    var isAdmin = false
    for (var i = 0; i < groups.length; i++) {
      if (sameDN(groups[i], adminGroup)) isAdmin = true
    }
    identity.admin = isAdmin
  }
  return identity
}

function searchAttributes(cfg) {
  return [cfg.id_attr, cfg.username_attr, cfg.email_attr, cfg.first_name_attr, cfg.last_name_attr, cfg.group_attr]
}

function connectOptions(cfg, dn, password) {
  return {
    url: text(cfg.url),
    bindDn: dn,
    password: password,
    insecure: Boolean(cfg.insecure),
    startTls: Boolean(cfg.start_tls)
  }
}

function findUser(conn, cfg, username) {
  var entries = conn.search({
    baseDn: text(cfg.user_base_dn),
    filter: fill(text(cfg.user_filter), matinee.ldap.escapeFilter(username)),
    attributes: searchAttributes(cfg),
    sizeLimit: 2
  })
  if (entries.length > 1) {
    matinee.log('user filter matched ' + entries.length + ' entries for ' + username + ', refusing the ambiguous sign-in')
    return null
  }
  return entries.length === 1 ? entries[0] : null
}

// The provider contract. An identity signs the user in, null means an unknown name, false a
// refused password, and a thrown error a directory that could not be asked
function authenticate(username, password) {
  var cfg = settings(matinee.getConfig())
  username = text(username)
  if (!username || !password) return false
  if (!text(cfg.url) || !text(cfg.user_base_dn) || !text(cfg.user_filter)) {
    throw new Error('ldap-sso is not configured yet')
  }

  if (text(cfg.bind_dn)) {
    var service = matinee.ldap.connect(connectOptions(cfg, text(cfg.bind_dn), String(cfg.bind_password || '')))
    if (!service) throw new Error('the service account bind was refused, check the service account DN and password')
    var entry
    try {
      entry = findUser(service, cfg, username)
    } finally {
      service.close()
    }
    if (!entry) {
      dbg('no directory entry for ' + username)
      return null
    }
    var userConn = matinee.ldap.connect(connectOptions(cfg, entry.dn, password))
    if (!userConn) {
      dbg('password refused for ' + entry.dn)
      return false
    }
    userConn.close()
    return identityFromEntry(entry, cfg, username)
  }

  var template = text(cfg.user_dn_template)
  if (!template) throw new Error('set a service account or a user DN template')
  var own = matinee.ldap.connect(connectOptions(cfg, fill(template, matinee.ldap.escapeDN(username)), password))
  if (!own) {
    // A direct bind cannot tell an unknown name from a wrong password, so a wrong
    // password it is, and a local account of that name stays reachable through the switch
    dbg('bind refused for ' + username)
    return false
  }
  try {
    var found = findUser(own, cfg, username)
    if (!found) {
      matinee.log('bound as ' + username + ' but the user filter found no entry, check the user filter and base DN')
      return false
    }
    return identityFromEntry(found, cfg, username)
  } finally {
    own.close()
  }
}

function jsonResponse(body) {
  return { status: 200, body: JSON.stringify(body), contentType: 'application/json' }
}

function preset(key) {
  return function () {
    var values = {}
    for (var name in PRESETS[key]) {
      if (Object.prototype.hasOwnProperty.call(PRESETS[key], name)) values[name] = PRESETS[key][name]
    }
    return jsonResponse({ config: values, message: 'Example values filled in. Replace host, base DN and service account, then save.' })
  }
}

function testConnection() {
  var cfg = settings(matinee.getConfig())
  if (!text(cfg.url)) return jsonResponse({ message: 'Enter the directory URL first' })
  if (!text(cfg.bind_dn)) {
    return jsonResponse({ message: 'No service account configured. Sign in with a directory user to test the user DN template' })
  }
  var conn = matinee.ldap.connect(connectOptions(cfg, text(cfg.bind_dn), String(cfg.bind_password || '')))
  if (!conn) return jsonResponse({ message: 'The directory refused the service account credentials' })
  try {
    var entries = conn.search({
      baseDn: text(cfg.user_base_dn),
      filter: fill(text(cfg.user_filter), '*'),
      attributes: [cfg.username_attr],
      sizeLimit: 500
    })
    var more = entries.length >= 500 ? ' or more' : ''
    return jsonResponse({ message: 'Connected. The user filter matches ' + entries.length + more + ' users' })
  } finally {
    conn.close()
  }
}

var initial = settings(matinee.getConfig())
matinee.auth.registerProvider({
  name: text(initial.display_name) || matinee.manifest.name,
  authenticate: authenticate
})
matinee.http.onRequest('preset-ad', preset('ad'))
matinee.http.onRequest('preset-freeipa', preset('freeipa'))
matinee.http.onRequest('test', testConnection)
matinee.log('ldap-sso v' + matinee.manifest.version + ' loaded' + (text(initial.url) ? ' for ' + text(initial.url) : ', not configured yet'))

// Node sees this during the repo's tests. Inside goja there is no module
// object, so the guard keeps the plugin loading unchanged there
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { authenticate: authenticate, identityFromEntry: identityFromEntry, settings: settings, fill: fill, sameDN: sameDN }
}
