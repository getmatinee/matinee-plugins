# Shared helper snippets

Source installs fetch exactly three files, so plugins in this repository stay
single-file and copy these helpers verbatim instead of importing a shared
module. Fix a bug here first, then in every plugin that carries the copy
(`grep -l 'function loadJSON' plugins/*/main.js`).

## Debug logging

```js
function dbg(msg) {
  if (typeof matinee.debug === 'function') matinee.debug(msg)
}
```

## Storage as JSON

```js
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
```

## Query strings

```js
function qs(obj) {
  var parts = []
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(obj[key])))
    }
  }
  return parts.join('&')
}
```

## Random tokens (state nonces)

```js
function randToken(n) {
  var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  var out = ''
  for (var i = 0; i < n; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return out
}
```

`Math.random()` is not cryptographically strong; for OAuth state nonces on an
already-authenticated admin flow it is acceptable, but do not use it for
secrets.
