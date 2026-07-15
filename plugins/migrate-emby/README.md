# Emby Watch State Migration

Migrates watched flags and resume positions from an Emby server into Matinee,
per user. Re-runnable: by default it only adds progress and never unwatches.

Movies and episodes are matched by their TMDB/IMDb/TVDB ids, so both servers
must have their libraries matched to metadata.

## Setup

1. Install and enable the plugin, open **Configure**.
2. Set the **Emby server URL**, e.g. `http://emby.local:8096` (no trailing
   slash). LAN addresses are fine.
3. Create an API key under Emby Dashboard > Advanced > API Keys and paste it
   into **Emby API key**. The Connection row confirms the link.
4. Optionally restrict **Users to migrate** (leave empty to migrate every
   Emby user whose name matches a Matinee account) and add **User mapping
   overrides** for accounts whose names differ (`john=johnny,
   kids=children`). Save after changing the selection.
5. Click **Run migration**. The Last run row reports progress and the final
   summary; large libraries migrate incrementally over a few scheduler ticks.

## Full sync

*Full sync* mirrors the source exactly, which may unwatch items in Matinee
that are unwatched in Emby. Leave it off unless that is what you want.
