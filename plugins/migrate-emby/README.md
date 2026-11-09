# Emby Watch-State Migration

Migrates watched flags and resume positions from an Emby server into Matinee, per user. You can run it again at any time. By default it only adds progress: it marks items watched and moves resume positions forward, and it never unwatches an item or moves a position back.

Movies and episodes are matched by their TMDB, IMDb or TVDB ids, so both servers must have their libraries matched to metadata.

## Setup

1. Install the plugin from the catalog under **Server settings -> Plugins**. The install also enables it.
2. Click **Configure** on the plugin.
3. Enter the **Emby server URL**, for example `http://emby.local:8096`, without a trailing slash. LAN addresses work. For an HTTPS server with a self-signed certificate, also turn on **Accept self-signed certificates**. Otherwise the certificate is verified. Each field saves when you leave it.
4. Create an API key under Emby Dashboard, Advanced, API Keys, and paste it into **Emby API key**.
5. Check that the **Connection** row confirms the link and lists the users that will be migrated.
6. Match users under **User matching**. Emby users whose name equals a Matinee username, ignoring case, are matched automatically. Drag a Matinee user from the pool onto any other Emby user, or pick it from the row's list, to migrate that pair. Unassigned Emby users are skipped. Each assignment saves as you make it.
7. Click **Run migration**. The run starts within a minute and works through the library in batches once a minute, with progress in the **Migration status** row and in the Activities menu. The **Migration status** row shows the final summary.

## Mirroring the source

**Mirror the source exactly (may unwatch items in Matinee)** copies the Emby state as it is, which can move resume positions back in Matinee where Emby has less progress, and unwatches every matched item that Emby does not mark watched. Leave it off unless that is what you want.

## Permissions

The plugin requests the `network` scope to reach the Emby server, the `storage` scope for the progress of a running migration and the last summary, and the `watch-states` scope to read Matinee users and write their watch state.
