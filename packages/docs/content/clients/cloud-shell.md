---
title: Cloud shell
description: A terminal in the dashboard that runs on one of your servers, with the yoal CLI signed in and a 1 GiB home directory that keeps your files.
---

The cloud shell is your own terminal in the browser. It runs in a small container on one of the install's servers, with the [`yoal` CLI](/clients/cli) already installed and signed in as you, so you can run CLI commands from any computer without installing anything. Files in your home directory are kept on a 1 GiB disk between sessions.

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
- **Your home directory**, `/home/yoal`, on its own 1 GiB disk. `df -h ~` shows how much is used.

Everything outside your home directory resets when the shell stops, and the system directories are read-only. Install tools into your home directory instead. `npm install -g`, `pip install` and `bun install -g` already do that here, and `~/.local/bin` is on your `PATH`.

## Signed in as you

The CLI uses an access key that is created for you when the shell starts. It is named **Cloud shell**, belongs to your current organisation, expires after about 12 hours, and is revoked as soon as the shell stops. Yoal hands it only to your shell.

If your role cannot create access keys, the shell still starts but the CLI is not signed in. The greeting says so. Ask an admin for a key and run `yoal login`.

## Limits

| | |
|---|---|
| Home disk | 1 GiB, kept between sessions |
| Memory | 512 MiB, including `/tmp` |
| CPU | 1 core |
| Idle stop | 20 minutes without typing |
| Longest session | 12 hours |

The shell runs with the same restrictions as an app container: it cannot gain privileges, change the server or see other people's shells. It can reach the internet and, on installs with per-organisation networks, your organisation's services by their internal names.

## Reset your disk

**Reset disk** stops the shell and deletes its disk with everything in it. The next start gives you a new, empty home directory, possibly on another server. Use it to start clean, or when the server holding your disk is offline and you do not want to wait for it.

## Let the assistant use it

The [dashboard assistant](/clients/assistant) can run commands in your cloud shell for you, one at a time. Each command is shown in full on a card and runs only when you click **Confirm**. See [commands in your cloud shell](/clients/assistant#commands-in-your-cloud-shell).

## Privacy and audit

Starting, stopping and resetting a shell, and opening a terminal in it, are recorded in the [audit log](/accounts/security-model). What you type and what the shell prints are never recorded. A command the assistant runs for you is the exception: the command itself is recorded, never its output. Each person's shell is their own: nobody else can open a terminal in it.
