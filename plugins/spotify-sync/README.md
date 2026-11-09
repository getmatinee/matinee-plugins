# Spotify Playlist Sync

Mirrors Spotify playlists into Matinee playlists. Tracks found in your music libraries play normally. Tracks you don't have appear greyed-out as "Not available" with artist and album info, and Matinee matches them again after every music scan, so a track you add later takes its place in the playlist on its own. A track is only taken as found when its ISRC, or its title, version, artist and duration, agree with a local file.

## Spotify developer app

You need a Spotify developer app, which Spotify provides free of charge:

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create an app that uses the **Web API**.
2. Add the **Redirect URI** exactly as the plugin shows it in its **Connection** row, which has the form `https://<your-server>/api/plugins/spotify-sync/callback`. The plugin builds it from the public API URL under **Server settings -> General -> Public addresses**, or from the request when none is set.
3. New Spotify apps run in **Development Mode**. Add the Spotify accounts that will connect under *User Management*, or request extended quota.

## Setup in Matinee

1. Install the plugin from the catalog under **Server settings -> Plugins**. The install also enables it.
2. Click **Configure** on the plugin.
3. Paste the app's client ID into **Spotify client ID**. Leave **Spotify client secret** empty to connect with PKCE, which is the recommended way.
4. Enter the Matinee account that should own the synced playlists in **Playlist owner (Matinee username)**. Each field saves when you leave it.
5. Click **Connect Spotify account**.
6. Approve access on the Spotify page. Spotify sends the browser back to the plugin settings.
7. Reopen **Configure** and tick the playlists you want under **Playlists to sync**. The selection saves as you tick.
8. Click **Sync now**. The sync starts within a minute, and the **Sync status** row below the button and the Activities menu show its progress.

Synced playlists appear on the **Playlists** page of the playlist owner, and tracks are matched only against the libraries that account can see. Playlists you tick while a sync runs join it when you click **Sync now** again. Tick **Re-sync automatically every 48 hours** to keep playlists up to date. The plugin waits out Spotify's rate limits on its own, so a large first sync can take a few extra minutes.

## What Spotify lets you sync

Spotify's Web API returns the tracks only of playlists your account owns or collaborates on. Playlists you merely follow, including the editorial and "Made For You" ones, are refused, so the picker does not list them. A playlist that becomes unreadable mid-run is skipped with a note in the plugin log and the remaining playlists still sync.

## Permissions

The plugin requests the `network` scope to reach the Spotify accounts service and Web API, the `storage` scope for the Spotify tokens, the connect in progress and the sync state, and the `playlists` scope to create playlists for the owner and match their tracks.
