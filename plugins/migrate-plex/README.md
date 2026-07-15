# Plex Watch State Migration

Migrates watched flags and resume positions from a Plex server into Matinee,
per user. Re-runnable: by default it only adds progress and never unwatches.

## What it covers

- The server owner and **Plex Home** users, including Home users without a
  PIN. External shared accounts (full Plex accounts you shared libraries
  with) cannot be read through the owner token and are not migrated.
- Movies and episodes are matched by their TMDB/IMDb/TVDB ids, so both
  servers must have their libraries matched to metadata.

## Setup

1. Install and enable the plugin, open **Configure**.
2. Set the **Plex server URL**, e.g. `http://plex.local:32400` (no trailing
   slash). LAN addresses are fine.
3. Click **Connect Plex account**: the plugin shows a code to enter at
   [plex.tv/link](https://plex.tv/link). The Connection row updates once the
   link completes. Alternatively paste an owner `X-Plex-Token` into the
   manual fallback field.
4. Optionally restrict **Users to migrate** (leave empty to migrate the owner
   and every Plex Home user whose name matches a Matinee account) and add
   **User mapping overrides** for accounts whose names differ
   (`john=johnny, kids=children`). Save after changing the selection.
5. Click **Run migration**. The Last run row reports progress and the final
   summary; large libraries migrate incrementally over a few scheduler ticks.

## Full sync

*Full sync* mirrors the source exactly, which may unwatch items in Matinee
that are unwatched in Plex. Leave it off unless that is what you want.
