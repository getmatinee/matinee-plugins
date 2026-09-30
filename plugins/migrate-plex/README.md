# Plex Watch State Migration

Migrates watched flags and resume positions from a Plex server into Matinee, per user. Re-runnable: by default it only adds progress and never unwatches.

## What it covers

- The server owner and **Plex Home** users (including Home users without a
PIN) migrate with full fidelity: watched flags and resume positions.
- **External shared users** (separate Plex accounts you shared libraries with)
migrate **watched flags only**, read from the server's playback history. Plex gives the owner no access to their resume positions, and only history the server still retains can be migrated. PIN-protected Home users cannot be migrated at all.
- Movies and episodes are matched by their TMDB/IMDb/TVDB ids, so both
servers must have their libraries matched to metadata.

## Setup

1. Install and enable the plugin, open **Configure**.
2. Set the **Plex server URL**, e.g. `http://plex.local:32400` (no trailing slash). LAN addresses are fine. For an HTTPS server with a self-signed certificate, also turn on **Accept self-signed certificates**. Otherwise the certificate is verified, and plex.tv always is.
3. Click **Connect Plex account**: the plugin shows a code to enter at
   [plex.tv/link](https://plex.tv/link). The Connection row updates once the
link completes. Alternatively paste an owner `X-Plex-Token` into the manual fallback field.
4. Match users under **User matching**: the owner, Plex Home users and
external shared users are listed (shared users are marked "watched flags only"); names that equal a Matinee username are matched automatically. Drag a Matinee user from the pool onto any Plex user (or pick it from the row's dropdown) to migrate that pair. Unassigned and PIN-protected users are skipped. Save after changing.
5. Click **Run migration**. The Last run row reports progress and the final
summary; large libraries migrate incrementally over a few scheduler ticks.

## Full sync

*Full sync* mirrors the source exactly, which may unwatch items in Matinee
that are unwatched in Plex. Leave it off unless that is what you want.
