// Copyright (C) 2024-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// OpenID Connect redirect sign-in that trades the provider's code for tokens and hands the login page a ticket

'use strict'

var STATE_TTL_MS = 10 * 60 * 1000
var STATE_INDEX = 'states'
var STATE_MAX = 50
var DEFAULT_SCOPES = 'openid profile email'

var discoveryCache = null

function dbg(msg) {
  if (typeof matinee.debug === 'function') matinee.debug(msg)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function settings() {
  var raw = matinee.getConfig()
  return {
    display_name: text(raw.display_name) || matinee.manifest.name,
    issuer: text(raw.issuer).replace(/\/+$/, ''),
    client_id: text(raw.client_id),
    client_secret: String(raw.client_secret || ''),
    scopes: text(raw.scopes) || DEFAULT_SCOPES,
    username_claim: text(raw.username_claim) || 'preferred_username',
    email_claim: text(raw.email_claim) || 'email',
    groups_claim: text(raw.groups_claim) || 'groups',
    admin_group: text(raw.admin_group),
    insecure: Boolean(raw.insecure)
  }
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

function idTokenClaims(idToken) {
  var parts = String(idToken || '').split('.')
  if (parts.length !== 3) throw new Error('The ID token is not a JWT.')
  return JSON.parse(matinee.crypto.base64Decode(parts[1]))
}

function fetchJSON(url, opts) {
  var cfg = settings()
  var res = matinee.http.fetch(url, {
    method: opts.method || 'GET',
    headers: opts.headers || {},
    body: opts.body || '',
    insecure: cfg.insecure
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(url.split('?')[0] + ' answered ' + res.status + '.')
  }
  try {
    return JSON.parse(res.body)
  } catch (e) {
    throw new Error(url.split('?')[0] + ' did not answer with JSON.')
  }
}

// The provider's endpoints from its discovery document, read once per plugin load
function discovery() {
  if (discoveryCache) return discoveryCache
  var cfg = settings()
  if (!cfg.issuer) throw new Error('The issuer URL is not set.')
  var doc = fetchJSON(cfg.issuer + '/.well-known/openid-configuration', {})
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('The discovery document names no authorization or token endpoint.')
  }
  discoveryCache = doc
  return doc
}

function redirectUri(req) {
  return req.baseUrl.replace(/\/+$/, '') + '/plugins/' + matinee.manifest.id + '/callback'
}

// The web app origin, which a server without a configured public web URL derives from the API origin
function webBase(req) {
  var web = text(req.webUrl)
  if (web) return web.replace(/\/+$/, '')
  return req.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '')
}

function loadStates() {
  var raw = matinee.storage.get(STATE_INDEX)
  if (!raw) return []
  try {
    return JSON.parse(raw)
  } catch (e) {
    return []
  }
}

function saveStates(states) {
  matinee.storage.set(STATE_INDEX, JSON.stringify(states))
}

// Stale entries age out, so abandoned sign-ins cannot pile up storage
function rememberState(state, verifier, nonce, now) {
  var states = loadStates().filter(function (entry) { return now - entry.at < STATE_TTL_MS })
  states.push({ s: state, v: verifier, n: nonce, at: now })
  if (states.length > STATE_MAX) states = states.slice(states.length - STATE_MAX)
  saveStates(states)
}

// Returns null for a state the provider sends back twice or one older than the lifetime
function consumeState(state, now) {
  var states = loadStates()
  var found = null
  var kept = []
  for (var i = 0; i < states.length; i++) {
    if (states[i].s === state && now - states[i].at < STATE_TTL_MS) {
      found = { verifier: states[i].v, nonce: states[i].n }
    } else if (now - states[i].at < STATE_TTL_MS) {
      kept.push(states[i])
    }
  }
  saveStates(kept)
  return found
}

// The state also travels in a cookie, so a callback link started in another browser cannot finish a sign-in here
function stateCookie(state) {
  return { name: 'state', value: state, maxAge: state ? STATE_TTL_MS / 1000 : -1 }
}

// Leaves admin unset unless an administrator group is configured, so Matinee keeps its own verdict
function identityFromClaims(claims, cfg) {
  var username = text(claims[cfg.username_claim])
  if (!text(claims.sub)) throw new Error('The token carries no sub claim.')
  if (!username) throw new Error('The token carries no ' + cfg.username_claim + ' claim.')
  var identity = {
    id: text(claims.sub),
    username: username,
    email: text(claims[cfg.email_claim]),
    first_name: text(claims.given_name),
    last_name: text(claims.family_name)
  }
  if (cfg.admin_group) {
    var groups = claims[cfg.groups_claim]
    if (typeof groups === 'string') groups = [groups]
    identity.admin = Array.isArray(groups) && groups.indexOf(cfg.admin_group) !== -1
  }
  return identity
}

function start(req) {
  var cfg = settings()
  if (!cfg.client_id) throw new Error('The client ID is not set.')
  var doc = discovery()
  var state = matinee.crypto.randomToken(32)
  var verifier = matinee.crypto.randomToken(48)
  var nonce = matinee.crypto.randomToken(24)
  rememberState(state, verifier, nonce, Date.now())
  var url = doc.authorization_endpoint + (doc.authorization_endpoint.indexOf('?') === -1 ? '?' : '&') + qs({
    response_type: 'code',
    client_id: cfg.client_id,
    redirect_uri: redirectUri(req),
    scope: cfg.scopes,
    state: state,
    nonce: nonce,
    code_challenge: matinee.crypto.sha256(verifier, 'base64url'),
    code_challenge_method: 'S256'
  })
  dbg('sign-in started')
  return { redirect: url, cookies: [stateCookie(state)] }
}

function finish(req) {
  var cfg = settings()
  if (req.query.error) {
    throw new Error(text(req.query.error_description) || String(req.query.error))
  }
  if (!req.query.code || !req.query.state) throw new Error('The provider sent no code.')
  var state = String(req.query.state)
  if (!req.cookies || req.cookies.state !== state) throw new Error('The sign-in was started in another browser.')
  var started = consumeState(state, Date.now())
  if (!started) throw new Error('The sign-in is unknown or expired. Start it again.')

  var doc = discovery()
  var token = fetchJSON(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: qs({
      grant_type: 'authorization_code',
      code: String(req.query.code),
      redirect_uri: redirectUri(req),
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      code_verifier: started.verifier
    })
  })
  if (!token.id_token) throw new Error('The token response carries no ID token.')

  // The signature goes unchecked because the token came over TLS straight from the token endpoint for the client secret
  var claims = idTokenClaims(token.id_token)
  if (text(claims.iss).replace(/\/+$/, '') !== cfg.issuer) throw new Error('The ID token names another issuer.')
  var audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (audience.indexOf(cfg.client_id) === -1) throw new Error('The ID token is for another client.')
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new Error('The ID token has expired.')
  if (claims.nonce !== started.nonce) throw new Error('The ID token belongs to another sign-in.')

  if (doc.userinfo_endpoint && token.access_token) {
    try {
      var info = fetchJSON(doc.userinfo_endpoint, { headers: { Authorization: 'Bearer ' + token.access_token } })
      for (var key in info) {
        if (Object.prototype.hasOwnProperty.call(info, key) && key !== 'sub') claims[key] = info[key]
      }
    } catch (e) {
      dbg('userinfo skipped: ' + e.message)
    }
  }

  var identity = identityFromClaims(claims, cfg)
  var ticket = matinee.auth.issueTicket(identity)
  matinee.log('signed in ' + identity.username)
  return { redirect: webBase(req) + '/login?sso_ticket=' + encodeURIComponent(ticket), cookies: [stateCookie('')] }
}

