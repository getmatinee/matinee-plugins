# Hello World

The reference plugin. It does nothing useful on purpose: it logs the lifecycle events a plugin receives, stores a counter, and runs a scheduled task, so you can see each part of the plugin API working before you write your own.

Read it alongside [the plugin API reference](../../docs/plugin-api.md).

## What it demonstrates

- **Lifecycle**: `onInstall`, `onEnable`, `onDisable` and `onUninstall`, each writing a line you can watch under Configure -> Logs.
- **Configuration**: a text field and a checkbox declared in `manifest.json`, read back at runtime.
- **Storage**: a counter kept in the plugin's own storage across restarts, which is what the `storage` scope grants.
- **Scheduling**: a periodic task that logs how many times it has run.

## Install

1. Open **Settings -> Plugins** and install "Hello World" from the catalog.
2. Enable it, then open **Configure** and change the greeting.
3. Open **Logs** in the same dialog to watch the lifecycle and scheduled lines arrive.

## Permissions

It requests the `storage` scope only, so it can keep its counter. It makes no network requests and reads nothing about your library or your users.

## Using it as a template

Copy the directory, change `id`, `name` and `description` in `manifest.json`, and point `homepage` at your own plugin's directory. For a TypeScript starter with a build step, use [`template-ts`](../../template-ts) instead.
