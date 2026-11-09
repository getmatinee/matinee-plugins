# Hello World

The reference plugin. It does nothing useful on purpose: it logs when it loads, counts the media a scan adds, and runs a scheduled task with a counter in its storage, so you can see each part of the plugin API working before you write your own.

Read it alongside [the plugin API reference](../../docs/plugin-api.md).

## What it demonstrates

- **Loading**: a log line with the version and the configured greeting each time the plugin starts, which includes every config save.
- **Configuration**: the "Greeting" text field declared in `manifest.json` and read back with `matinee.getConfig()`.
- **Events**: a count of `media.added` events, reported once per `scan.completed` instead of once per item.
- **Storage**: a counter kept in the plugin's own storage across restarts, which is what the `storage` scope grants.
- **Scheduling**: a task that runs every 60 minutes and logs how many times it has run.

## Install

1. Open **Server settings -> Plugins** and install "Hello World" from the catalog. The install enables the plugin.
2. Click **Configure** on the plugin and enter a greeting. The greeting saves when you leave the field.
3. Read the **Logs** section of the same dialog, which shows the load line with your greeting, one line after each library scan, and a heartbeat line every hour.

## Permissions

It requests the `storage` scope only, so it can keep its counter. It makes no network requests and sees nothing beyond the event payloads every plugin receives.

## Using it as a template

Copy the directory, change `id`, `name` and `description` in `manifest.json`, and point `homepage` at your own plugin's directory. For a TypeScript starter with a build step, use [`template-ts`](../../template-ts) instead.
