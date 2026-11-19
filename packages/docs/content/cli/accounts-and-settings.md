---
title: Accounts, profiles and status
description: Reference for yoal login, logout, config, profile, org, status, usage and audit, with every subcommand, flag and JSON shape.
---

These commands connect the `yoal` CLI to a control plane and tell you about it: signing in and out, the stored settings and profiles, the active organisation, platform health, quota usage and the audit log. Global options (`--profile`, `--json`, `--help`), environment variables and exit codes are described once in the [CLI overview](/clients/cli); this page lists what each command adds.

Arguments in angle brackets are required and arguments in square brackets are optional. Every boolean flag also has a `--no-` form, and every command accepts `-h, --help`. Unless a section says otherwise, a command exits `0` on success and `1` on any error.

## login

```sh
yoal login [--url <platform>] [--token <key>] [--web] [--no-browser] [--json]
```

Signs the selected profile in to a control plane and stores an API key in it. By default the CLI opens the dashboard so you can approve it in the browser; with `--token` it stores a key you created yourself. Accounts, two-factor sign-in and key management are covered in [sign-in and 2FA](/accounts/sign-in-and-2fa) and [API keys and tokens](/accounts/api-keys-and-tokens).

| Flag | Description |
| --- | --- |
| `-u`, `--url <platform>` | Control-plane URL. Without it, the CLI uses `YOAL_URL`, then the profile's saved URL, then asks `Platform URL:`. A URL without a scheme gets `https://`, or `http://` for `localhost` and `127.0.0.1`. |
| `-t`, `--token <key>` | Store this API key instead of signing in with the browser. The CLI checks the key with the server before saving it. |
| `--web` | Use browser sign-in even when `YOAL_TOKEN` is set. |
| `--no-browser` | Use browser sign-in, but print the approval URL instead of opening a browser. Useful over SSH. |
| `--json` | Print the result as JSON. |

`--web` and `--no-browser` cannot be combined with `--token`. The command takes no positional arguments.

