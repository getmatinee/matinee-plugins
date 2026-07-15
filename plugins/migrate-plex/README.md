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
4. Match users under **User matching**: the owner and Plex Home users whose
   name equals a Matinee username are matched automatically; drag a Matinee
   user from the pool onto any other Plex user (or pick it from the row's
   dropdown) to migrate that pair. Unassigned and PIN-protected users are
   skipped. Save after changing.
5. Click **Run migration**. The Last run row reports progress and the final
   summary; large libraries migrate incrementally over a few scheduler ticks.

## Full sync

*Full sync* mirrors the source exactly, which may unwatch items in Matinee
that are unwatched in Plex. Leave it off unless that is what you want.
