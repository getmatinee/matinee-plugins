# Emby Watch State Migration

Migrates watched flags and resume positions from an Emby server into Matinee, per user. Re-runnable: by default it only adds progress and never unwatches.

Movies and episodes are matched by their TMDB/IMDb/TVDB ids, so both servers must have their libraries matched to metadata.

## Setup

1. Install and enable the plugin, open **Configure**.
2. Set the **Emby server URL**, e.g. `http://emby.local:8096` (no trailing
slash). LAN addresses are fine.
3. Create an API key under Emby Dashboard > Advanced > API Keys and paste it
into **Emby API key**. The Connection row confirms the link.
4. Match users under **User matching**: Emby users whose name equals a
Matinee username are matched automatically; drag a Matinee user from the pool onto any other Emby user (or pick it from the row's dropdown) to migrate that pair. Unassigned Emby users are skipped. Save after changing.
5. Click **Run migration**. The Last run row reports progress and the final
summary; large libraries migrate incrementally over a few scheduler ticks.

## Full sync

*Full sync* mirrors the source exactly, which may unwatch items in Matinee
that are unwatched in Emby. Leave it off unless that is what you want.
