# Yoal — Cloud shell

Status: **built** (D236). Behind `YOAL_FEATURE_CLOUD_SHELL`, on by default.

A cloud shell is a person's own terminal in the dashboard. It runs in a small container on one of
the install's compute nodes, has the `yoal` CLI preinstalled and signed in as that person, and keeps
a 1 GiB home disk between sessions. It is the answer to "I want to run a CLI command against this
install, from anywhere, without installing anything".

It is not a shell on the host. D43 still holds: the helper never runs a command the request picks
on the node itself. A cloud shell is a tenant container like an app's, with the same sandbox.

## 1. Model

| Piece | Where |
|---|---|
| One row per person and org | `cloud_shells` (migrations 0137, 0138): node, status, disk size, the last start failure, the CLI key (id + sealed value), generation, started/last-active times |
| Service | `CloudShellService` (`packages/core/src/cloud-shells.ts`, `core.cloudShells`) |
| Contracts | `packages/contracts/src/cloud-shell.ts`: limits, `workloadCloudShellSchema`, views |
| Node side | helper `applyCloudShell` (`apps/helper/src/systemd.ts`), `apps/helper/src/cloud-shell.ts` (disk, mount unit, path escaping), `renderCloudShellUnit` (`apps/helper/src/units.ts`) |
| Image | `docker/cloud-shell/`, published by `publish.yml` (before the release itself) as `ghcr.io/<owner>/yoal-cloud-shell:<version>` |
| Dashboard | The **Cloud shell** header button and bottom drawer (`(dashboard)/_lib/CloudShellDrawer.svelte`, store `lib/cloud-shell/cloud-shell.svelte.ts`); details page `/cloud-shell` |

Statuses: `stopped` → `starting` (in desired state, container not reported yet) → `running` (the
node reported the container running) → `stopped`. A reset sets `deleting` until the node reports the
disk gone, then the row is removed. At most one non-`deleting` row exists per person and org.

### Limits

| | Value |
|---|---|
| Home disk | 1 GiB ext4 (`cloudShellLimits.diskMb`) |
| Memory / CPU | 512 MiB / 1 CPU, in `yoal-workloads.slice` |
| `/tmp` | 256 MiB tmpfs, counted against memory |
| Idle stop | 20 minutes without typing or opening a shell |
| Session limit | 12 hours, then it is stopped whatever happens |
| CLI key | expires after 12 h 15 min, revoked as soon as the shell stops |

## 2. Lifecycle

**Start** (`POST /api/v1/cloud-shell/start`, or opening the page). The first start picks an online
compute node that advertises `cloud-shell`, preferring the one with fewest shells; that node keeps
the disk from then on, because the shell can only run where its files are. Each start bumps the
generation, mints a new CLI key (below) and puts the shell in the node's desired state as a
container workload with the `cloudShell` profile, `ingress: 'none'`, and the image above.

**Failed start.** A shell whose container the node reports failed, or restarting
`cloudShellLimits.startRestartLimit` (5) times while starting, is stopped at once; one still not
running `startTimeoutMs` (10 minutes) after a start is stopped by the sweep. Either way the key is
revoked, the stop is audited as an error with reason `start failed`, and the row keeps a `message`
(0138) that the page and the assistant show, naming the image and the unit to read on the node. The
page does not auto-start a shell whose last start failed; the next start clears the message. The
usual cause is an image the node cannot pull.

**Stop** (button, idle sweep, session limit, or the feature flag turned off). The maintenance loop
(every 60 s) stops idle and over-long shells. Stopping revokes the CLI key and takes the workload out
of desired state; the agent removes the unit and the helper unmounts the disk. The disk image stays
on the node.

**Reset** ("Reset disk"). Stops the shell and marks it `deleting`; desired state lists the id in
`cloudShellPurges`; the agent asks the helper to purge it and reports `purgedCloudShells`; the row
goes. The next start makes a new shell with an empty disk, possibly on another node.

If the node holding the disk is offline, start is refused with the node's name; the person can wait
or reset (losing the files). If the node is deleted from the install, the next start makes a new
shell elsewhere.

## 3. The home disk

The helper keeps each shell's disk as a sparse image file at
`<stateDir>/<csh_id>/home.ext4` (`/var/lib/yoal-workloads/…` by default), formatted ext4 with no
root reservation (`mkfs.ext4 -m 0`). A systemd `.mount` unit loop-mounts it at
`<stateDir>/<csh_id>/home` with `nosuid,nodev,noatime`; the container bind-mounts that at
`/home/yoal` with `:Z,U`.

A filesystem of its own makes 1 GiB a real limit: a full disk fails the person's writes, never the
node's. App volumes, by contrast, are a reservation (docs/VOLUMES.md).

Fail-closed, as D76 asks of every disk:

- the container unit has `RequiresMountsFor=` the mountpoint, so after a reboot systemd mounts the
  disk before the shell starts, or does not start it;
- apply starts the mount unit itself and refuses to start the container if the mountpoint is not a
  mount of its own afterwards;
- an existing image that is not a regular file (a symlink, say) is refused, never mounted;
- a new image is formatted under a temporary name and renamed only once `mkfs` succeeded;
- purge refuses while the disk is still mounted, so it never deletes through a mount.