Which profile is written follows the usual order: `--profile`, then `YOAL_PROFILE`, then the active profile, then the only profile, and on a fresh machine a profile named `default`. A profile named with `--profile` that does not exist yet is created. If no profile is active, the one you log in to becomes active. With several profiles and none active, `login` stops and asks you to choose one. See [profiles](#profile).

How the key is chosen:

1. `--token <key>` if given.
2. Otherwise `YOAL_TOKEN`, unless `--web` or `--no-browser` is set. This lets CI store a key without a browser.
3. Otherwise browser sign-in.

Browser sign-in starts a temporary listener on `127.0.0.1`, opens `<platform>/cli/login` and prints `Waiting for approval...` to stderr. Once you approve the request in the dashboard, the server issues a new API key for the CLI, in the organisation you last worked in. Your role needs the `apiKey:create` permission; without it the server refuses and asks you to contact an owner or admin. The CLI waits up to five minutes. If you cancel in the browser the command fails with the code `login_cancelled`, and if the time runs out it fails with `login_timeout`.

On success the CLI saves the URL the server reports as its canonical address (so logging in through an IP address saves the real hostname), the API key and the content domain, keeping the profile's existing content domain when the server reports none. The file is written with mode `0600`. Text output shows the profile, user, organisation, sites domain and config path, and warns when `YOAL_URL`, `YOAL_TOKEN` or `YOAL_CONTENT_DOMAIN` are set, because they override what was just saved.

If the CLI has to ask for the URL and stdin is not a terminal, it reads the first line of stdin as the answer instead.

With `--json` the output is an object with `url`, `platform`, `profile`, `contentDomain`, `user`, `org`, `permissions` (the key's permission strings), `configPath` and `method` (`web` or `token`).

```sh
yoal login --url https://control.example.com
yoal login --profile staging --url https://staging.example.com --no-browser
yoal login --url https://control.example.com --token yoal_... --json
```

## logout

```sh
yoal logout [--all] [--json]
```

Removes the selected profile's API key. The profile's URL and content domain stay, so the next `yoal login` remembers them. If the profile had no URL or content domain left, the profile itself is removed, and when no profiles remain the config file is deleted. Use `--profile <name>` to sign out of a profile other than the current one.

| Flag | Description |
| --- | --- |
| `--all` | Delete the whole config file, including every profile and its key. |
| `--json` | Print the result as JSON. |

> [!WARNING]
> `yoal logout --all` deletes every profile immediately, without asking. It only touches the local file: the API keys themselves stay valid until you revoke them in the dashboard.

Logging out does not revoke the key on the server; see [API keys and tokens](/accounts/api-keys-and-tokens) to revoke one. When `YOAL_TOKEN` is still set in your environment, the CLI says so, because commands will keep using it.

With `--json` the output has `loggedOut`, `removed` (whether a key or file was actually removed), `configPath`, `profile`, `settingsKept` and `envTokenStillSet`.

```sh
yoal logout
yoal logout --profile staging
yoal logout --all
```

## config

```sh
yoal config [list|get|set|unset|path] [options]
```

Reads and writes the settings of the selected profile in the config file (`~/.config/yoal/config.json` by default; see the [CLI overview](/clients/cli) for `YOAL_CONFIG_DIR` and `XDG_CONFIG_HOME`). Without a subcommand, `config` runs `list`. To work on a profile other than the current one, add `--profile <name>`.

There are three settings. Each key also accepts the aliases shown, case-insensitively:

| Key | Aliases | Environment variable | What it is |
| --- | --- | --- | --- |
| `url` | `platform`, `platform-url`, `platformurl`, `control`, `control-url`, `controlurl` | `YOAL_URL` | Control-plane URL, such as `https://control.example.com`. |
| `contentDomain` | `content-domain`, `contentdomain`, `content`, `domains`, `sites-domain`, `deployments-domain` | `YOAL_CONTENT_DOMAIN` | Domain deployed sites are served from, used to build preview URLs. |
| `token` | `api-key`, `apikey` | `YOAL_TOKEN` | API key. |

Environment variables override the stored values for the process that sets them; `config list` and `config get` show the effective value and where it came from. Every subcommand accepts `--json`.

### config list

```sh
yoal config list [--json]
```

Shows each setting, its effective value and its source: `config`, `env (YOAL_…)` or `unset`. The token is masked to its first and last four characters. The output ends with the profile and config file path. Also available as `config ls`.

With `--json`: `path`, `stored` (whether the selected profile exists in the file), `profile`, `activeProfile`, `profiles` (every profile name) and `settings`, an array of `{ key, value, source, secret, env }` with the token masked.

```sh
yoal config list
yoal --profile prod config list --json
```

### config get

```sh
yoal config get <key> [--json]
```

Prints one effective value and nothing else, so it works in scripts. When the value is unset it prints nothing and still exits `0`. Unlike `list`, `get token` prints the full, unmasked key.

With `--json`: `key`, `value` (or `null`), `source`, `env` and `path`.

```sh
yoal config get url
curl -fsS "$(yoal config get url)/api/v1/whoami" -H "Authorization: Bearer $(yoal config get token)"
```

### config set

```sh
yoal config set <key> <value> [--json]
```

Saves a value to the selected profile. If no profile exists yet, it creates one named `default` and makes it active. URLs are normalised the same way as in `login`. A content domain must be a bare hostname such as `sites.example.com`; a full URL is reduced to its hostname, and paths, ports, wildcards and spaces are rejected.

Setting `token` stores the key without checking it with the server; `yoal login --token` checks it first. With `--json`, the `value` of a token is `null`.

```sh
yoal config set url control.example.com
yoal config set content-domain sites.example.com
```

### config unset

```sh
yoal config unset <key> [--json]
```

Removes a value from the selected profile. `config unset token` does the same as `yoal logout`. If the profile has no settings left, it is removed, and the config file is deleted when it was the last one. Unsetting a value that is not set prints `<key> was not set.` and exits `0`. Also available as `config remove` and `config rm`.

With `--json`: `path`, `key`, `changed` and `profile`.

```sh
yoal config unset contentDomain
```

### config path

```sh
yoal config path [--json]
```

Prints the config file path, whether or not the file exists. With `--json`: `path`, `exists` and `profile`.

```sh
yoal config path
```

## profile

```sh
yoal profile [list|add|use|remove|show|current] [options]
```

A profile holds one control plane's URL, API key and content domain, so one machine can work with production, staging and a local development server. Without a subcommand, `profile` runs `list`.

A command picks its profile in this order: the global `--profile <name>` flag, `YOAL_PROFILE`, the active profile set by `profile use`, and finally the only profile when exactly one exists. With several profiles and none active, commands stop with an error asking you to choose. When `YOAL_URL` and `YOAL_TOKEN` are both set, commands run without a profile. More on how profiles fit with environment variables is in the [CLI overview](/clients/cli).

Profile names are 1 to 64 characters: letters, digits, dots, dashes and underscores, starting with a letter or digit. Profile commands only change the local config file; none of them contact the server.

### profile list

```sh
yoal profile list [--json]
```

Lists every profile with its URL, sites domain and masked token. `*` marks the profile commands will use. The output ends with the config path and the active profile, or a reminder to run `profile use` when there are several profiles and none is active. Also available as `profile ls`.

With `--json`: `path`, `activeProfile` (saved with `profile use`), `currentProfile` (the one commands will use, after `YOAL_PROFILE` and `--profile`) and `profiles`, each with `name`, `url`, `contentDomain`, the masked `token`, `savedAt`, `updatedAt`, `active` and `current`.

```sh
yoal profile list
```

### profile add

```sh
yoal profile add <name> [--url <platform>] [--token <key>] [--content-domain <domain>] [--use] [--force] [--json]
```

Adds a profile without signing in. You must give `--url`, `--token` or both. The first profile you add becomes active automatically. Also available as `profile create`.

| Flag | Description |
| --- | --- |
| `-u`, `--url <platform>` | Control-plane URL. Normalised the same way as in `login`. |
| `-t`, `--token <key>` | API key. Stored without checking it; prefer `yoal login --profile <name>`, which verifies the key. |
| `--content-domain <domain>` | Domain deployed sites use, such as `sites.example.com`. Must be a bare hostname. |
| `--use` | Make the new profile active. |
| `--force` | Replace an existing profile of the same name. The old profile's values are discarded, not merged. |
| `--json` | Print the result as JSON (`path`, `name`, `activeProfile`, `created`, `changed`). |

Adding a name that already exists fails unless you pass `--force`. A profile added without `--token` has no key yet: run `yoal login --profile <name>` to sign it in.

```sh
yoal profile add staging --url https://staging.example.com --content-domain sites.staging.example.com --use
yoal profile add dev --url localhost:5173
yoal login --profile dev
```

### profile use

```sh
yoal profile use <name> [--json]
```

Makes a profile the active one, so commands use it when neither `--profile` nor `YOAL_PROFILE` is set. The profile must already exist. Also available as `profile select` and `profile switch`.

With `--json`: `path`, `name`, `previous`, `activeProfile` and `changed`.

```sh
yoal profile use prod
```

### profile remove

```sh
yoal profile remove <name> [--json]
```

Deletes a profile, including its API key, without asking for confirmation. If it was the active profile and exactly one profile remains, that one becomes active; otherwise no profile is active until you run `profile use`. Removing the last profile deletes the config file. Also available as `profile rm` and `profile delete`.

The key itself stays valid on the server until you revoke it.

```sh
yoal profile remove old-staging
```

### profile show

```sh
yoal profile show [name] [--json]
```

Shows one profile: its name (marked `(current)` when commands use it), URL, sites domain, masked token, last update time and the config path. Without a name it shows the profile commands would use, and fails when none can be chosen.

With `--json`: `path`, `activeProfile` and `profile`, in the same shape as an entry of `profile list`.

```sh
yoal profile show
yoal profile show staging --json
```

### profile current

```sh
yoal profile current [--json]
```

Prints only the name of the profile commands will use, which makes it handy in prompts and scripts. It takes `--profile` and `YOAL_PROFILE` into account. It fails when there are no profiles, or when there are several and none is active. Also available as `profile whoami`.

With `--json`: `profile`, `activeProfile` and `path`.

```sh
yoal profile current
YOAL_PROFILE=dev yoal profile current
```

## org

Aliases: `organization`, `organisation`.

```sh
yoal org switch <org-id> [--json]
```

Works with the active organisation. Running `yoal org` with no subcommand prints its help. Organisations and memberships are explained in [organisations and roles](/accounts/organizations-and-roles).

### org switch

```sh
yoal org switch <org-id> [--json]
```

Asks the server to make another organisation you belong to the active one for the current session. The server remembers the choice, so your next sign-in starts there. On success the CLI prints `Switched to <name> (<org-id>).` Also available as `org use`. With `--json`, the output is the server's response, `{ "org": { "id", "name", "slug", "role" } }`.

The server only accepts this from a signed-in browser session. An API key is bound to the organisation it was created in, so a request made with the CLI's key is refused with `unauthorized` (HTTP 401). If you are not a member of the organisation, the server answers `forbidden` (403). To work in a different organisation from the CLI, sign a profile in with a key from that organisation: switch organisation in the dashboard first, then run `yoal login`.

```sh
yoal org switch org_abc123
```

## status

```sh
yoal status [project] [--json]
```

Without a project, shows your organisation's view of the platform: overall health, the platform address and version, project and deployment counts (with how many are active), how many nodes are online and offline, storage used, and the agent version nodes should run. A table follows with each node's status, CPU, memory, disk use and last heartbeat.

With a project slug, it shows the same summary and then the project: name, production URL, access modes for production and previews, the production deployment ID, and its deployments with the current production deployment marked `*`.

It needs the `project:read` permission. See [nodes and fleet](/self-hosting/nodes-and-fleet) for what node status means and [static sites](/deploying/static-sites) for deployments and access modes.

With `--json` and no project, the output is the server's status response. With a project, it is `{ "status": …, "project": …, "deployments": … }`, each the raw server response.

```sh
yoal status
yoal status my-site
yoal --profile prod status --json
```

## usage

```sh
yoal usage [project] [--json]
```

Shows your organisation's usage against each quota: what is used, the limit (`unlimited` when there is none) and the percentage. With a project slug, it shows only that project's resources. Counts are current, database and storage sizes are the latest samples, and egress is an estimate over the last 30 days. Any metric at or above 80% of its limit is listed under **Warnings** at the end.

The metrics are projects, databases, database storage, storage instances, storage bytes, storage objects, app volumes, app volume bytes, jobs, job runs per day, builds per day, previews, workload memory, egress and registry storage. Metrics the server does not report are left out.

It needs `project:read`, on the organisation or on the named project. Quotas, the numbers behind them and the CSV export are covered in [quotas and limits](/self-hosting/quotas-and-limits).

With `--json` the output is the server's usage response unchanged, including `orgId`, `projectSlug`, `periodDays`, `metrics` (each with `used`, `limit`, `percent` and `unit`, where a limit of `-1` means unlimited) and `warnings`.

```sh
yoal usage
yoal usage my-site
yoal usage --json
```

## audit

```sh
yoal audit [--from <when>] [--to <when>] [--action <action>] [--resource <type>] [--limit <n>] [--cursor <cursor>] [--all] [--json]
```

Prints your organisation's audit log, newest first: the time, the actor (user, API key, MCP client or system, with its ID), the action, the resource and the result, with the error message for failed actions. It needs `project:read`. What the audit log records, and where to see it in the dashboard, is described in [dashboards, logs and audit](/observe/dashboards-and-logs).

| Flag | Description |
| --- | --- |
| `--from <when>` | Oldest entry to show. A date (`2026-11-01`), an ISO 8601 timestamp or epoch milliseconds. |
| `--to <when>` | Newest entry to show, in the same formats. A date covers that whole day, in UTC. A `--from` later than `--to` is an error. |
| `--action <action>` | Only this action, for example `project.delete` or `mcp.deploy_site`. Exact match. |
| `--resource <type>` | Only this resource type, for example `project`, `secret` or `log_drain`. Exact match. |
| `-n`, `--limit <n>` | Entries per page, a whole number from 1 to 200. Default 50. Ignored with `--all`. |
| `--cursor <cursor>` | Start after the last entry of a previous page. |
| `--all` | Follow every page, 200 entries at a time, up to 10,000 entries. |
| `--json` | Print `{ "entries": [...], "nextCursor": … }`. |

Without `--all`, when older entries exist the output ends with the exact command for the next page, including your filters and the `--cursor` value. With `--json`, `nextCursor` is `null` on the last page; with `--all` it is only set when the 10,000-entry cap was reached. Each entry has fields such as `id`, `actorType`, `actorId`, `clientId`, `action`, `resource`, `resourceId`, `result`, `error` and `createdAt` (epoch milliseconds). When nothing matches, the text output is `No audit entries match.`

```sh
yoal audit --from 2026-11-01 --to 2026-11-07
yoal audit --action project.delete --limit 20
yoal audit --resource log_drain --all --json
```
