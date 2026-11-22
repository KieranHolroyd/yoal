---
title: Cloud shell
description: A terminal in the dashboard that runs on one of your servers, with the yoal CLI signed in and a home directory that keeps your files.
---

The cloud shell is your own terminal in the browser. It runs in a small container on one of the install's servers, with the [`yoal` CLI](/clients/cli) already installed and signed in as you, so you can run CLI commands from any computer without installing anything. Files in your home directory are kept on their own disk (1 GiB unless you choose another size) between sessions.

> [!NOTE]
> The cloud shell needs the `cloudShell:use` permission, which owners, admins and deployers have and viewers do not. An operator can turn it off with `YOAL_FEATURE_CLOUD_SHELL=0`.

## Open it

Click **Cloud shell** at the top right of any dashboard page, or press **Ctrl+`**. The terminal opens in a drawer at the bottom of the page and starts your shell if it is not running. The first start picks a server and can take a minute while that server downloads the shell's image. After that, a start takes a few seconds.

The drawer stays connected while you move between pages. Drag its top edge to make it taller or shorter, or double-click the edge to maximise it. Hiding it (the arrow at its top right, or **Ctrl+`** again) keeps the shell running. **New session** closes the current terminal session and opens a fresh one in the same shell; **Stop** stops the shell. The **⋯** menu has **Reset disk** and a link to the details page (`/cloud-shell`), which shows the server, the disk and the limits.

If a start fails, the drawer says why and offers **Try again**. It does not retry on its own.

When the terminal shows a prompt, try:

```sh
yoal projects
yoal --help
```

Use **Stop** when you are done, or just close the tab: the shell stops by itself after 20 minutes without typing, and after 12 hours in any case. Opening the page again starts it again with your files where you left them.

## What is in it

- **The `yoal` CLI**, the same version as the install, signed in as you in your current organisation. It can do exactly what your role allows, nothing more.
- **Node.js, Bun, git, ssh, curl, jq, `psql`, `redis-cli`, an editor** (`nano`, `vi`) and the usual small tools.
- **Your home directory**, `/home/yoal`, on its own disk. `df -h ~` shows how much is used.

Everything outside your home directory resets when the shell stops, and the system directories are read-only. Install tools into your home directory instead. `npm install -g`, `pip install` and `bun install -g` already do that here, and `~/.local/bin` is on your `PATH`.

## Signed in as you

The CLI uses an access key that is created for you when the shell starts. It is named **Cloud shell**, belongs to your current organisation, expires after about 12 hours, and is revoked as soon as the shell stops. Yoal hands it only to your shell.

If your role cannot create access keys, the shell still starts but the CLI is not signed in. The greeting says so. Ask an admin for a key and run `yoal login`.

## Limits

| | Default | You can choose |
|---|---|---|
| Home disk | 1 GiB, kept between sessions | 256 MiB to 8 GiB |
| Memory | 512 MiB, including `/tmp` | 256 MiB to 4 GiB |
| CPU | 1 core | 1 to 4 cores |
| Idle stop | 20 minutes without typing | 5 minutes to 4 hours |
| Longest session | 12 hours | |

## Change the size and server

Open **Settings…** from the **⋯** menu in the drawer, or **Settings** on the cloud shell's details page. You can choose:

- **Node**: the server your home disk is made on, or **Automatic** to let Yoal pick the one with the fewest shells. The list shows how much disk and memory each server has free, and why a server cannot be chosen.
- **Home disk**, **Memory**, **CPUs** and **Idle stop**.

When each change applies:

- **Memory, CPUs and idle stop** apply the next time the shell starts. If it is running, choose **Save and restart**, or **Restart now** later.
- **A bigger disk** grows at the next start and keeps your files. If the server's agent is too old to grow disks, the drawer says so and the disk grows once the server is updated.
- **A smaller disk** or **another server** needs a [reset](#reset-your-disk), because your files are on that disk on that server. The drawer and the details page show what is waiting and offer the button that applies it.

If the server does not have the memory or disk free for your choices, the shell does not start and the drawer says how much is free. Choose smaller settings or another server.

The shell runs with the same restrictions as an app container: it cannot gain privileges, change the server or see other people's shells. It can reach the internet and, on installs with per-organisation networks, your organisation's services by their internal names.

## Reset your disk

**Reset disk** stops the shell and deletes its disk with everything in it. The next start gives you a new, empty home directory with the size and server from your settings (another server when **Node** is **Automatic**). Use it to start clean, or when the server holding your disk is offline and you do not want to wait for it.

## Let the assistant use it

The [dashboard assistant](/clients/assistant) can run commands in your cloud shell for you, one at a time. Each command is shown in full on a card and runs only when you click **Confirm**. See [commands in your cloud shell](/clients/assistant#commands-in-your-cloud-shell).

## Privacy and audit

Starting, stopping and resetting a shell, and opening a terminal in it, are recorded in the [audit log](/accounts/security-model). What you type and what the shell prints are never recorded. A command the assistant runs for you is the exception: the command itself is recorded, never its output. Each person's shell is their own: nobody else can open a terminal in it.
