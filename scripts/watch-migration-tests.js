// Copyright (C) 2024-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Watch imports retain successful writes while processing duplicate source matches

'use strict'

var test = require('node:test')
var assert = require('node:assert/strict')
var fs = require('node:fs')
var vm = require('node:vm')

module.exports = function (filename, sourceItem) {
  function fixture() {
    var writes = []
    var fail = false
    var context = vm.createContext({ matinee: {
      manifest: { version: 'test' },
      http: { onRequest: function () {} },
      schedule: function () {},
      log: function () {},
      watch: { setState: function (userId, fileId, opts) {
        if (fail) throw new Error('storage unavailable')
        writes.push({ userId: userId, fileId: fileId, opts: JSON.parse(JSON.stringify(opts)) })
      } }
    } })
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename: filename })
    var user = { matineeId: 'user', stats: { updated: 0, skipped: 0 } }
    var states = {}
    return {
      writes: writes,
      states: states,
      stats: user.stats,
      fail: function (value) { fail = value },
      apply: function (watched, position, fullSync, files) {
        context.applyItem(user, sourceItem(watched, position), files || ['file'], states, {}, {}, !!fullSync)
      }
    }
  }

  test('duplicate source matches cannot move an additive resume position backwards', function () {
    var f = fixture()
    f.apply(false, 900)
    f.apply(false, 600)
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].opts.positionSeconds, 900)
    assert.equal(f.states.file.position_seconds, 900)
    assert.deepEqual(f.stats, { updated: 1, skipped: 1 })
  })

  test('a watched match prevents later resume writes to the same local file', function () {
    var f = fixture()
    f.apply(true, 0)
    f.apply(false, 600)
    f.apply(true, 0)
    assert.equal(f.writes.length, 1)
    assert.equal(f.states.file.watched, true)
  })

  test('duplicate local mappings produce one successful write', function () {
    var f = fixture()
    f.apply(false, 900, false, ['file', 'file'])
    assert.equal(f.writes.length, 1)
  })

  test('failed storage writes leave the cached state available for retry', function () {
    var f = fixture()
    f.states.file = { media_file_id: 'file', watched: false, position_seconds: 300 }
    f.fail(true)
    assert.throws(function () { f.apply(false, 900) }, /storage unavailable/)
    assert.equal(f.states.file.position_seconds, 300)
    assert.equal(f.stats.updated, 0)
    f.fail(false)
    f.apply(false, 900)
    assert.equal(f.states.file.position_seconds, 900)
    assert.equal(f.writes.length, 1)
  })

  test('full sync mirrors lower source positions and skips repeated values', function () {
    var f = fixture()
    f.apply(true, 900, true)
    f.apply(false, 600, true)
    f.apply(false, 600, true)
    assert.equal(f.writes.length, 2)
    assert.equal(f.states.file.watched, false)
    assert.equal(f.states.file.position_seconds, 600)
    assert.deepEqual(f.stats, { updated: 2, skipped: 1 })
  })
}
