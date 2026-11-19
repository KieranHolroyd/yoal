---
title: Apps, containers and functions
description: Reference for the yoal commands that configure, scale, inspect and test running apps, containers, functions, jobs and volumes.
---

These commands work on a project that is already running something: a process app, a container, a function or a worker. They set the runtime spec, change the number of copies, open a shell or read files in a container, run cron jobs and one-off commands, send test requests to a function and manage persistent volumes. For deploying code, see [deploying](/cli/deploying). Global options such as `--profile`, the environment variables the CLI reads and the general exit codes are on the [CLI overview](/clients/cli).

Arguments in angle brackets are required; arguments in square brackets are optional. String flags accept `--flag value` or `--flag=value`, and boolean flags also accept a `--no-` form. Commands that ask for confirmation refuse to run without a terminal (in a pipe or CI) unless you pass `--yes`, and exit `1`.

## workload

Aliases: `workloads`

Reads and edits a project's runtime spec: the command or image, port, memory, CPU, health check, idle stop, ingress, copies, data directory, environment variables and secret references. It is what **Projects → my-app → Runtime** edits in the dashboard. See [workload settings](/compute/apps-and-containers#workload-settings).

```sh
yoal workload <command> [options]
```

With a flag but no command, such as `yoal workload -p shop`, it runs `show`. A first argument that isn't a command is an error, so `yoal workload shop` fails; use `yoal workload show shop`.

### workload show

```sh
yoal workload show <project> [--json]
```

Prints the project's runtime, the saved spec and the state of the running workload. Also available as `get`. The project can be given as the first argument or with `-p, --project`; if both are given they must match.

| Flag | Description |
| --- | --- |
| `-p, --project <slug>` | The project, instead of the positional argument. |
| `--json` | Print `{ "project": …, "workload": … }`, the raw project and workload responses. |

Needs `deployment:read` on the project.

```sh
yoal workload show shop
yoal workload show shop --json
```

### workload set

```sh
yoal workload set <project> [options]
```

Saves runtime settings. Only the flags you pass change: the CLI reads the saved spec, merges your changes into it and saves the result, and the server validates it. Also available as `update`. A static project is refused because it has no workload, and so is a function project, whose runtime comes from the `yoal-function.json` in its bundle. On a container project `--command` is dropped, and on a process project `--image` is dropped. If the project has never run, the settings apply at the next deployment.