matinee.http.onCallback(function (req) {
  try {
    return req.query.start ? start(req) : finish(req)
  } catch (e) {
    var message = e && e.message ? e.message : String(e)
    matinee.log('sign-in failed: ' + message)
    return { redirect: webBase(req) + '/login?sso_error=' + encodeURIComponent(message), cookies: [stateCookie('')] }
  }
})

matinee.http.onRequest('check', function (req) {
  var body
  try {
    discoveryCache = null
    var doc = discovery()
    body = { message: 'The issuer ' + doc.issuer + ' answered. Register the redirect URI ' + redirectUri(req) + ' at the provider.' }
  } catch (e) {
    body = { message: 'Could not read the issuer. ' + (e && e.message ? e.message : String(e)) }
  }
  return { status: 200, body: JSON.stringify(body), contentType: 'application/json' }
})

var initial = settings()
matinee.auth.registerProvider({ name: initial.display_name, redirect: true })
matinee.log('oidc-sso v' + matinee.manifest.version + ' loaded' + (initial.issuer ? ' for ' + initial.issuer : ', not configured yet'))

// Only Node sees this, during the repo's tests, because goja has no module object
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    idTokenClaims: idTokenClaims,
    start: start,
    finish: finish,
    identityFromClaims: identityFromClaims,
    rememberState: rememberState,
    consumeState: consumeState,
    webBase: webBase,
    settings: settings
  }
}
