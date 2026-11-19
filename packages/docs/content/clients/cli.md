---
title: CLI
description: Install the yoal CLI, sign in, manage profiles, and learn the global options, environment variables and exit codes every command shares.
---

The `yoal` command is the terminal client for a Yoal control plane. This page covers installation, signing in, profiles and settings, global options, environment variables and exit codes. Every command, subcommand and flag is documented in the **CLI reference** section; the [command index](#command-index) at the end of this page links to each one.

## Install

```sh
npm install -g @yoal/cli
```

Bun works too: `bun add -g @yoal/cli`. To run it without installing, use `npx --package @yoal/cli yoal --help`. The CLI needs Node.js 20 or later.

The package installs the `yoal` command. This page uses `yoal`.

```sh
yoal --version
yoal --help
```

## Sign in

### Browser login

`yoal login` opens your dashboard so you can approve the CLI. Once you approve, the CLI stores a new API key in the selected profile and waits up to five minutes for approval.

```sh
yoal login --url https://control.example.com
yoal login --url https://control.example.com --no-browser   # print the URL instead of opening it
```

Use `--no-browser` on a machine without a browser, such as over SSH. Accounts, two-factor sign-in and key management are covered in [sign-in and 2FA](/accounts/sign-in-and-2fa) and [API keys and tokens](/accounts/api-keys-and-tokens).

### With an API key

Create a key in the dashboard, then store it directly with `--token`. The CLI checks the key with the server before saving it.

```sh
yoal login --url https://control.example.com --token yoal_...
```

### In CI and scripts

Set `YOAL_URL` and `YOAL_TOKEN` in the environment. No login and no config file are needed.

```sh
export YOAL_URL=https://control.example.com
export YOAL_TOKEN=yoal_...
yoal deploy ./dist --project my-site --json
```

When `YOAL_TOKEN` is set, `yoal login` stores that key rather than opening the browser. Add `--web` or `--no-browser` to force browser sign-in instead.

### Signing out

`yoal logout` removes the API key from the selected profile and keeps its URL and content domain, so the next `yoal login` remembers them. `yoal logout --all` deletes the whole config file.

## Profiles and settings

The CLI stores settings and credentials in `~/.config/yoal/config.json`, with file mode `0600`. Set `YOAL_CONFIG_DIR` to use a different directory, or `XDG_CONFIG_HOME` to change the base directory (the file is then `$XDG_CONFIG_HOME/yoal/config.json`).

Each profile holds one deployment: its control-plane URL, API key and content domain. Use a profile per Yoal installation, for example production and a local development server:

```sh
yoal login --profile prod --url https://control.example.com
yoal login --profile dev  --url http://localhost:5173

yoal profile use dev            # make dev the default
yoal --profile prod status      # one command against prod
YOAL_PROFILE=prod yoal deploy ./dist
```

A command picks its profile in this order:

1. `--profile <name>` on the command line.
2. `YOAL_PROFILE`.
3. The active profile set by `yoal profile use`.
4. The only profile, if you have exactly one.

If you have several profiles and none is active, the command stops and asks you to choose. When `YOAL_URL` and `YOAL_TOKEN` are both set, the CLI uses them and does not need a profile.

Profiles written by older CLI versions are read as a profile named `default` and upgraded the next time they are written.

### Settings

| Setting | Environment variable | What it is |
| --- | --- | --- |
| `url` | `YOAL_URL` | Control-plane URL, for example `https://control.example.com` |
| `contentDomain` | `YOAL_CONTENT_DOMAIN` | Domain that deployed sites are served from, used to build preview URLs |
| `token` | `YOAL_TOKEN` | API key |

`yoal config` accepts a few aliases, such as `platform` and `control` for `url`, `content-domain` for `contentDomain`, and `api-key` for `token`. A URL without a scheme gets `https://`, or `http://` for `localhost`.

```sh
yoal config list                                  # effective values and where each one comes from
yoal config set url https://control.example.com
yoal config get url                              # prints the value only, so it works in scripts
yoal config unset token                          # same as yoal logout
yoal config path
```

Environment variables override the stored settings for that process only.

## Global options and output

| Option | Meaning |
| --- | --- |
| `--profile <name>` | Use a saved profile. Accepted before or after the command. |
| `-h`, `--help` | Show help for the CLI or for one command. `yoal help <command>` also works. |
| `-v`, `--version` | Print the CLI version. |
| `--json` | Print the server response as JSON. Most commands accept it. Bulk, prune and `watch` runs print NDJSON events, one per line. |

Boolean flags have a `--no-` form, for example `--no-promote` and `--no-create`. Booleans also accept an explicit value, as in `--flag=false`.

Errors go to stderr, with suggestions on the lines after the message. With `--json`, the error is a JSON object instead:

```json
{
  "error": {
    "code": "project_missing",
    "message": "Project \"my-site\" does not exist. Create it in the dashboard or re-run without --no-create.",
    "suggestions": []
  }
}
```

Failed API calls also include `status` and `requestId`, which are useful when you report a problem. Set `YOAL_DEBUG=1` to print the full error object, including the stack trace.

## Environment variables

| Variable | Effect |
| --- | --- |
| `YOAL_URL` | Control-plane URL. Overrides the profile's URL. |
| `YOAL_TOKEN` | API key. Overrides the profile's key. Also makes `yoal login` store this key without opening the browser. |
| `YOAL_CONTENT_DOMAIN` | Content domain. Overrides the profile's value. |
| `YOAL_PROFILE` | Profile to use when `--profile` is not given. |
| `YOAL_CONFIG_DIR` | Directory that holds `config.json`. Takes precedence over `XDG_CONFIG_HOME`. |
| `XDG_CONFIG_HOME` | Base directory. The config file is `$XDG_CONFIG_HOME/yoal/config.json`. |
| `YOAL_DEBUG` | Set to `1` to print full error details. |
| `YOAL_TOKEN_FILE` | Workload token file read by [`yoal identity`](/cli/identity-and-access#identity) inside a workload. |
| `YOAL_IDENTITY_URL` | Node metadata endpoint used by [`yoal identity`](/cli/identity-and-access#identity). |
| `CI` | When set, the CLI installs Wrangler without asking (as it also does when stdin is not a terminal). |
| `NO_COLOR` | Turns off the dimmed log lines `yoal function` prints. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command succeeded. |
| `1` | The command failed. This covers API errors, usage errors, unknown commands, a declined confirmation, and a bulk or prune run that failed or was cancelled. |
| `3` | A bulk, prune, `blueprint apply` or `operations watch` run finished partially: some items succeeded and some failed. |
| `130` | You pressed Ctrl-C while following an operation. The CLI detached, and the operation keeps running on the server. |

`yoal function` exits `1` when the function answers with an error. `yoal run`, `yoal jobs run` and `yoal jobs logs -f` exit with the command's own status, `124` when it timed out and `130` when it was cancelled. `yoal wrangler` returns the exit code of the Wrangler process it ran.


## Docs in the terminal

`yoal docs` searches and prints this documentation as Markdown, offline and without signing in, because the docs are bundled into the CLI. Run `yoal docs search <words>` to find a section and `yoal docs read <ref>` to print it. It is designed for AI coding agents as much as for people; see [docs for AI agents](/clients/agent-docs).

## Conventions

The reference pages use the same notation as `yoal --help`:

- Arguments in angle brackets are required: `<project>`. Arguments in square brackets are optional: `[dir]`. An ellipsis means you can repeat it: `<slug…>`.
- Flags take their value after a space or an equals sign: `--project my-site` and `--project=my-site` are the same.
- Boolean flags have a `--no-` form, for example `--no-promote`, and accept an explicit value, as in `--spa=false`.
- `--` ends the flags. Everything after it is passed through untouched, which is how `yoal run <project> -- <command…>` and `yoal wrangler` receive their arguments.
- `-h`, `--help` and `yoal help <command>` print a command's help without contacting the server.

Commands that delete, purge or change many things show what they will do and ask before doing it. When stdin is not a terminal the CLI cannot ask, so pass `--yes` to confirm; without it the command stops and exits `1`. The most destructive actions, such as purging a database or many projects, ask you to type the name or the count even on a terminal.

## Command index

Every top-level command, grouped as in the reference. Aliases run the same command.

### Accounts, profiles and status

| Command | Aliases | What it does |
| --- | --- | --- |
| [`login`](/cli/accounts-and-settings#login) | | Sign in with the browser or an API key |
| [`logout`](/cli/accounts-and-settings#logout) | | Forget the API key; `--all` removes the config file |
| [`config`](/cli/accounts-and-settings#config) | | Inspect or change persistent settings |
| [`profile`](/cli/accounts-and-settings#profile) | | Manage profiles for several deployments |
| [`org`](/cli/accounts-and-settings#org) | `organization`, `organisation` | Switch the active organisation |
| [`status`](/cli/accounts-and-settings#status) | | Fleet health, or one project's status |
| [`usage`](/cli/accounts-and-settings#usage) | | Usage and quota percentages |
| [`audit`](/cli/accounts-and-settings#audit) | | The organisation's audit log |
| [`docs`](/clients/agent-docs) | `doc` | Search and read this documentation offline, built for AI agents |

### Deploying and projects

| Command | Aliases | What it does |
| --- | --- | --- |
| [`deploy`](/cli/deploying#deploy) | | Package a directory and deploy it |
| [`wrangler`](/cli/deploying#wrangler) | | Run Wrangler locally, installing it if needed |
| [`projects`](/cli/deploying#projects) | | List projects; bulk delete, restore and purge |
| [`deployments`](/cli/deploying#deployments) | | List a project's deployments |
| [`promote`](/cli/deploying#promote) | | Point production at a deployment |
| [`rollback`](/cli/deploying#rollback) | | Move production back one deployment |
| [`environments`](/cli/deploying#environments) | `environment` | Named environments and their pointers |
| [`domains`](/cli/deploying#domains) | `domain` | Custom domains and DNS verification |
| [`open`](/cli/deploying#open) | | Open a site in the browser |
| [`logs`](/cli/deploying#logs) | | Recent project logs |

### Apps, containers and functions

| Command | Aliases | What it does |
| --- | --- | --- |
| [`workload`](/cli/compute#workload) | `workloads` | Runtime spec: command, image, port, memory, idle stop |
| [`container`](/cli/compute#container) | `ctr` | Inspect a container project, read its files, restart it |
| [`shell`](/cli/compute#shell) | | Interactive shell inside a container project |
| [`scale`](/cli/compute#scale) | | Run more or fewer copies, or autoscale |
| [`jobs`](/cli/compute#jobs) | `job` | Cron jobs and manual commands on an app |
| [`run <project> -- …`](/cli/compute#run) | | One-off command against the app's current release |
| [`function`](/cli/compute#function) | `functions`, `fn` | Invoke a function or run its cron now |
| [`volume`](/cli/compute#volume) | `volumes` | Persistent volumes and snapshots |

### Databases and backups

| Command | Aliases | What it does |
| --- | --- | --- |
| [`db`](/cli/databases#db) | `databases` | Managed PostgreSQL: create, attach, credentials, recovery, replicas |
| [`backup-target`](/cli/databases#backup-target) | `backupTargets` | Where backups are written |

### Storage, brokers, events and email

| Command | Aliases | What it does |
| --- | --- | --- |
| [`storage`](/cli/data-services#storage) | `s3` | S3-compatible object storage, buckets and grants |
| [`broker`](/cli/data-services#broker) | `brokers`, `queue` | Managed NATS brokers and queue tools |
| [`events`](/cli/data-services#events) | `event` | Send platform events to a function queue |
| [`email`](/cli/data-services#email) | `mail` | Send email from your own domains |
| [`log-drain`](/cli/data-services#log-drain) | `log-drains` | Forward logs to a webhook or OTLP receiver |

### Pipelines and registry

| Command | Aliases | What it does |
| --- | --- | --- |
| [`repo`](/cli/pipelines-and-registry#repo) | `repos`, `repository` | Git repositories for pipelines |
| [`run`](/cli/pipelines-and-registry#run) | | Pipeline runs: list, watch, logs, cancel, rerun |
| [`workflow`](/cli/pipelines-and-registry#workflow) | `workflows`, `wf` | Dispatch, run locally or lint a workflow |
| [`secret`](/cli/pipelines-and-registry#secret) | `secrets` | Pipeline secrets |
| [`var`](/cli/pipelines-and-registry#var) | `vars` | Pipeline variables |
| [`runners`](/cli/pipelines-and-registry#runners) | | Clean up stale runner registrations |
| [`registry`](/cli/pipelines-and-registry#registry) | `images` | The platform registry, registry logins and image deploys |

### Identity and access

| Command | Aliases | What it does |
| --- | --- | --- |
| [`iam`](/cli/identity-and-access#iam) | | Roles, bindings, groups, and why access is allowed |
| [`identity`](/cli/identity-and-access#identity) | | Workload identity tokens |
| [`sts`](/cli/identity-and-access#sts) | | Exchange a subject token for a short-lived Yoal token |
| [`sa`](/cli/identity-and-access#sa) | `service-account`, `service-accounts` | Service accounts, tokens and keys |
| [`federation`](/cli/identity-and-access#federation) | `federations` | Map an OIDC issuer to a service account |
| [`access`](/cli/identity-and-access#access) | | Just-in-time access requests |
| [`key`](/cli/identity-and-access#key) | `keys`, `access-key`, `access-keys` | Access keys |
| [`pool`](/cli/identity-and-access#pool) | `pools`, `user-pool`, `user-pools` | Managed user pools and their OIDC clients |
| [`access-policy`](/cli/identity-and-access#access-policy) | `access-policies` | Yoal Access allow and deny policies |

### Operations, blueprints and config

| Command | Aliases | What it does |
| --- | --- | --- |
| [`prune`](/cli/operations-and-config#prune) | | Find and remove orphaned data |
| [`operations`](/cli/operations-and-config#operations) | `ops` | Inspect, follow and cancel bulk and prune operations |
| [`blueprint`](/cli/operations-and-config#blueprint) | `blueprints` | Declare a stack in one file; plan and apply it |
| [`export`](/cli/operations-and-config#export) | | Write the organisation's configuration to a file |
| [`import`](/cli/operations-and-config#import) | | Recreate an export's configuration here |

### Platform administration

| Command | Aliases | What it does |
| --- | --- | --- |
| [`ha`](/cli/platform#ha) | | Failover controller status |
| [`fleet`](/cli/platform#fleet) | | Node utilisation, rebalancing and links between nodes |
| [`nodes`](/cli/platform#nodes) | `node` | Update one node, or roll an update across the fleet |
| [`upgrade`](/cli/platform#upgrade) | | Preflight, install or roll back the platform |