The mount unit's name is the systemd-escaped mountpoint (`systemdEscapePath`, matching
`systemd-escape --path`). Nodes need `mkfs.ext4` (e2fsprogs) and loop device support; the path is
`/usr/sbin/mkfs.ext4` unless the helper is told otherwise.

## 4. The container

`renderCloudShellUnit` gives it the app sandbox: its own user namespace (`UserNS=auto`), no
capabilities, `NoNewPrivileges`, a read-only root, a `/tmp` tmpfs, the org's network while
`ORG_NETWORKS` is on, no published port and no other mount. The image's entrypoint (tini plus a
small init script) seeds a fresh disk with the usual dotfiles and then waits; people reach the
container only through the console's `podman exec`.

The image (`docker/cloud-shell/Dockerfile`): Debian bookworm-slim, the `yoal` CLI built from the
same commit, Node 22, Bun, git, ssh, curl, jq, `psql`, `redis-cli`, an editor and the usual small
tools. `npm`, `pip --user` and `bun install -g` are pointed at `$HOME`, the one place that survives a
stop. Override the image with `YOAL_CLOUD_SHELL_IMAGE` (for a development build, or a mirror).

## 5. The CLI is signed in

The shell's environment comes from its activation, fetched by its node like any workload's and never
put in desired state:

| Variable | Value |
|---|---|
| `YOAL_URL` | the platform origin |
| `YOAL_CONTENT_DOMAIN` | the content domain |
| `YOAL_TOKEN` | a fresh access key, when the person's role may create access keys |
| `YOAL_CLOUD_SHELL` | `1` |

The key is an ordinary user access key in the person's org, named "Cloud shell", minted with
`AccessKeyService.create` as the person (so it is audited as theirs and can never hold more than
their role), sealed with the org key in the row so a re-fetched activation can hand it over again,
and revoked by `system:cloud-shell` the moment the shell stops. A role without `accessKey:create`
(deployer, by default) still gets a shell, but the CLI starts signed out; the greeting says so.
The shell never hands out a credential the person could not have minted themselves.

## 6. Reaching it

The terminal reuses the container console's path (D127) end to end: browser → control plane
(`/cloud-shell/console/*`) → the internal gateway on `n-<node>.console.internal` → the agent's console
front → the helper's `/v1/containers/<id>/…` verbs. The console token carries `k: 'cs'` and names the
shell; its activation checks with `CloudShellService.verifyConsoleTarget` that the shell is still the
person's and still runs on that node. The helper's console verbs accept `csh_…` ids next to `wld_…`.

A node running a shell gets the console front and its gateway route even while
`YOAL_FEATURE_CONTAINER_CONSOLE` is off.

Every console call through the control plane counts as activity (written at most every 30 s), which
is what the idle timer measures: typing, opening a shell and resizing do; output alone does not.

## 7. Who may use it

`cloudShell:use` (risk `secret`, step-up `window`, token-denied, never MCP), held by owner, admin and
deployer; not by viewers, and never a default agent scope. Start, reset and the terminal also need a
signed-in person (a session credential): an API key or MCP client never opens a shell (D29, D127).
The dashboard assistant acts as that person's session and may run a command in their shell, but
only one the person confirms on a card showing the whole command (D237).
The CLI does not open a cloud shell either; it already runs where the person is.

Audit: `cloud_shell.start`, `cloud_shell.stop` (with the reason: stopped, idle, session limit,
disabled, reset, start failed), `cloud_shell.reset`, `cloud_shell.exec.open|exec.close|files.read|files.download`,
and the key's own `access_key.create` and `access_key.revoke`. Keystrokes and output are never
recorded.

## 8. Surfaces

| Surface | What |
|---|---|
| Dashboard | A **Cloud shell** button at the top right of every page (Ctrl+`) opens a resizable bottom drawer with the terminal, status and Start, Stop, New session and Reset disk. The drawer lives in the dashboard layout, so the session survives navigation; hiding it keeps the shell running. Opening it starts a stopped shell, but restoring it after a reload, or after a failed start, never does. `/cloud-shell` shows the node, disk and limits and opens the drawer |
| REST | `GET /api/v1/cloud-shell`; `POST /api/v1/cloud-shell/start|stop|reset` (session) |
| Console | `/cloud-shell/console/exec…`, `files…` (session; same shapes as the container console) |
| Assistant | `run_in_cloud_shell` (D237, [ASSISTANT.md](./ASSISTANT.md#cloud-shell-commands)): one command per Confirm click, run as the person in their own shell |
| MCP | none: MCP clients never get a shell |

## 9. Rollout

The control plane must be on this release first (it accepts heartbeats with up to
`HEARTBEAT_CAPABILITIES_MAX` = 64 capabilities; a fully featured node now exceeds the old 32). Nodes
advertise `cloud-shell` once they run it, and only those nodes are picked. The release workflow
(`publish.yml`, jobs `cloud-shell-image` and `cloud-shell-image-manifest`) pushes the image before
it publishes the release, so the tag a control plane asks for exists. It does not run from
`release.yml`: that workflow only runs on a tag push, and the tag `publish.yml` creates with
`GITHUB_TOKEN` starts no other workflow. 0.16.12 shipped without its image for that reason.

Not built: choosing the node or disk size per person, a larger disk for some roles, snapshots of
the home disk, moving a disk to another node, and opening the shell from the CLI.
