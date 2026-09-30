// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Hello World
// A minimal Matinee example plugin for devs and reference

// Debug output follows the server setting. The binding is optional
function dbg(msg) {
  if (typeof matinee.debug === 'function') matinee.debug(msg)
}

var cfg = matinee.getConfig()
matinee.log('hello-world v' + matinee.manifest.version + ' loaded' + (cfg.greeting ? ': ' + cfg.greeting : ''))
dbg('config keys: ' + Object.keys(cfg).join(', '))

var added = 0

matinee.on('media.added', function () {
  added++
})

matinee.on('scan.completed', function (e) {
  matinee.log('scan completed for ' + e.library_name + ' (' + added + ' new items)')
  added = 0
})

// Schedule demo that runs once an hour and persists a counter across restarts via plugin storage
matinee.schedule(60, function () {
  var beats = Number(matinee.storage.get('heartbeats') || '0') + 1
  matinee.storage.set('heartbeats', String(beats))
  matinee.log('heartbeat #' + beats)
})
