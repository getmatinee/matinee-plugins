# Spotify Playlist Sync

Mirrors Spotify playlists into Matinee playlists. Tracks found in your music libraries play normally.
Tracks you don't have appear greyed-out ("Not available") with artist and album info.

## Spotify developer app

You need a (free) Spotify developer app:

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create an app (API used: **Web API**).
2. Add the **Redirect URI** exactly as the plugin shows it in its Connection row: `https://<your-server>/api/plugins/spotify-sync/callback`.
3. Note: new Spotify apps run in **Development Mode**. Add the Spotify
   account(s) that will connect under *User Management*, or request extended quota.

## Setup in Matinee

1. Install the plugin from the catalog and enable it.
2. Open **Configure**: paste the **Client ID** (the Client Secret is optional, leave it empty to use PKCE, recommended) and the **Matinee username** that should own the synced playlists. **Save.**
3. Reopen Configure and click **Connect Spotify account**; approve access on the Spotify page.
4. Tick the playlists you want under **Playlists to sync** and **Save**.
5. Click **Sync now**.

Synced playlists appear under `/playlists`. Tick *Re-sync automatically every 48 hours* to keep playlists up to date. Spotify rate limits are respected automatically, so a large first sync can simply take a few extra minutes.

## What Spotify lets you sync

Since the February 2026 Web API changes, Spotify only returns the tracks of playlists your account owns or collaborates on. Playlists you merely follow, including the editorial and "Made For You" ones, are refused, so the picker does not list them. A playlist that becomes unreadable mid-run is skipped with a note in the plugin log and the remaining playlists still sync.
