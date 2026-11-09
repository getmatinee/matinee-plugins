# Plex Watch-State Migration

Migrates watched flags and resume positions from a Plex server into Matinee, per user. You can run it again at any time. By default it only adds progress: it marks items watched and moves resume positions forward, and it never unwatches an item or moves a position back.

## What it covers

| Plex user | What migrates |
|---|---|
| The server owner | Watched flags and resume positions |
| **Plex Home** users without a PIN | Watched flags and resume positions |
| **External shared users**, separate Plex accounts you shared libraries with | Watched flags only, read from the server's playback history. Plex gives the owner no access to their resume positions, and only history the server still keeps can migrate |
| PIN-protected Home users | Nothing. The user matcher shows them but cannot assign them |

Movies and episodes are matched by their TMDB, IMDb or TVDB ids, so both servers must have their libraries matched to metadata.

## Setup

1. Install the plugin from the catalog under **Server settings -> Plugins**. The install also enables it.
2. Click **Configure** on the plugin.
3. Enter the **Plex server URL**, for example `http://plex.local:32400`, without a trailing slash. LAN addresses work. For an HTTPS server with a self-signed certificate, also turn on **Accept self-signed certificates**. Otherwise the certificate is verified, and plex.tv always is. Each field saves when you leave it.
4. Click **Connect Plex account**. The plugin shows a code to enter at [plex.tv/link](https://plex.tv/link), and the **Connection** row updates once the link completes. As an alternative, paste an owner `X-Plex-Token` into **Plex token (manual fallback)**, which the dialog hides once an account is linked.
5. Check that the **Connection** row confirms the server and lists the users that will be migrated.
6. Match users under **User matching**. The owner, Plex Home users and external shared users are listed, with shared users marked as watched flags only. Names that equal a Matinee username, ignoring case, are matched automatically. Drag a Matinee user from the pool onto any Plex user, or pick it from the row's list, to migrate that pair. Unassigned and PIN-protected users are skipped. Each assignment saves as you make it.
7. Click **Run migration**. The run starts within a minute and works through the library in batches once a minute, with progress in the **Migration status** row and in the Activities menu. The **Migration status** row shows the final summary.

## Mirroring the source

**Mirror the source exactly (may unwatch items in Matinee)** copies the Plex state as it is, which can move resume positions back in Matinee where Plex has less progress, and unwatches every matched item that Plex does not mark watched. Leave it off unless that is what you want.

## Permissions

The plugin requests the `network` scope to reach plex.tv and the Plex server, the `storage` scope for the account link, the progress of a running migration and the last summary, and the `watch-states` scope to read Matinee users and write their watch state.
