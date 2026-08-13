// Copyright (C) 2023-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Node tests for the pure matching half of spotify-sync, normalize() and chooseTrack().
// Run them from the repository root with node --test "plugins/**/*.test.js"

'use strict'

var test = require('node:test')
var assert = require('node:assert')

// main.js registers its hooks at load time, so the host object has to exist
// before the require. Only the surface touched at top level is stubbed
global.matinee = {
  manifest: { version: 'test' },
  log: function () {},
  debug: function () {},
  getConfig: function () { return {} },
  schedule: function () {},
  storage: {
    get: function () { return null },
    set: function () {},
    delete: function () {}
  },
  http: {
    fetch: function () { throw new Error('no network in tests') },
    onRequest: function () {},
    onCallback: function () {}
  }
}

var plugin = require('./main.js')
var normalize = plugin.normalize
var chooseTrack = plugin.chooseTrack

function spotifyTrack(title, artistNames, album) {
  var artists = []
  for (var i = 0; i < artistNames.length; i++) {
    artists.push({ name: artistNames[i] })
  }
  return { name: title, artists: artists, album: { name: album } }
}

var painTrack = spotifyTrack('Shut Your Mouth', ['PAIN'], 'Dancing with the Dead')

var bodyroxCandidate = {
  media_file_id: 'file-bodyrox',
  title: 'Shut Your Mouth',
  artist: 'Bodyrox & Luciana',
  album: 'Club Rotation Vol.45'
}

test('normalize strips apostrophes the way the server does', function () {
  assert.strictEqual(normalize("Don't Stop Me Now"), 'don t stop me now')
  assert.strictEqual(normalize('Mea Culpa (Radio Edit)'), 'mea culpa')
})

test('an exact title with wrong artist and wrong album is vetoed', function () {
  assert.strictEqual(chooseTrack(painTrack, [bodyroxCandidate]), null)
})

test('artist disagreement vetoes even an exact title and exact album', function () {
  var candidate = {
    media_file_id: 'file-x',
    title: 'Shut Your Mouth',
    artist: 'Bodyrox & Luciana',
    album: 'Dancing with the Dead'
  }
  assert.strictEqual(chooseTrack(painTrack, [candidate]), null)
})

test('the true track wins once it exists next to the impostor', function () {
  var painCandidate = {
    media_file_id: 'file-pain',
    title: 'Shut Your Mouth',
    artist: 'Pain',
    album: 'Dancing with the Dead'
  }
  var picked = chooseTrack(painTrack, [bodyroxCandidate, painCandidate])
  assert.strictEqual(picked && picked.media_file_id, 'file-pain')
})

test('an artist-agreeing partial title still matches', function () {
  var candidate = {
    media_file_id: 'file-partial',
    title: 'Shut Your Mouth Up',
    artist: 'Pain',
    album: 'Some Compilation'
  }
  var picked = chooseTrack(painTrack, [candidate])
  assert.strictEqual(picked && picked.media_file_id, 'file-partial')
})

test('a candidate without an artist ghosts even when the album agrees', function () {
  var agreeing = {
    media_file_id: 'file-agree',
    title: 'Shut Your Mouth',
    artist: '',
    album: 'Dancing with the Dead'
  }
  assert.strictEqual(chooseTrack(painTrack, [agreeing]), null)
})

test('a track without Spotify artists ghosts even when the album agrees', function () {
  var noSpotifyArtists = spotifyTrack('Shut Your Mouth', [], 'Dancing with the Dead')
  var agreeing = {
    media_file_id: 'file-agree',
    title: 'Shut Your Mouth',
    artist: 'Pain',
    album: 'Dancing with the Dead'
  }
  assert.strictEqual(chooseTrack(noSpotifyArtists, [agreeing]), null)
})

test('album agreement alone never confirms a match', function () {
  var disagreeing = {
    media_file_id: 'file-disagree',
    title: 'Shut Your Mouth',
    artist: '',
    album: 'Club Rotation Vol.45'
  }
  assert.strictEqual(chooseTrack(painTrack, [disagreeing]), null)

  var noSpotifyArtists = spotifyTrack('Shut Your Mouth', [], 'Dancing with the Dead')
  assert.strictEqual(chooseTrack(noSpotifyArtists, [bodyroxCandidate]), null)
})

test('exact titles outrank containment, album agreement breaks ties', function () {
  var containment = {
    media_file_id: 'file-a-containment',
    title: 'Shut Your Mouth Up',
    artist: 'Pain',
    album: 'Dancing with the Dead'
  }
  var exactWrongAlbum = {
    media_file_id: 'file-b-exact',
    title: 'Shut Your Mouth',
    artist: 'Pain',
    album: 'Rebirth'
  }
  var exactRightAlbum = {
    media_file_id: 'file-c-exact',
    title: 'Shut Your Mouth',
    artist: 'Pain',
    album: 'Dancing with the Dead'
  }
  var picked = chooseTrack(painTrack, [containment, exactWrongAlbum])
  assert.strictEqual(picked && picked.media_file_id, 'file-b-exact')
  picked = chooseTrack(painTrack, [exactWrongAlbum, exactRightAlbum])
  assert.strictEqual(picked && picked.media_file_id, 'file-c-exact')
})

test('full ties fall to the lowest media file id', function () {
  var twin = function (id) {
    return {
      media_file_id: id,
      title: 'Shut Your Mouth',
      artist: 'Pain',
      album: 'Dancing with the Dead'
    }
  }
  var picked = chooseTrack(painTrack, [twin('file-9'), twin('file-1')])
  assert.strictEqual(picked && picked.media_file_id, 'file-1')
  picked = chooseTrack(painTrack, [twin('file-1'), twin('file-9')])
  assert.strictEqual(picked && picked.media_file_id, 'file-1')
})
