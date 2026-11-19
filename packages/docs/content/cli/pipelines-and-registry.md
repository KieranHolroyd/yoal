---
title: Pipelines and registry
description: Every flag of yoal repo, run, workflow, secret, var, runners and registry, for pipeline repositories, runs and workflows, and container images.
---

These commands drive [Pipelines](/deploying/pipelines) and the container registry from the terminal: connect a git repository, start and follow runs, try or lint a workflow (on Yoal or on your own machine), manage pipeline secrets and variables, clean up stale runner registrations, and push, inspect and deploy images. Global options such as `--profile`, environment variables and the JSON error format are on the [CLI overview](/clients/cli#global-options-and-output).

Arguments in angle brackets are required and arguments in square brackets are optional. `<repo>` is always the name of a pipeline repository as `yoal repo list` shows it, not a git URL. Boolean flags also take a `--no-` form and an explicit value (`--watch=false`).

## repo

Aliases: `repos`, `repository`.

A pipeline repository is a git repository Yoal clones to run the workflows in its `.yoal/workflows/*.yml`. See [Pipelines](/deploying/pipelines) for how runs work and [GitHub](/deploying/github) for connecting repositories through the GitHub App instead of a webhook.

`yoal repo` with no subcommand runs `yoal repo list`. Listing and showing need the `build:read` permission; adding and removing need `build:create`.

### repo list

```sh
yoal repo list [--json]
```

Lists the organisation's repositories with their provider, default branch, whether they are enabled, the last run and the clone URL. Also `ls`. With `--json` it prints `{ "repositories": [...] }`. Put flags after the subcommand: `yoal repo --json` is an error.

```sh
yoal repo list
yoal repo ls --json
```

### repo show

```sh
yoal repo show <name> [--json]
```

Shows one repository: clone URL, provider, default branch, default job image, whether it is enabled, the webhook URL (marked `(no secret set)` when the repository has no webhook secret), the last run and when it was created. Also `get`.

```sh
yoal repo show shop
```

### repo add

```sh
yoal repo add <name> --url <clone-url> [--branch <branch>] [--provider github|generic] [--webhook-secret <secret>] [--image <image>] [--json]
```

Connects a git repository. Also `create`. The name uses lowercase letters, digits, dots, dashes and underscores, starts and ends with a letter or digit, and is at most 100 characters. After connecting, the CLI prints the next steps: for a GitHub repository, the webhook URL to add for the push and pull request events, and the command that dispatches a workflow.

| Flag | Description |
| --- | --- |
| `--url <clone-url>` | Required. An `https://` or `ssh://` (`git@…`) URL the build nodes clone. |
| `--branch <branch>` | Default branch. Defaults to `main`. |
| `--provider github\|generic` | `github` (the default) or `generic`. Any other value is a usage error. |
| `--webhook-secret <secret>` | Secret that signs webhook deliveries. At least 16 characters. |
| `--image <image>` | Default job image when jobs run in containers. Without it the platform default is used. |
| `--json` | Print the created repository as JSON. |

```sh
yoal repo add shop --url https://github.com/my-org/shop.git --webhook-secret "$(openssl rand -hex 24)"
yoal repo add tools --url ssh://git@git.example.com/tools.git --provider generic --branch trunk
```

The CLI only creates `github` and `generic` repositories. For GitLab, Gitea and Forgejo, see [Git providers](/deploying/git-providers).

### repo remove

```sh
yoal repo remove <name> [-y] [--json]
```

Deletes the repository with its runs, logs, artifacts, caches, secrets, variables and environments. Also `rm` and `delete`. It asks `[y/N]` first; any answer other than `y` or `yes` prints `Cancelled.` and changes nothing. When stdin is not a terminal, it refuses and exits `1` unless you pass `--yes`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask. Required when stdin is not a terminal. |
| `--json` | Print the server response as JSON. |

```sh
yoal repo remove old-shop --yes
```

## run

No aliases.

`yoal run` has two forms that share one command name. This section covers the pipeline-run form, `yoal run <subcommand> <repo> …`. The other form, `yoal run <project> -- <command…>`, runs a one-off command against an app and is documented under [run](/cli/compute#run) in the compute reference.

The CLI picks the form from the arguments:

1. No arguments, or exactly one argument that is `--help`, `-h` or `help`, prints the pipeline-run help.
2. If the first argument is a pipeline subcommand (`list`, `ls`, `view`, `show`, `watch`, `logs`, `log`, `cancel` or `rerun`) and there is no `--` anywhere in the command line, it is a pipeline-run command.
3. Anything else is the one-off command form.

So `yoal run shop -- bun run migrate` runs a command in the `shop` app, and an app named `logs` still works as `yoal run logs -- ls`. A mistyped subcommand such as `yoal run lst shop` falls through to the one-off form and fails with a usage error. `yoal run shop --help` shows the one-off help; `yoal run --help` shows this one.

`<run>` is a run number (`42` or `#42`) or a run id. Quote `'#42'` in the shell, because an unquoted `#` starts a comment.

Listing, viewing, watching and reading logs need `build:read`. Cancelling needs `build:cancel` and re-running needs `build:create`. See [Runs, logs and artifacts](/deploying/pipelines#runs-logs-and-artifacts) for retention.

### run list

```sh
yoal run list <repo> [--status <status>] [--workflow <file>] [--ref <ref>] [-n <n>] [--json]
```

Lists runs, newest first, with status, workflow, event, ref, commit, title, start time and duration. Also `ls`.

| Flag | Description |
| --- | --- |
| `--status <status>` | `queued`, `in_progress` or `completed`, or a conclusion: `success`, `failure` (also `failed`), `cancelled`, `skipped` or `timed_out`. Any other value is a usage error. |
| `--workflow <file>` | Only runs of this workflow. A bare file name such as `ci.yml` means `.yoal/workflows/ci.yml`; a value with a `/` is a path from the repository root. |
| `--ref <ref>` | Only runs on this ref. A branch name such as `main` means `refs/heads/main`; give tags in full, as `refs/tags/v1.2.0`. |
| `-n`, `--limit <n>` | At most this many runs, from 1 to 100. Defaults to 20. |
| `--json` | Print `{ "runs": [...] }`. |

A conclusion filter is applied by the CLI to the newest 100 completed runs, so older matches beyond those 100 are not shown.

```sh
yoal run list shop
yoal run list shop --status failure --workflow ci.yml -n 5
yoal run ls shop --ref release --json
```

### run view

```sh
yoal run view <repo> <run> [--json]
```

Shows a run: workflow, status and attempt, the commit and who triggered it, its inputs, whether it ran untrusted, then every job with its steps and durations. The failing step is marked `>>`. A queued job shows the runner labels it is waiting for, and a job in an environment that needs approval shows `(awaiting approval)`. Artifacts are listed with their size, expiry and id, and for a failed run the command that prints the failing job's log comes last. Also `show`. With `--json` it prints `{ "run": … }`.

```sh
yoal run view shop 42
yoal run show shop '#42' --json
```

### run watch

```sh
yoal run watch <repo> <run> [--json]
```

Follows a run until it finishes, polling every two seconds and printing each job and step as it starts and finishes. If the run has already finished, it prints the result and returns. Pressing Ctrl-C stops watching; the run carries on.

The exit code is `0` when the run's conclusion is `success` or `skipped` and `1` for anything else. After a failure it prints the matching `yoal run logs` command on stderr. With `--json` nothing is printed while it waits, and the finished run is printed as `{ "run": … }`.

```sh
yoal run watch shop 42 && echo "green"
```

### run logs

```sh
yoal run logs <repo> <run> [--job <job>] [-f] [--json]
```

Prints one job's log from the start. Also `log`. Each line is prefixed with its step number and name, such as `[2 Run tests]`, or `[setup]` for job setup and teardown. The job's name and status go to stderr first, so stdout holds only the log.

Without `--job` the CLI picks the first job that failed or timed out, then the first cancelled job, and otherwise the last job. `--job` matches a job id, a job key (the id under `jobs:` in the workflow) or the job's display name. Matrix jobs share a key: when several match and exactly one of them failed, that one is used; otherwise the CLI lists the matching job ids and asks you to pass one.

| Flag | Description |
| --- | --- |
| `--job <job>` | The job, by id, key or name. |
| `-f`, `--follow` | Keep printing new lines until the job finishes. Exits `1` if the followed job failed, timed out or was cancelled. |
| `--json` | Print the whole log so far as `{ "job": {...}, "lines": [...], "complete": … }`. `--follow` is ignored. |

```sh
yoal run logs shop 42
yoal run logs shop 42 --job test -f
```

### run cancel

```sh
yoal run cancel <repo> <run> [--json]
```

Cancels a queued or running run. Jobs that are already running stop after their `always()` steps. With `--json` it prints `{ "run": … }`.

```sh
yoal run cancel shop 43
```

### run rerun

```sh
yoal run rerun <repo> <run> [--failed] [-w] [--json]
```

Runs a run again as a new attempt and prints the attempt number.

| Flag | Description |
| --- | --- |
| `--failed` | Re-run only the failed jobs and the jobs that depend on them. |
| `-w`, `--watch` | Follow the new attempt as `yoal run watch` does, with the same exit codes. |
| `--json` | Print `{ "run": … }`. With `--watch`, print the finished run instead. |

```sh
yoal run rerun shop 42 --failed --watch
```

## workflow

Aliases: `workflows`, `wf`.

Starts a workflow on Yoal, runs a workflow file on your own machine, or checks one. `yoal workflow` on its own prints the help. Workflow syntax is described in [Workflow syntax](/deploying/pipelines#workflow-syntax).

### workflow dispatch

```sh
yoal workflow dispatch <repo> <workflow> [--ref <ref>] [-f <key=value>]... [-w] [--json]
```

Starts a committed workflow that has a `workflow_dispatch` trigger. `<workflow>` is a file name such as `ci.yml` (meaning `.yoal/workflows/ci.yml`) or a path from the repository root. A build node clones the repository at the ref and reads the workflow before the run exists, so the command first gets back a trigger, not a run. Needs `build:create`.

Without `--watch`, the trigger id is printed on stdout and a note on stderr; find the run with `yoal run list`. With `--watch`, the CLI waits for a build node to read the workflow and then follows the run like `yoal run watch`, exiting `0` only if it succeeded. If the workflow has no `workflow_dispatch` trigger, does not match the ref or fails to start, it exits `1` with the reason. If several runs start, it watches the first and lists the others.

| Flag | Description |
| --- | --- |
| `--ref <ref>` | Branch, tag or commit to run. Defaults to the repository's default branch. |
| `-f`, `--field <key=value>` | A `workflow_dispatch` input. Repeat for more. Values are sent as strings and converted by the server to the types the workflow declares. |
| `-w`, `--watch` | Wait for the run and follow it until it finishes. |
| `--json` | Without `--watch`, print `{ "trigger": … }`. With `--watch`, print only the finished `{ "run": … }`. |

```sh
yoal workflow dispatch shop ci.yml
yoal workflow dispatch shop deploy.yml --ref main -f environment=staging --watch
```

### workflow run

```sh
yoal workflow run <repo> --file <file.yml> [--ref <ref>] [-f <key=value>]... [-w] [--json]
yoal workflow run --local <file.yml> [-j <job>] [-f <key=value>]... [--secret <NAME[=VALUE]>]... [--var <NAME=VALUE>]... [--matrix <key=value>]... [--event <name>] [--copy] [--json]
```

The first form sends a workflow file from your machine to Yoal and runs it against `--ref` without committing it. The second form, with `--local`, runs the workflow's jobs on this machine without a control plane.

**On Yoal.** The file's contents replace the committed workflow for this one run; other committed workflows it calls with `uses: ./.yoal/workflows/…` are still read from the repository. It starts as a `workflow_dispatch` event, so the file needs a `workflow_dispatch` trigger. An inline workflow runs untrusted (no secrets, environments or deploys) unless an org owner or admin starts it; see [Pull requests from forks and inline workflows](/deploying/pipelines#pull-requests-from-forks-and-inline-workflows). Waiting, watching, exit codes and `--json` behave as for `workflow dispatch`. Needs `build:create`.

| Flag | Description |
| --- | --- |
| `--file <path>` | Required. The workflow file to send. |
| `--ref <ref>` | Branch, tag or commit to check out. Defaults to the repository's default branch. |
| `-f`, `--field <key=value>` | A `workflow_dispatch` input. Repeat for more. |
| `-w`, `--watch` | Wait for the run and follow it. |
| `--json` | As for `workflow dispatch`. |

The local-run flags are accepted in this form but have no effect.

```sh
yoal workflow run shop --file .yoal/workflows/ci.yml --ref my-branch --watch
```

**On this machine.** `--local` runs the workflow with the same step runner as a build node, but every step runs directly on your machine, as your user, in the current directory and with your environment. Nothing contacts a control plane and you don't need to be signed in. It needs the Bun runtime: use the standalone `yoal` binary or run the CLI with Bun, because under Node it stops with an error. No container runtime is needed, and none is used:

- `container:` is ignored and `services:` are not started; start any services yourself.
- Environments have no approvals and no environment secrets; pass what the job needs with `--secret`.
- `yoal/deploy` and `yoal/oidc-token` fail, because they need a control plane.
- A job that calls a reusable workflow (job-level `uses:`) fails; run that workflow file with `--local` instead.

Jobs run one at a time in dependency order, and matrix combinations run one after another. The `yoal` context is filled from your checkout: `sha` is `HEAD` (all zeros outside a git repository), `ref` is the current branch (`refs/heads/local` when detached), and `repository` is `owner/repo` from the `origin` remote, or the directory name.

Artifacts are written to `.yoal/local/runs/<run id>/`, caches to `.yoal/local/caches/` (shared between local runs) and downloaded tools to `.yoal/local/tool-cache/`. Add `.yoal/local/` to your `.gitignore`.

Press Ctrl-C once to cancel the current job and skip the rest, twice to quit at once (exit code `130`). The command exits `0` when every job succeeded or was skipped and `1` otherwise.

| Flag | Description |
| --- | --- |
| `--local <file.yml>` | Run this workflow file locally. |
| `-j`, `--job <id>` | Run only this job, by its id under `jobs:`. Its `needs` count as succeeded, with no outputs. |
| `-f`, `--field <key=value>` | A `workflow_dispatch` input. Repeat for more. Converted to the declared input types when the workflow has a `workflow_dispatch` trigger; otherwise passed as-is with a warning. |
| `--secret <NAME[=VALUE]>` | A secret for `secrets.NAME`. Without `=VALUE` it is read from the environment variable `NAME`, and an unset variable is an error. Repeat for more. |
| `--var <NAME=VALUE>` | A variable for `vars.NAME`. Repeat for more. |
| `--matrix <key=value>` | Run only the matrix combinations where `key` has this value. Repeat to match several keys. |
| `--event <name>` | The value of `yoal.event_name`. Defaults to `workflow_dispatch`. |
| `--copy` | Run in a temporary copy of the current directory, so steps can't change your checkout. The copy is deleted afterwards. |
| `--json` | Print progress on stderr and then `{ "ok": …, "runId": …, "jobs": [...] }` on stdout, with each job's key, name, conclusion and outputs. |

```sh
yoal workflow run --local .yoal/workflows/ci.yml
yoal workflow run --local .yoal/workflows/ci.yml -j test --secret NPM_TOKEN --var REGION=eu
yoal workflow run --local .yoal/workflows/build.yml --matrix arch=arm64 --copy
```

### workflow lint

```sh
yoal workflow lint <file.yml> [--json]
yoal workflow lint --import <github-workflow.yml> [--out <file>] [--json]
```

Checks a workflow file with the same parser the platform uses, without contacting the server. Like local runs, it needs the Bun runtime. On success it prints the workflow's name and jobs; otherwise it prints each problem with its location on stderr and exits `1`. With `--json` it prints `{ "file": …, "ok": …, "issues": [...] }`, plus `name` and `jobs` when the file is valid.

With `--import`, it converts a GitHub Actions workflow to a Yoal one. Hosted `runs-on` labels become Yoal labels (`ubuntu-*` becomes `linux`, and arm runners add `arm64`), `permissions` are dropped, `secrets.GITHUB_TOKEN` and `github.token` become `secrets.GH_TOKEN`, local reusable workflows move to `.yoal/workflows/`, and unsupported triggers are dropped. Every change is listed on stderr, tagged `[changed]`, `[unsupported]` or `[note]`. The converted workflow then goes through the parser, and the command exits `1` if problems are left to fix.

| Flag | Description |
| --- | --- |
| `--import <file>` | The GitHub workflow to convert. |
| `--out <file>` | Write the converted workflow to this file. Without it, the YAML is printed on stdout. |
| `--json` | With `--import`, print `{ "source", "out", "ok", "notes", "issues" }`, plus the converted `workflow` text when there is no `--out`. |

```sh
yoal workflow lint .yoal/workflows/ci.yml
yoal workflow lint --import .github/workflows/ci.yml --out .yoal/workflows/ci.yml
```

## secret

Aliases: `secrets`.

Pipeline secrets are encrypted values that workflows read as `${{ secrets.NAME }}`. Runs from forks never get them. An environment-scoped secret is given only to jobs that name that environment. See [Secrets, variables and environments](/deploying/pipelines#secrets-variables-and-environments). `yoal secret` on its own prints the help.

Names use letters, digits and underscores and don't start with a digit. Names starting with `YOAL_` or `GITHUB_` are reserved. Listing needs `build:read`; setting needs `build:create` and `secret:create`; deleting needs `build:create` and `secret:delete`.

### secret list

```sh
yoal secret list <repo> [--json]
```

Lists secret names, their environment (`(all)` for repository-wide) and when they were last updated. Values are never shown. Also `ls`.

```sh
yoal secret list shop
```

### secret set

```sh
yoal secret set <repo> <NAME> [--env <environment>] [--value <value>] [--json]
```

Creates or replaces a secret, up to 64 KiB. The value comes from `--value`; otherwise from stdin when something is piped in (one trailing newline is removed); otherwise from a hidden prompt.

| Flag | Description |
| --- | --- |
| `--env <environment>` | Scope the secret to jobs in this environment only. |
| `--value <value>` | The value. Prefer stdin, which keeps it out of your shell history. |
| `--json` | Print the stored secret's name, environment and update time. |

```sh
yoal secret set shop NPM_TOKEN
printf %s "$DEPLOY_KEY" | yoal secret set shop DEPLOY_KEY --env production
```

### secret rm

```sh
yoal secret rm <repo> <NAME> [--env <environment>] [--json]
```

Deletes a secret. Also `remove` and `delete`. There is no confirmation prompt. Pass `--env` to delete the copy scoped to that environment; without it, the repository-wide secret is deleted.

| Flag | Description |
| --- | --- |
| `--env <environment>` | Delete the secret scoped to this environment. |
| `--json` | Print the server response as JSON. |

```sh
yoal secret rm shop DEPLOY_KEY --env production
```

## var

Aliases: `vars`.

Pipeline variables are plain configuration that workflows read as `${{ vars.NAME }}`. They are not secret and their values are shown in full; use [secret](#secret) for credentials. `yoal var` on its own prints the help.

Names follow the same rules as secret names. Listing needs `build:read`; setting and deleting need `build:create`.

### var list

```sh
yoal var list <repo> [--json]
```

Lists variables with their values (cut to 60 characters in the table, with newlines shown as `\n`) and update times. Also `ls`. `--json` prints the full values.

```sh
yoal var list shop
```

### var set

```sh
yoal var set <repo> <NAME> [value] [--value <value>] [--json]
```

Creates or replaces a variable, up to 64 KiB. The value is the third argument or `--value` (not both); otherwise it is read from stdin when something is piped in (one trailing newline is removed), or asked for at a visible prompt.

| Flag | Description |
| --- | --- |
| `--value <value>` | The value, instead of the positional argument. |
| `--json` | Print the stored variable as JSON. |

```sh
yoal var set shop REGION eu-west
echo "eu-west-1" | yoal var set shop AWS_REGION
```

### var rm

```sh
yoal var rm <repo> <NAME> [--json]
```

Deletes a variable without asking. Also `remove` and `delete`.

```sh
yoal var rm shop REGION
```

## runners

No aliases.

Housekeeping for [GitHub Actions runners](/deploying/git-builds#github-actions-runners) that Yoal registers with GitHub. `yoal runners` on its own prints the help, and any other subcommand is a usage error.

### runners prune

```sh
yoal runners prune [--older-than <days>] [--apply] [--plan <op_id>] [-y] [--json]
```

Finds and deletes stale runner registrations: ones whose project or workload is gone, whose workload no longer runs a runner pool, or whose replica number is above the current pool size. Registrations newer than the retention window (**Settings → Retention & defaults**) are always kept. It is a shortcut for `yoal prune --only runner_registrations` and accepts the same flags; see [prune](/cli/operations-and-config#prune).

Without `--apply` it is a dry run that prints the plan and the command that applies exactly that plan within an hour. `--apply` without `--plan` scans again and asks before deleting. Off a terminal without `--yes` it refuses, exits `1` and keeps the scan as a dry run you can apply by its id. It exits `0` when everything was deleted, `3` when some deletions failed, and `1` when the run failed or was cancelled. Ctrl-C detaches and the run carries on; pick it up with `yoal operations watch <id>`.

| Flag | Description |
| --- | --- |
| `--older-than <days>` | Override the retention window, from 1 to 3650 days. |
| `--apply` | Delete what the scan found. Asks first unless `--plan` or `--yes` is given. |
| `--plan <op_id>` | Apply an earlier scan instead of scanning again. Can't be combined with `--older-than`. |
| `-y`, `--yes` | Don't ask. Required when stdin is not a terminal. |
| `--json` | Print NDJSON progress events on stdout. |

```sh
yoal runners prune
yoal runners prune --apply --plan op_...
yoal runners prune --older-than 2 --apply --yes
```

## registry

Aliases: `images`.

Works with the platform's own container registry, logins for external registries, and image deploys. The concepts, including deploy on push, OIDC trusts, mirrors and signatures, are explained under [The platform registry](/compute/apps-and-containers#the-platform-registry) and [Private images](/compute/apps-and-containers#private-images).

`yoal registry` with no subcommand, or with only flags, runs `yoal registry status`. An unknown subcommand is a usage error. Registry repositories are named `<org>/<name>`, where `<org>` is your organisation's slug.

Permissions, as enforced by the API: viewing the registry, repositories, tags, scans and trusts needs `image:pull`; `untag` needs `image:delete`; adding, changing and deleting credentials and trusts needs `image:credentials`. Pushing with `docker push` needs `image:push`.

### registry status

```sh
yoal registry status [--host] [--json]
```

Shows the platform registry's host, status, engine and version, the node it runs on, and how many tags it keeps per repository. If a platform admin hasn't turned it on, it says so. Running `yoal registry` with no subcommand does the same.

| Flag | Description |
| --- | --- |
| `--host` | Print only the registry host, for scripts. Takes precedence over `--json`. |
| `--json` | Print the server response as JSON. |

```sh
yoal registry status
docker tag my-api "$(yoal registry status --host)/my-org/my-api:1.0"
```

### registry login

```sh
yoal registry login [--engine docker|podman] [--print]
```

Logs Docker (or Podman) in to the platform registry with the API key the current profile uses (or `YOAL_TOKEN`). It runs `docker login <registry host> -u yoal --password-stdin` and pipes the key to it, so the CLI itself writes nothing. The engine stores the login where it normally does: for Docker, `~/.docker/config.json` or the credential helper configured there; for Podman, its own auth file.

It fails if the registry is turned off, if the profile has no API key, or if the engine can't be run or its login exits with an error.

| Flag | Description |
| --- | --- |
| `--engine docker\|podman` | Which engine to log in. Defaults to `docker`. |
| `--print` | Print the `login` command to run yourself instead of running it. You paste your API key at its prompt. |

```sh
yoal registry login
yoal registry login --engine podman
yoal registry login --print
```

### registry repos

```sh
yoal registry repos [--json]
```

Lists your organisation's registry repositories with the project they belong to, any deploy-on-push link, and the last tag, digest and push time. Also `repositories` and `ls`.

```sh
yoal registry repos
```

### registry tags

```sh
yoal registry tags <org>/<name> [--json]
```

Lists the tags of one repository, one per line.

```sh
yoal registry tags my-org/web
```

### registry untag

```sh
yoal registry untag <org>/<name> <tag> [-y]
```

Deletes a tag. Deployments pinned to its digest keep running, and the registry frees layers nothing uses later. It asks `[y/N]` first and refuses off a terminal without `--yes`. It always prints plain text, even with `--json`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask. Required when stdin is not a terminal. |

```sh
yoal registry untag my-org/web 2026-10-01 --yes
```

### registry prune

```sh
yoal registry prune [--older-than <days>] [--keep-tags <n>] [--apply] [--plan <op_id>] [-y] [--json]
```

Deletes old registry tags by retention. It is a shortcut for `yoal prune --only registry_images`, with the same dry-run, confirmation and exit-code behaviour as [runners prune](#runners-prune); see [prune](/cli/operations-and-config#prune).

| Flag | Description |
| --- | --- |
| `--older-than <days>` | Override the retention window, from 1 to 3650 days. |
| `--keep-tags <n>` | Keep at least this many newest tags per repository, from 0 to 1000. |
| `--apply` | Delete what the scan found. Asks first unless `--plan` or `--yes` is given. |
| `--plan <op_id>` | Apply an earlier scan. Can't be combined with `--older-than` or `--keep-tags`. |
| `-y`, `--yes` | Don't ask. Required when stdin is not a terminal. |
| `--json` | Print NDJSON progress events on stdout. |

```sh
yoal registry prune --keep-tags 10
yoal registry prune --apply --plan op_...
```

### registry autodeploy

```sh
yoal registry autodeploy <org>/<name> <project> [-t <tag>] [--json]
yoal registry autodeploy <org>/<name> --off [--json]
```

Deploys every push of one tag to a container project, pinned to the pushed digest. Also `auto-deploy`. `--off` stops deploying on push. The project must be a container project. Needs `image:push` on the repository and `deployment:create` on the project (on the organisation with `--off`).

| Flag | Description |
| --- | --- |
| `-t`, `--tag <tag>` | The tag whose pushes deploy. Defaults to `latest`. |
| `--off` | Stop deploying on push; no project is needed. |
| `--json` | Print the updated repository as JSON. |

```sh
yoal registry autodeploy my-org/web web
yoal registry autodeploy my-org/web web --tag stable
yoal registry autodeploy my-org/web --off
```

### registry scan

```sh
yoal registry scan <org>/<name>[:<tag>|@<digest>] [--json]
```

Shows an image's vulnerabilities from the registry's scan: a count by severity and a table of CVEs. Without a tag or digest it scans `latest`. A platform admin must have turned CVE scanning on; otherwise the command fails with that message. An image that hasn't been scanned yet says so.

```sh
yoal registry scan my-org/web:1.4.0
yoal registry scan my-org/web@sha256:3f1c… --json
```

### registry trust

```sh
yoal registry trust [list] [--json]
yoal registry trust add <github-owner>/<repo> <org>/<name|*> [--ref <glob>] [--pull-only] [--json]
yoal registry trust rm <id> [-y]
```

Lets a GitHub repository's workflows push to (or pull from) a registry repository with their OIDC token, so no secret is stored. Also `trusts`. In the workflow, set `permissions: id-token: write`, request a token for the registry host as the audience, and log in with the username `github-oidc` and the token as the password; `docker/login-action` works.

- `list` (or `ls`, or no action) shows each trust's id, GitHub repository, ref, registry repository and whether it can push or only pull. Put flags after the action: `yoal registry trust list --json`, not `yoal registry trust --json`.
- `add` creates a trust. `<org>/*` covers every repository in your namespace. It needs `image:credentials`, and also `image:push` unless you pass `--pull-only`.
- `rm` (also `remove`, `delete`) deletes a trust by id after asking `[y/N]`, and refuses off a terminal without `--yes`.

| Flag | Description |
| --- | --- |
| `--ref <glob>` | `add`: only tokens for this ref, such as `refs/heads/main` or `refs/tags/*`. Without it, any ref matches. |
| `--pull-only` | `add`: allow pulls only. |
| `-y`, `--yes` | `rm`: don't ask. Required when stdin is not a terminal. |
| `--json` | `list` and `add`: print the server response as JSON. |

```sh
yoal registry trust add my-gh-org/web my-org/web --ref refs/heads/main
yoal registry trust list
yoal registry trust rm rot_... --yes
```

### registry credentials

```sh
yoal registry credentials [list] [--json]
yoal registry credentials add <name> <registry> -u <username> [--password-stdin] [--json]
yoal registry credentials update <name> [--registry <host>] [-u <username>] [--password-stdin] [--json]
yoal registry credentials rm <name> [-y] [--json]
```

Logins for external registries such as GHCR or Docker Hub, which nodes use to pull private images. Also `credential` and `creds`. There is one credential per registry host per organisation; use `docker.io` for Docker Hub. Listing needs `image:pull`; the other actions need `image:credentials`.

- `list` (or `ls`, or no action) shows each credential's name, registry, username, when it was last used and when it was updated.
- `add` (also `create`) stores a login. `-u` is required. The password or access token is read from stdin with `--password-stdin`, or asked for at a hidden prompt. Nodes use it from the next deploy or pull retry.
- `update` (also `set`) changes the host, username or password. It asks for a new password when you pass `--password-stdin`, or when you pass neither `--registry` nor `-u`.
- `rm` (also `remove`, `delete`) deletes a credential after asking `[y/N]`, and refuses off a terminal without `--yes`. Running containers keep their image, but new pulls from that registry stop working.

| Flag | Description |
| --- | --- |
| `-u`, `--username <user>` | Registry username. For GHCR, your GitHub user or organisation; for Docker Hub, your account. |
| `--password-stdin` | Read the password or token from the first line of stdin. |
| `--registry <host>` | `update`: move the credential to another registry host. |
| `-y`, `--yes` | `rm`: don't ask. Required when stdin is not a terminal. |
| `--json` | Print the server response as JSON. `rm` prints `{ "deleted": true }`. |

```sh
echo "$GHCR_TOKEN" | yoal registry credentials add ghcr ghcr.io -u my-org --password-stdin
echo "$NEW_TOKEN" | yoal registry credentials update ghcr --password-stdin
yoal registry credentials rm ghcr --yes
```

### registry deploy

```sh
yoal registry deploy <project> <image> [--no-promote] [-m <message>] [-e <environment>] [--json]
```

Points a container project at an image and deploys it, keeping the rest of its workload settings. The tag is resolved to a digest, so the deployment, and any later rollback to it, always runs the same image. It prints the deployment id, whether it is pinned to a digest, and the URL. The project must be a container project, and you need `deployment:create` on it. See [Create a container](/compute/apps-and-containers#create-a-container).

| Flag | Description |
| --- | --- |
| `--no-promote` | Create a preview only and leave production where it is. Production moves by default. |
| `-m`, `--message <text>` | Deployment message. |
| `-e`, `--environment <slug>` | Deploy to this named environment. |
| `--json` | Print the deployment and workload as JSON. |

```sh
yoal registry deploy cairn ghcr.io/my-org/cairn:2026-11-07
yoal registry deploy web registry.example.com/my-org/web:1.4.0 --no-promote -m "try 1.4"
```