| Flag | Description |
| --- | --- |
| `-p, --project <slug>` | The project, instead of the positional argument. |
| `--command <cmd>` | Process command. It is split on whitespace with no shell quoting, so `--command "bun server.ts --port 8080"` becomes four arguments. Cannot be empty. |
| `--engine <bun\|node>` | Process engine. `bun` is the default; `node` places the app only on nodes with the pinned Node.js. |
| `--image <ref>` | Container image, for container projects. |
| `--port <n>` | Port the app listens on, 1–65535. Default `3000`. |
| `--memory <size>` | Memory reservation per copy: a number of megabytes, or with a unit such as `512M` or `1G`. Must come to a whole number of megabytes; the server accepts 32 MB to 8 GB. Default `256M`. |
| `--cpus <n>` | CPU quota per copy, such as `1` or `0.5`. Must be positive; the server allows up to 8. Default `1`. |
| `--health-path <path>` | Path the node checks before it reports the app ready. Must start with `/`. Default `/`. |
| `--socket-activation`, `--no-socket-activation` | Pass the listen socket to a process app. On by default. |
| `--idle-stop <seconds>` | Stop the app after this many seconds without a request, 0–86400. `0` means always on. Needs a socket-activated process app with HTTP ingress and one copy. |
| `--ingress <http\|none>` | `http` serves traffic; `none` makes a worker with no port or route. |
| `--replicas <n>` | Number of copies, 1–20. To change copies at once without touching anything else, use [`yoal scale`](#scale). |
| `--data <size\|none>` | Persistent `/data` directory with this quota, such as `512M`; the server accepts 32 MB to 64 GB. `none`, `off` or `0` removes it. |
| `--env KEY=value` | Set a plain environment variable. Repeatable. The first `=` separates name and value, so a value can contain `=`. Merges with the saved variables. |
| `--unset-env KEY` | Remove a plain variable. Repeatable. |
| `--secret NAME[=version][:env\|:file]` | Add or replace a reference to an existing secret. Repeatable. Without a version, the latest version is used at activation. `:file` delivers it as a file instead of an environment variable. |
| `--clear-secrets` | Remove every secret reference. Applied after `--secret`. |
| `--json` | Print `{ "sent": …, "saved": … }`: the spec the CLI sent and the server's response. |

`--secret` only references secrets. Create the secret and its value first; see [environment variables and secrets](/compute/apps-and-containers#environment-variables-and-secrets). Needs `project:update`.

```sh
yoal workload set shop --engine node --port 8080 --memory 512M --idle-stop 300
yoal workload set api --image ghcr.io/acme/api:1.4 --memory 1G --cpus 0.5
yoal workload set shop --env NODE_ENV=production --unset-env DEBUG --secret STRIPE_KEY=2
```

### workload reset

```sh
yoal workload reset <project> [--yes] [--json]
```

Stops the workload and clears the saved spec. Releases are kept, but the app stays down until it is configured and deployed again. Also available as `remove`. It asks for confirmation first.

| Flag | Description |
| --- | --- |
| `-p, --project <slug>` | The project, instead of the positional argument. |
| `-y, --yes` | Don't ask. Required without a terminal. |
| `--json` | Print the raw response. |

Needs `project:update`.

```sh
yoal workload reset shop --yes
```

### workload capacity

```sh
yoal workload capacity [--json]
```

Shows each node's workload budget and how much of it is reserved. Also available as `cap`. Needs platform admin access. See [placement and capacity](/compute/apps-and-containers#placement-and-capacity).

| Flag | Description |
| --- | --- |
| `--json` | Print the raw response. |

```sh
yoal workload capacity
```

## container

Aliases: `ctr`

The [container console](/compute/apps-and-containers#container-console) for container projects: inspect the running container, list and read its files, download a file, restart it or open a shell.

```sh
yoal container <command> <project> [options]
```

With no command, `yoal container <project>` runs `inspect`. With no arguments at all it prints help.

All subcommands share one set of flags; each uses the ones that apply to it.

| Flag | Description |
| --- | --- |
| `-r, --replica <n>` | Which copy of a multi-copy workload to use, as an index (`0`, `1`, …). Default: the first. |
| `--shell <shell>` | For `shell`: `auto` (the default; bash if the image has it, else sh), `/bin/bash`, `/bin/sh` or `/bin/ash`. |
| `--root` | For `shell`: run as root inside the container. Capabilities stay dropped. |
| `-y, --yes` | For `restart`: don't ask. Required without a terminal. |
| `--json` | For `inspect` and `ls`: print the raw response. |

Secret files and `tmpfs` mounts such as `/tmp` are never shown. Opening a shell and reading or downloading a file are recorded in the audit log; keystrokes and file contents are not.

| Subcommand | Permission |
| --- | --- |
| `inspect` | `container:inspect` |
| `ls`, `cat`, `cp` | `container:files` |
| `shell` | `container:exec` |
| `restart` | `project:update` |

`yoal login` mints a key that holds the console permissions your role has. See [console permissions](/compute/apps-and-containers#console-permissions).

### container inspect

```sh
yoal container [inspect] <project> [-r <n>] [--json]
```

Prints the container's state, image, node, restarts and last exit, memory, CPU, network and disk counters, command, environment variable names, ports, mounts and processes. With several copies and no `--replica`, it shows the first and says how many there are.

```sh
yoal container my-api
yoal ctr inspect my-api --replica 1
```

### container ls

```sh
yoal container ls <project> [path] [-r <n>] [--json]
```

Lists a directory inside the running container. The path defaults to `/`. The header line says whether the path is on the image's filesystem or a mount, and whether it is read-only.

```sh
yoal container ls my-api /data
```

### container cat

```sh
yoal container cat <project> <path> [-r <n>]
```

Writes a file's bytes to stdout unchanged, so binary files can be redirected to a file.

```sh
yoal container cat my-api /etc/os-release
yoal container cat my-api /data/app.db > app.db
```

### container cp

```sh
yoal container cp <project>:<path> [dest] [-r <n>]
```

Downloads one file. The source is the project slug, a colon and an absolute path. `dest` defaults to the file's name in the current directory; if `dest` is an existing directory, the file is saved inside it. A line saying where it was saved goes to stderr.

```sh
yoal container cp my-api:/data/app.db
yoal container cp my-api:/var/log/app.log ./logs/
```

### container restart

```sh
yoal container restart <project> [--yes]
```

Restarts every copy from the same image and configuration. Open shells close and requests fail for a few seconds. It asks first; answering no leaves it running.

```sh
yoal container restart my-api --yes
```

### container shell

```sh
yoal container shell <project> [--shell <shell>] [--root] [-r <n>]
```

The same as [`yoal shell`](#shell).

## shell

Opens an interactive shell inside a container project. It is a shortcut for `yoal container shell`.

```sh
yoal shell <project> [--shell auto|/bin/bash|/bin/sh|/bin/ash] [--root] [-r, --replica <n>]
```

The terminal size follows yours and Ctrl-C goes to the remote shell. Leave with `exit` or Ctrl-D. If the connection drops, the CLI reconnects up to five times and resumes the output where it left off. `yoal` exits with the shell's own exit code, or `1` if the session was lost. An exit code of `126` or `127` usually means the image has no such shell; distroless images have none.

| Flag | Description |
| --- | --- |
| `--shell <shell>` | `auto` (default: bash if present, else sh), `/bin/bash`, `/bin/sh` or `/bin/ash`. |
| `--root` | Run as root inside the container. Capabilities stay dropped. |
| `-r, --replica <n>` | Which copy to open the shell in. Default: the first. |

Needs `container:exec`. See [shell](/compute/apps-and-containers#shell).

```sh
yoal shell my-api
yoal shell my-api --shell /bin/sh --replica 2
```

## scale

Runs more or fewer copies of an app, or lets Yoal decide. A change takes effect at once, with no deploy, and running copies are not restarted. See [scaling](/compute/scaling).

```sh
yoal scale <project> [copies] [options]
```

With no options, `yoal scale <project>` shows the copies, the node each runs on, their memory and CPU use and the autoscaling policy. With no arguments it prints help. If you combine options, the first of these that applies wins: `--resume`, `--off`, `--auto`, then a number of copies.

| Flag | Description |
| --- | --- |
| `--auto` | Turn autoscaling on, or change its settings. Settings you leave out keep their saved values. |
| `--min <n>` | With `--auto`: fewest copies. Default `1`. |
| `--max <n>` | With `--auto`: most copies. Default `3`, and at most the install's limit (20 unless an operator lowered it). |
| `--cpu <percent>` | With `--auto`: keep average CPU near this share of each copy's limit, 10–95. This is the default signal, with a target of `70`. |
| `--memory <percent>` | With `--auto`: use memory instead, 10–95. |
| `--rps <n>` | With `--auto`: use requests per second per copy instead. Needs request telemetry. |
| `--scale-down <minutes>` | With `--auto`: how long the load must stay low before a copy is removed, 1–120. Default `5`. |
| `--off` | Turn autoscaling off. The app keeps the copies it has. |
| `--resume` | Carry on with a paused rollout. |
| `--json` | Print the raw response. |

Give at most one of `--cpu`, `--memory` and `--rps`. Switching signal without a number uses that signal's usual target: 70 for CPU and memory, 50 for requests per second. Every number must be positive.

`copies` is a whole number from 1 up to the install's limit (20 unless an operator lowered it). The output lists the copies that start or stop and their nodes; if the app already runs that many, it says so.

Showing scaling needs `deployment:read`. Setting copies or the autoscaling policy needs `project:update`, and `--resume` needs `deployment:create`.

```sh
yoal scale shop 3
yoal scale shop --auto --min 2 --max 6 --cpu 60
yoal scale shop --off
```

## jobs

Aliases: `job`

Cron jobs and commands you run by hand on a process or container app. Each run uses the app's current release, environment, secrets and volumes, on the app's node. See [app jobs](/compute/scheduled-jobs#app-jobs).

```sh
yoal jobs <command> [options]
```

`yoal jobs <project>`, with nothing else, lists the project's jobs. `yoal jobs`, `yoal jobs help` and `yoal jobs --help` print help.

The command a job runs goes after `--`. It is an argument list passed exactly as your shell split it, never a shell string, so use `-- sh -c '…'` when you need pipes or variable expansion. A command has at most 64 arguments.

Every subcommand accepts `--json` to print the raw response, and `-h, --help`.

### jobs list

```sh
yoal jobs list <project> [--json]
```

Lists the project's jobs with their schedule, next run, last run and command. Also available as `ls`. Needs `project:read`.

```sh
yoal jobs list shop
```

### jobs show

```sh
yoal jobs show <project> <job> [--json]
```

Shows one job's command, schedule, next run, timeout, concurrency policy, retries and last run. Also available as `get`. Needs `project:read`.

```sh
yoal jobs show shop tidy
```

### jobs create

```sh
yoal jobs create <project> <job> [options] -- <command…>
```

Defines a job. Without `--schedule`, the job runs only when you run it by hand. Also available as `add`. Job names are lowercase letters, digits and single hyphens, up to 40 characters; `runs` is reserved. A project can have up to 50 jobs.

| Flag | Description |
| --- | --- |
| `-s, --schedule '<cron>'` | Five-field cron expression in UTC, such as `'*/15 * * * *'` or `'0 3 * * 1-5'`. Quote it so the shell passes it as one argument. See [cron syntax](/compute/scheduled-jobs#cron-syntax). |
| `-t, --timeout <duration>` | Stop a run after this long: seconds (`90`) or with a unit (`90s`, `15m`, `2h`). 10 seconds to 24 hours. Default `10m`. |
| `--concurrency <policy>` | What happens when a run is due while the last one is still going: `forbid` (default; records the new run as skipped), `allow` (runs both) or `replace` (cancels the old one). |
| `--retries <n>` | Retry a failed or timed-out run up to this many times, 0–10, with backoff. Default `0`. |
| `--paused` | Create the job paused. |

Needs `project:update` and `deployment:create`.

```sh
yoal jobs create shop tidy --schedule '0 3 * * *' -- bun scripts/tidy.ts --days 30
yoal jobs create shop reindex --timeout 2h -- bun scripts/reindex.ts
yoal jobs create api report -s '0 8 * * 1' --retries 2 -- sh -c 'bun report.ts | tee /data/last.txt'
```

### jobs update

```sh
yoal jobs update <project> <job> [options] [-- <command…>]
```

Changes a job. Only what you pass changes; a command after `--` replaces the old one. Also available as `edit`. You must change at least one thing.

| Flag | Description |
| --- | --- |
| `-s, --schedule '<cron>'` | New schedule. |
| `--no-schedule` | Remove the schedule. The job stays and can still be run by hand. Can't be combined with `--schedule`. |
| `-t, --timeout <duration>` | New timeout. |
| `--concurrency <policy>` | `forbid`, `allow` or `replace`. |
| `--retries <n>` | 0–10. |
| `--paused` | Pause the job. Use [`jobs resume`](#jobs-pause-and-resume) to start the schedule again. |

Needs `project:update` and `deployment:create`.

```sh
yoal jobs update shop tidy --timeout 30m --retries 2
yoal jobs update shop tidy --no-schedule
yoal jobs update shop tidy -- bun scripts/tidy.ts --days 7
```

### jobs run

```sh
yoal jobs run <project> <job> [--detach] [--json]
```

Runs a job now, whatever its schedule, and streams its output: the command's stdout to stdout and its stderr to stderr. A summary line follows on stderr. The CLI exits with the command's status; see [exit codes](#exit-codes-for-runs).

| Flag | Description |
| --- | --- |
| `-d, --detach` | Print the run id and return straight away. Follow it with `yoal jobs logs <project> <run id> -f`. |
| `--json` | Wait for the run to finish without streaming, then print `{ "run": … }`. With `--detach`, print the queued run instead. |

Needs `deployment:create`.

```sh
yoal jobs run shop tidy
yoal jobs run shop tidy --detach
```

### jobs runs

```sh
yoal jobs runs <project> [job] [--one-off] [-n <limit>] [--json]
```

Run history, newest first: run id, job, trigger, status, start time and duration. With a job name, only that job's runs. Also available as `history`. Needs `project:read`.

| Flag | Description |
| --- | --- |
| `--one-off` | Only one-off runs started with [`yoal run`](#run). |
| `-n, --limit <n>` | How many runs to show, 1–200. Default `20`. |

```sh
yoal jobs runs shop tidy
yoal jobs runs shop --one-off -n 50
```

### jobs logs

```sh
yoal jobs logs <project> <run id> [-f] [--json]
```

Prints a run's output, up to 2,000 lines. Run ids start with `jr_`; find them with `jobs runs`.

| Flag | Description |
| --- | --- |
| `-f, --follow` | Keep printing until the run finishes, then print the summary line and exit with the run's status, as `jobs run` does. |
| `--json` | Print the first page of log events as JSON. Ignores `--follow`. |

Needs `project:read` and `logs:read`.

```sh
yoal jobs logs shop jr_8f2k1c
yoal jobs logs shop jr_8f2k1c -f
```

### jobs cancel

```sh
yoal jobs cancel <project> <run id> [--json]
```

Cancels a queued run, or stops a running one: the node sends `SIGTERM`, then `SIGKILL` after 30 seconds. If the run has already finished, it says so. Needs `deployment:create`.

```sh
yoal jobs cancel shop jr_8f2k1c
```

### jobs pause and resume

```sh
yoal jobs pause <project> <job> [--json]
yoal jobs resume <project> <job> [--json]
```

`pause` stops the schedule; the job keeps its history and can still be run by hand. `resume` starts the schedule again and prints the next run time. Needs `project:update`.

```sh
yoal jobs pause shop tidy
yoal jobs resume shop tidy
```

### jobs delete

```sh
yoal jobs delete <project> <job> [--yes] [--json]
```

Deletes a job and its run history. Also available as `rm`. It asks first; answering no cancels and exits `0`.

| Flag | Description |
| --- | --- |
| `-y, --yes` | Don't ask. Required without a terminal. |

Needs `project:update` and `deployment:create`.

```sh
yoal jobs delete shop tidy --yes
```

### Exit codes for runs

`yoal run`, `yoal jobs run` and `yoal jobs logs -f` exit with the run's outcome:

| Code | Meaning |
| --- | --- |
| `0` | The command succeeded. |
| `1`–`255` | The command failed with this exit status. |
| `124` | The run timed out. |
| `130` | The run was cancelled. |
| `1` | The run failed without an exit status of its own, for example because the node didn't pick it up. |

With `--detach`, the CLI exits `0` once the run is queued.

## run

Runs one command once against an app's current release, in the app's sandbox with its environment, secrets and volumes, and streams its output. The command is not saved as a job. See [run a one-off command](/compute/scheduled-jobs#run-a-one-off-command).

```sh
yoal run <project> [options] -- <command…>
```

`yoal run` also manages pipeline runs, which are documented under [`run` on the pipelines page](/cli/pipelines-and-registry#run). The CLI tells the two apart like this:

- `yoal run` alone, or followed only by `--help`, `-h` or `help`, prints the pipeline help.
- If the first argument is a pipeline subcommand (`list`, `ls`, `view`, `show`, `watch`, `logs`, `log`, `cancel` or `rerun`) and there is no `--` anywhere in the arguments, it is a pipeline command.
- Anything else is a one-off command, with the first argument as the project.

So a one-off run always has `--` before its command, and `yoal run <project> --help` shows the one-off help.

The command after `--` is an argument list, never a shell string. Output streams as the node sends it: stdout to stdout and stderr to stderr, followed by a summary line on stderr. The CLI exits with the command's own status, `124` for a timeout and `130` when cancelled; see [exit codes for runs](#exit-codes-for-runs). Pressing Ctrl-C stops following but leaves the run going. Find past one-off runs with `yoal jobs runs <project> --one-off`.

| Flag | Description |
| --- | --- |
| `-t, --timeout <duration>` | Stop it after this long: seconds (`90`) or with a unit (`90s`, `15m`, `2h`). 10 seconds to 24 hours. Default `10m`. |
| `-d, --detach` | Print the run id and return straight away. Follow it with `yoal jobs logs <project> <run id> -f`. |
| `--json` | Wait for the run to finish without streaming, then print `{ "run": … }`. With `--detach`, print the queued run instead. |

Needs `deployment:create`.

```sh
yoal run shop -- bun run migrate
yoal run shop --timeout 1h -- bun scripts/backfill.ts --since 2026-01-01
yoal run api -- sh -c 'echo $DATABASE_URL | cut -d@ -f2'
```

## function

Aliases: `functions`, `fn`

Test tools for function projects: send one request to the function, or run its `scheduled()` handler now. Both run on the function's node and go straight to its host, bypassing domains, the proxy and access rules. An idle-stopped function starts for the request, shown as a cold start. See [functions](/compute/functions).

```sh
yoal function <command> [options]
```

`yoal function`, `yoal function help` and `yoal function --help` print help. Both subcommands need `deployment:create` on the project, the same as deploying it.

### function invoke

```sh
yoal function invoke <project> [path] [options]
```

Sends one HTTP request to the function. Also available as `call` and `request`. The path defaults to `/`; `users` and `/users` mean the same, and a full URL is refused. The response body goes to stdout and a summary line (status, time, cold start and size) to stderr. On a terminal, a binary body isn't printed; redirect stdout to a file or use `--json`. A body longer than 256 KiB is cut, and the summary says so.

| Flag | Description |
| --- | --- |
| `-X, --method <method>` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS`, in any case. Default `GET`, or `POST` when a body is given. `GET` and `HEAD` can't have a body. |
| `-H, --header 'Name: value'` | Request header. Repeatable; repeated names are joined with `, `. |
| `-d, --data <body>` | Request body. |
| `--data-file <path>` | Request body from a file; `-` reads stdin. Can't be combined with `--data`. |
| `-i, --include` | Print the status line and response headers before the body, as `curl -i` does. |
| `--json` | Print the task with its raw result. |

Exits `1` when the function answers with a status outside 2xx, with or without `--json`.

```sh
yoal function invoke api /health
yoal fn invoke api /users -X POST -H 'content-type: application/json' -d '{"name":"Ada"}'
yoal fn invoke api /upload --data-file ./payload.json -i
```

### function cron

```sh
yoal function cron <project> '<cron>' [--json]
```

Runs the function's `scheduled()` handler now for one of its cron triggers. Also available as `scheduled`. The expression must match one of the crons the function declares; quote it so the shell passes it as one argument. Prints the status and duration. See [run a schedule now](/compute/scheduled-jobs#run-a-schedule-now).

| Flag | Description |
| --- | --- |
| `--json` | Print the task with its raw result. |

Exits `1`, with the error on stderr, when the handler throws or returns status 400 or more.

```sh
yoal fn cron api '*/5 * * * *'
```

## volume

Aliases: `volumes`

Persistent volumes mounted into a process or container project's workload, and their snapshots. Mount paths are paths inside the app's sandbox, never host paths. See [volumes](/compute/volumes).

```sh
yoal volume <command> --project <slug> [options]
```

Every subcommand except `prune` needs `-p, --project <slug>`, the project that owns the volume. With a flag but no command, such as `yoal volume -p api`, it runs `list`. Every subcommand accepts `--json` to print the raw response, and `-h, --help`.

Listing and showing volumes and snapshots needs `project:read`; everything that changes a volume or snapshot needs `project:update`.

There is no resize command; see [resize a volume](/compute/volumes#resize-a-volume).

### volume list

```sh
yoal volume list --project <slug> [--json]
```

Lists the project's volumes. Also available as `ls`. A warning goes to stderr for each volume that is 90% full or more.

```sh
yoal volume list --project api
```

### volume show

```sh
yoal volume show <name> --project <slug> [--json]
```

Shows one volume's usage, attachments and recent snapshots. Also available as `get`.

```sh
yoal volume show app-data --project api
```

### volume create

```sh
yoal volume create <name> --project <slug> [options]
```

Creates a volume with a size quota. The quota is reserved on the node's disk.

| Flag | Description |
| --- | --- |
| `--size <size>` | Quota: megabytes, or with a unit such as `512M` or `2G`. Default `1G`. |
| `--disk <where>` | `system`, `fast`, `bulk` or a disk name. Default: the app volumes default in **Settings → Storage**. |
| `--single-writer`, `--no-single-writer` | Refuse a second read-write attachment. On by default. |

```sh
yoal volume create app-data --project api --size 2G
yoal volume create cache --project api --size 512M --disk fast
```

### volume attach

```sh
yoal volume attach <name> --project <slug> --mount <path> [options]
```

Mounts the volume into a workload. The workload restarts with the mount.

| Flag | Description |
| --- | --- |
| `-m, --mount <path>` | Required. Absolute path inside the sandbox, such as `/var/lib/app`. System paths such as `/etc`, `/usr`, `/tmp` and `/data` itself are refused. |
| `--workload <id\|slug>` | Workload id or project slug. Default: the project's own workload. |
| `--env <name>` | Environment label for the attachment. Default `production`. |
| `--read-only` | Mount read-only. |

```sh
yoal volume attach app-data --project api --mount /var/lib/app
yoal volume attach app-data --project api --mount /srv/app/shared --read-only --env staging
```

### volume detach

```sh
yoal volume detach <name> --project <slug> [options]
```

Unmounts the volume. The workload restarts without the mount; the volume and its data are untouched.

| Flag | Description |
| --- | --- |
| `--workload <id\|slug>` | Workload id or project slug. Default: the project's own workload. |
| `--env <name>` | Environment label of the attachment. Default `production`. |

```sh
yoal volume detach app-data --project api
```

### volume delete

```sh
yoal volume delete <name> --project <slug> [--yes]
```

Soft-deletes a volume. Also available as `rm`. It is refused while the volume is attached, and the error lists the `detach` commands to run. The data stays on the disk for 7 days, and the output gives the date it is purged; the volume can no longer be mounted. It asks first; answering no changes nothing and exits `1`.

| Flag | Description |
| --- | --- |
| `-y, --yes` | Don't ask. Required without a terminal. |

```sh
yoal volume delete app-data --project api --yes
```

### volume snapshot

```sh
yoal volume snapshot <name> --project <slug> [options]
```

Queues a snapshot of the volume to a backup target. The volume's node picks it up within a few seconds. By default the app writing to the volume is paused while it is copied, so the copy is consistent.

| Flag | Description |
| --- | --- |
| `--label <text>` | A note to find the snapshot by later, up to 120 characters. |
| `--target <name>` | Backup target. Default: the organisation's, then the platform's. |
| `--pin` | Pin the snapshot so retention never removes it. |
| `--no-quiesce` | Copy without pausing the writer. The copy may be inconsistent. |

```sh
yoal volume snapshot app-data --project api --label "before v2 migration"
yoal volume snapshot app-data --project api --pin --target offsite
```

### volume snapshots

```sh
yoal volume snapshots <name> --project <slug> [--json]
```

Lists the volume's snapshots. If one failed, the latest failure is shown in detail. Snapshot ids start with `avs_`.

```sh
yoal volume snapshots app-data --project api
```

### volume restore

```sh
yoal volume restore <name> <snapshot-id> --project <slug> --to <new-name> [--size <size>]
```

Restores a snapshot into a new volume in the same project. A restore never overwrites the source. The new volume can be attached once its node has finished filling it.

| Flag | Description |
| --- | --- |
| `--to <name>` | Required. Name of the new volume. |
| `--size <size>` | Quota of the new volume. Defaults to the source's, and can't be smaller. |

```sh
yoal volume restore app-data avs_123 --project api --to app-data-restored
```

### volume snapshot-delete

```sh
yoal volume snapshot-delete <name> <snapshot-id> --project <slug> [--yes]
```

Deletes a snapshot and its archive. This can't be undone. It asks first; answering no changes nothing and exits `1`.

| Flag | Description |
| --- | --- |
| `-y, --yes` | Don't ask. Required without a terminal. |

```sh
yoal volume snapshot-delete app-data avs_123 --project api --yes
```

### volume prune

```sh
yoal volume prune [--apply] [--older-than <days>] [--yes] [--json]
```

Finds unpinned snapshots older than the retention window, and snapshots of volumes that no longer exist, across your organisation. Snapshots that a restored volume came from are kept. Without `--apply` it is a dry run that prints what it found and the command that applies exactly that plan. It is `yoal prune --only volume_snapshots`, so it takes the same flags and exit codes as `yoal prune`, described on [operations and configuration](/cli/operations-and-config).

| Flag | Description |
| --- | --- |
| `--apply` | Delete what the scan found. Asks first unless `--yes` or `--plan` is given. |
| `--plan <op_id>` | Apply an earlier scan instead of scanning again. Plans expire after an hour. |
| `--older-than <days>` | Override the retention window. |
| `-y, --yes` | Don't ask. Required without a terminal. |
| `--json` | NDJSON progress events on stdout. |

```sh
yoal volume prune
yoal volume prune --older-than 30 --apply --yes
```
