// Copyright (C) 2024-2026 Swissmakers GmbH
// Author: Michael André Reber
// License: AGPL-3.0-or-later
// https://github.com/getmatinee/matinee

// Emby watch-state imports preserve progress across repeated provider matches

'use strict'

require('../../scripts/watch-migration-tests.js')(require.resolve('./main.js'), function (watched, position) {
  return { UserData: { Played: watched, PlaybackPositionTicks: position * 10000000 } }
})
