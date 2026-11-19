---
title: Storage, brokers, events and email
description: Reference for yoal storage, broker, events, email and log-drain, with every subcommand, flag, prompt and injected variable.
---

This page covers the `yoal` commands for managed data services: S3-compatible object storage, NATS brokers and their queues, platform event rules, email, and log drains. Every command also accepts `--json` and `-h, --help`, so the flag tables below leave them out. For global options, environment variables and the general exit codes, see [the CLI overview](/clients/cli).

Arguments in angle brackets are required and arguments in square brackets are optional. A repeatable flag can be given more than once. Boolean flags also take an explicit value (`--public=false`) and, where this page says so, a `--no-` form. Commands that delete or replace something ask first. When stdin is not a terminal there is no one to ask, so the command fails with the error code `confirmation_required` and exit code `1` unless you pass `-y, --yes`. Declining a prompt exits `1` and changes nothing, except where a command says otherwise.

## storage

Aliases: `s3`

Manages S3-compatible object storage instances. Each instance runs RustFS on one node and holds buckets. Projects you attach get a scoped key. See [object storage](/data/object-storage) for the concepts.

```sh
yoal storage <command> [options]
```

`yoal storage` with no subcommand runs `storage list`.

| Permission | Needed for |
| --- | --- |
| `storage:read` | Listing and showing instances, buckets, keys, metrics, logs; listing and downloading objects. |
| `storage:create` | Creating an instance. |
| `storage:update` | Changing, restarting and moving instances; buckets; named keys (create and revoke); uploading and deleting objects; attaching, re-granting and detaching (with `project:update` on the project). |
| `storage:delete` | Deleting, restoring and purging an instance; `buckets delete --force`. |
| `storage:credentials` | `credentials`, `keys reveal` and `rotate-root`. Every read is audited, and credentials are never returned over MCP. |

### storage list

```sh
yoal storage list [--all]
```

Lists storage instances with their status, node and usage. Also available as `storage ls`.

| Flag | Description |
| --- | --- |
| `-a`, `--all` | Include instances in the trash. |

```sh
yoal storage list --all
```

### storage create

```sh
yoal storage create <name> [options]
```

Creates a storage instance. With `--project`, the project is attached right away with read-write access to every bucket created by the same command, so `--project` needs at least one `--bucket`.

| Flag | Description |
| --- | --- |
| `-b`, `--bucket <name>` | Create a private bucket. Repeatable, or comma-separated. |
| `-p`, `--project <slug>` | Attach to this project. Requires `--bucket`. |
| `--prefix <PREFIX>` | Env prefix for that attachment, in UPPER_SNAKE_CASE. Default `S3`; use `AWS` for the names AWS SDKs read. Requires `--project`. |
| `--public` | Serve the S3 API publicly at `https://<name>--s3.<content domain>`. |
| `--placement <where>` | `auto` (default), `edge`, or a node ID. |
| `--memory <size>` | Memory limit in MB, or with a unit: `512M`, `1G`. Default `512M`. |
| `--cpus <n>` | CPU limit, for example `1` or `0.5`. Default `1`. |
| `--storage <size>` | Storage budget for alerts and the usage gauge, in MB or with a unit. Default `10G`. |
| `--disk <where>` | `system`, `fast`, `bulk` or a disk name. Default: the setting in **Settings → Storage**. |
| `--version <version>` | RustFS version. The server checks it. |

```sh
yoal storage create media --bucket uploads --project api --prefix AWS
yoal storage create assets --bucket images,videos --public --storage 50G
```

### storage info

```sh
yoal storage info <name>
```

Shows the status, node, endpoints, usage, buckets and attached projects. It also finds instances in the trash and says how to restore or purge them. Also available as `storage show`.

```sh
yoal storage info media
```

### storage update

```sh
yoal storage update <name> [options]
```

Changes an instance's limits, version or public access. Pass at least one flag. Also available as `storage set`.

| Flag | Description |
| --- | --- |
| `--memory <size>` | Memory limit, for example `1G`. |
| `--cpus <n>` | CPU limit. |
| `--storage <size>` | Storage budget. |
| `--version <version>` | RustFS version. |
| `--public`, `--no-public` | Turn the public S3 endpoint on or off. |

```sh
yoal storage update media --memory 1G --public
```

### storage restart

```sh
yoal storage restart <name>
yoal storage restart --all
```

Restarts the RustFS container. Buckets, objects and keys are kept; S3 requests fail briefly.

| Flag | Description |
| --- | --- |
| `--all` | Restart every storage instance in the organisation instead of one. Instances that can't be restarted are listed with the reason. |

```sh
yoal storage restart media
```

### storage logs

```sh
yoal storage logs <name> [options]
```

Prints the RustFS container's log lines, as `HH:MM:SS LEVEL message`.

| Flag | Description |
| --- | --- |
| `-f`, `--follow` | Keep polling every 2 seconds and print new lines. `--json` is ignored while following. |
| `--limit <n>` | Lines per request, 1 to 2,000. Default 500, or 200 while following. |
| `--level <level>` | `debug`, `info`, `warn` or `error`. |
| `--q <text>` | Only lines that match this text. |
| `--after <cursor>` | Start after this cursor, from an earlier `--json` response. |

```sh
yoal storage logs media --follow --level warn
```

### storage delete

```sh
yoal storage delete <name> [--yes]
```

Moves an instance to the trash. Its container stops at once, the data stays on its node, and you can restore it for 7 days. An attached instance is refused before the prompt: detach every project first. Asks `[y/N]`. Also available as `storage rm`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal storage delete media
```

### storage restore

```sh
yoal storage restore <name>
```

Brings an instance back from the trash. Attachments are not restored; attach projects again with `storage attach`.

```sh
yoal storage restore media
```

### storage purge

```sh
yoal storage purge <name> [--yes]
```

Permanently deletes an instance in the trash and every object in it. You must type the instance's name to confirm. An instance that isn't in the trash is refused.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal storage purge media
```

### storage credentials

```sh
yoal storage credentials <name> [--prefix <PREFIX>]
```

Prints the instance's root key as env lines, alone on stdout so you can `eval` them or redirect them to a file: `<PREFIX>_ENDPOINT_URL`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION` and `_FORCE_PATH_STYLE=true`. With `--json`, it prints the full response. Also available as `storage creds`. Needs `storage:credentials`, and each read is audited.

| Flag | Description |
| --- | --- |
| `--prefix <PREFIX>` | Variable prefix. Default `AWS`, which the AWS CLI and SDKs read. |

```sh
set -a; eval "$(yoal storage credentials media)"; set +a
aws s3 ls --endpoint-url "$AWS_ENDPOINT_URL"
```

### storage rotate-root

```sh
yoal storage rotate-root <name> [--yes]
yoal storage rotate-root <name> --cancel
```

Replaces the root key. RustFS restarts with the new key and the node confirms it, usually within a minute; then the old key stops working. If the node can't confirm it, the previous key comes back within 10 minutes. Attached apps and named keys are not affected. Asks `[y/N]`. Needs `storage:credentials`.

| Flag | Description |
| --- | --- |
| `--cancel` | Abandon a rotation that is still waiting for the node. Doesn't ask. |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal storage rotate-root media --yes
```

### storage keys list

```sh
yoal storage keys [list] <storage>
```

Lists named keys with their grants, status and expiry. Named keys are for people and outside services; apps on Yoal get their own key with `storage attach`. `yoal storage keys <storage>` lists too. Also available as `storage key`, and `list` as `ls`.

```sh
yoal storage keys media
```

### storage keys create

```sh
yoal storage keys create <storage> <name> --bucket <grant> [options]
```

Creates a named key scoped to buckets. The secret is not printed; use `keys reveal`. The node adds the key within a minute.

| Flag | Description |
| --- | --- |
| `-b`, `--bucket <bucket>[:read\|:read-write]` | Grant a bucket. Required. Repeatable or comma-separated. Read-write by default; `ro` and `rw` also work. |
| `--purpose <text>` | What the key is for. |
| `--expires <time>` | An ISO time, or a duration from now: `90m`, `12h`, `30d` or `2w`. Must be in the future. |

```sh
yoal storage keys create media backup-tool --bucket uploads:read --expires 90d --purpose "Nightly offsite copy"
```

### storage keys reveal

```sh
yoal storage keys reveal <storage> <key-id> [--prefix <PREFIX>]
```

Prints a key as env lines: `<PREFIX>_ENDPOINT_URL`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION` and `_FORCE_PATH_STYLE`. The endpoint is the public URL, or the node-local endpoint for a private instance. Needs `storage:credentials`, and each read is audited.

| Flag | Description |
| --- | --- |
| `--prefix <PREFIX>` | Variable prefix. Default `AWS`. |

```sh
yoal storage keys reveal media stk_123 > .env
```

### storage keys revoke

```sh
yoal storage keys revoke <storage> <key-id> [--yes]
```

Revokes a named key. Anything still signing with it is refused once the node removes it, within a minute. Asks `[y/N]`. Also available as `keys rm`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal storage keys revoke media stk_123 --yes
```

### storage move

```sh
yoal storage move <name> --node <node-id> [options]
```

Moves an instance to another node, empty. Buckets, keys and attachments come back on the new node; objects are not copied, and the old node's objects are deleted once the new instance is up. Attached apps move with it. Copy what you need first. You must type the instance's name to confirm.

| Flag | Description |
| --- | --- |
| `--node <node-id>` | Target node. Required. |
| `--disk <where>` | `system`, `fast`, `bulk` or a disk name on the target node. `--volume` is an older name for this flag. |
| `-y`, `--yes` | Move without asking. |

```sh
yoal storage move media --node node_b --disk bulk
```

### storage metrics

```sh
yoal storage metrics <name> [options]
```

Prints usage samples: time, up, used space, objects, buckets and memory. The agent reports once a minute while the instance runs.

| Flag | Description |
| --- | --- |
| `--since <duration>` | Samples from this long ago: `30m`, `6h`, `7d`. Can't be combined with `--from`. |
| `--from <time>` | Start time. |
| `--to <time>` | End time, as an ISO timestamp or epoch milliseconds. Default now. |
| `--interval <interval>` | `1m` or `1h`. |

```sh
yoal storage metrics media --since 24h --interval 1h
```

### storage buckets list

```sh
yoal storage buckets [list] <storage>
```

Lists buckets with their access, state, size and object count. `yoal storage buckets <storage>` lists too. Also available as `storage bucket`, and `list` as `ls`.

```sh
yoal storage buckets media
```

### storage buckets create

```sh
yoal storage buckets create <storage> <bucket> [options]
```

Creates a bucket. The node creates it within a minute.

| Flag | Description |
| --- | --- |
| `--access <access>` | `private` (default), or `public-read`: anyone can GET its objects without signing, but can't list them. |
| `--versioning <on\|off>` | Turn object versioning on, or leave it off. |
| `--quota <size>` | Hard quota in MB or with a unit, for example `500M` or `1G`. `none`, `unlimited` or `0` means no quota. |
| `--lifecycle <json\|@file>` | Lifecycle rules as a JSON array, inline or from a file. |
| `--cors <json\|@file>` | CORS rules as a JSON array, inline or from a file. |
| `--object-lock <mode>:<days>` | `governance:<days>` or `compliance:<days>`, 1 to 36,500 days. Turns versioning on, so it can't be combined with `--versioning off`. It can't be changed later. |

A lifecycle rule has an `id`, an optional `prefix` and `enabled` (default `true`), and at least one of `expireDays`, `noncurrentExpireDays` or `abortIncompleteDays`. A CORS rule has `origin` and `method` arrays, and optional `header`, `expose` and `maxAge`.

Versioning, quotas, lifecycle, CORS and object lock need the `OBJECT_BROWSER` feature, which is on by default (see [configuration](/self-hosting/configuration)).

```sh
yoal storage buckets create media avatars --access public-read
yoal storage buckets create media audit-logs --object-lock compliance:365
yoal storage buckets create media tmp --lifecycle '[{"id":"expire","expireDays":7}]'
```

### storage buckets config

```sh
yoal storage buckets config <storage> <bucket>
```

Shows a bucket's access, versioning, quota, object lock, lifecycle and CORS rules, configuration version and convergence status: `pending`, `converged`, `error` or `unsupported`.

```sh
yoal storage buckets config media uploads
```

### storage buckets update

```sh
yoal storage buckets update <storage> <bucket> [options]
```

Changes a bucket's access or configuration. Pass at least one flag. The node applies the change within a minute. Also available as `buckets set`.

| Flag | Description |
| --- | --- |
| `--access <access>` | `private` or `public-read`. |
| `--versioning <on\|off>` | Turn versioning on or suspend it. |
| `--quota <size\|none>` | Set or remove the hard quota. |
| `--lifecycle <json\|@file>` | Lifecycle rules as a JSON array. |
| `--cors <json\|@file>` | CORS rules as a JSON array. |

`--object-lock` is refused: object lock is set only when you create a bucket.

```sh
yoal storage buckets update media uploads --versioning on --quota 20G
yoal storage buckets update media uploads --cors @cors.json
```

### storage buckets delete

```sh
yoal storage buckets delete <storage> <bucket> [--force] [--yes]
```

Deletes an empty bucket. Asks `[y/N]`. With `--force`, the node empties the bucket first; you must type the bucket's name to confirm, and it needs `storage:delete`. Also available as `buckets rm`.

| Flag | Description |
| --- | --- |
| `--force` | Delete every object in the bucket too. Cannot be undone. |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal storage buckets delete media tmp --force
```

### storage objects ls

```sh
yoal storage objects ls <storage> --bucket <bucket> [options]
```

Lists objects and folders, with size, last modified time and ETag. When the listing is cut short, it prints the `--token` to continue. Also available as `objects list`. The `objects` group is also available as `object`.

`yoal storage objects` with no subcommand prints help rather than listing.

| Flag | Description |
| --- | --- |
| `-b`, `--bucket <bucket>` | Bucket. Required. |
| `--prefix <prefix>` | List under this prefix, for example `photos/`. |
| `--token <token>` | Continue a truncated listing. |
| `--limit <n>` | Page size, 1 to 1,000. Default 100. |

```sh
yoal storage objects ls media -b uploads --prefix photos/
```

### storage objects get

```sh
yoal storage objects get <storage> --bucket <bucket> --key <key> [--output <path>]
```

Downloads one object to stdout, or to a file. Also available as `objects download`.

| Flag | Description |
| --- | --- |
| `-b`, `--bucket <bucket>` | Bucket. Required. |
| `-k`, `--key <key>` | Object key. Required. |
| `-o`, `--output <path>` | Write to this file instead of stdout. |

```sh
yoal storage objects get media -b uploads -k photos/a.jpg -o a.jpg
```

### storage objects put

```sh
yoal storage objects put <storage> --bucket <bucket> --key <key> --file <path>
```

Uploads one local file. Also available as `objects upload`.

| Flag | Description |
| --- | --- |
| `-b`, `--bucket <bucket>` | Bucket. Required. |
| `-k`, `--key <key>` | Object key. Required. |
| `-f`, `--file <path>` | Local file. Required. |
| `--content-type <type>` | Content type. Default: from the file name, else `application/octet-stream`. |

```sh
yoal storage objects put media -b uploads -k photos/a.jpg -f ./a.jpg
```

### storage objects rm

```sh
yoal storage objects rm <storage> --bucket <bucket> --key <key> [--yes]
yoal storage objects rm <storage> --bucket <bucket> --prefix <prefix> [--yes]
```

Deletes one object, or every object under a prefix. A prefix delete lists the objects first and refuses more than 10,000 in one run. Asks before deleting; declining prints `Cancelled.` and exits `0`. When both flags are given, `--key` wins. Also available as `objects delete`.

| Flag | Description |
| --- | --- |
| `-b`, `--bucket <bucket>` | Bucket. Required. |
| `-k`, `--key <key>` | Delete this object. |
| `--prefix <prefix>` | Delete every object under this prefix. |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal storage objects rm media -b uploads --prefix photos/ --yes
```

### storage objects mkdir

```sh
yoal storage objects mkdir <storage> --bucket <bucket> --key <prefix>
```

Creates a folder marker: a zero-byte object whose key ends in `/`. Also available as `objects folder`.

| Flag | Description |
| --- | --- |
| `-b`, `--bucket <bucket>` | Bucket. Required. |
| `-k`, `--key <prefix>` | Folder prefix. Required. |

```sh
yoal storage objects mkdir media -b uploads -k invoices/2026/
```

### storage objects presign

```sh
yoal storage objects presign <storage> --bucket <bucket> --key <key> [--put] [--expires <duration>]
```

Prints a presigned S3 URL. Only public instances have one; for a private instance, use `objects share`. A PUT URL needs `storage:update`. Also available as `objects link`.

| Flag | Description |
| --- | --- |
| `-b`, `--bucket <bucket>` | Bucket. Required. |
| `-k`, `--key <key>` | Object key. Required. |
| `--put` | Presign an upload instead of a download. |
| `--expires <duration>` | Lifetime: `30m`, `6h`, `7d`. Default `1h`, at least 1 minute, at most 7 days. |

```sh
yoal storage objects presign media -b uploads -k photos/a.jpg --expires 6h
```

### storage objects share

```sh
yoal storage objects share <storage> --bucket <bucket> --key <key> [options]
```

Prints a signed share link. On a public instance without a download limit the link is a direct S3 URL. Otherwise it goes through the platform gateway, so it works for private instances too, and no key is exposed. On a terminal, it also prints when the link expires. Needs the `OBJECT_BROWSER` feature.

| Flag | Description |
| --- | --- |
| `-b`, `--bucket <bucket>` | Bucket. Required. |
| `-k`, `--key <key>` | Object key. Required. |
| `--expires <duration>` | Lifetime. Default `7d`, at least 1 minute, at most 7 days. |
| `--downloads <n>` | Stop working after this many downloads. Not allowed with `--put`. |
| `--put` | Share an upload link instead. Needs `storage:update`. |

```sh
yoal storage objects share media -b uploads -k reports/q3.pdf --expires 2d --downloads 3
```

### storage attach

```sh
yoal storage attach <name> --project <slug> [--bucket <grant>] [--prefix <PREFIX>]
```

Gives a project its own key scoped to the buckets you grant. A running app restarts on its own and receives these variables at activation:

| Variable | Value |
| --- | --- |
| `<PREFIX>_ENDPOINT_URL` | S3 endpoint for the app's node. |
| `<PREFIX>_ACCESS_KEY_ID`, `<PREFIX>_SECRET_ACCESS_KEY` | The project's key. |
| `<PREFIX>_REGION` | Region name to sign with. |
| `<PREFIX>_FORCE_PATH_STYLE` | `true`. Use path-style addressing. |
| `<PREFIX>_BUCKET` | Only when exactly one bucket is granted. |
| `<PREFIX>_PUBLIC_ENDPOINT_URL` | Only when the instance is public. |

A private instance serves apps on its own node only. Needs `storage:update` and `project:update`.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Project. Required. |
| `-b`, `--bucket <bucket>[:read\|:read-write]` | Grant a bucket. Repeatable or comma-separated; read-write by default. Without it, the project gets read-write on the instance's only ready bucket, and the command fails if there are none or several. |
| `--prefix <PREFIX>` | Variable prefix. Default `S3`. |

```sh
yoal storage attach media --project worker --bucket uploads:read
yoal storage attach media -p api -b uploads -b avatars:read --prefix AWS
```

### storage grants

```sh
yoal storage grants <name> --project <slug> --bucket <grant>
```

Replaces an attachment's bucket grants. The key's policy changes in place, and the variables are refreshed at the next activation. Also available as `storage grant`.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Project. Required. |
| `-b`, `--bucket <bucket>[:read\|:read-write]` | The new grants. Required. Repeatable or comma-separated. |

```sh
yoal storage grants media --project worker --bucket uploads:read-write,avatars:read
```

### storage detach

```sh
yoal storage detach <name> --project <slug>
```

Revokes the project's key. The app restarts without its storage variables; objects are untouched.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Project. Required. |

```sh
yoal storage detach media --project worker
```

## broker

Aliases: `brokers`, `queue`

Manages NATS brokers with JetStream, and the queues on them. A function queue named `jobs` is stored in the JetStream stream `YOAL_Q_jobs`. See [brokers and events](/data/brokers-and-events).

```sh
yoal broker <command> [options]
```

`yoal broker` with no subcommand runs `broker list`.

| Permission | Needed for |
| --- | --- |
| `broker:read` | Listing and showing brokers, logs, metrics and `queues`. |
| `broker:create` | Creating a broker. |
| `broker:update` | `update`, `restart`, attaching and detaching (with `project:update`), `queue-create`, `send`, `peek` and `redrive`. |
| `broker:delete` | Deleting, restoring and purging a broker; `queue-purge`, `queue-rm` and `message-rm`. |
| `broker:credentials` | `credentials`. Every read is audited, and credentials are never returned over MCP. |

### broker list

```sh
yoal broker list [--all]
```

Lists brokers. Also available as `broker ls`.

| Flag | Description |
| --- | --- |
| `-a`, `--all` | Include brokers in the trash. |

```sh
yoal broker list
```

### broker create

```sh
yoal broker create <name> [options]
```

Creates a broker. With `--project`, it is placed on the project's node and attached right away.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Attach to this project. |
| `--prefix <PREFIX>` | Env prefix for that attachment, in UPPER_SNAKE_CASE. Default `NATS`. Requires `--project`. |
| `--engine <engine>` | `nats`, the default and only engine. |
| `--version <version>` | Engine version: `2.12` or `2.11`. |
| `--placement <where>` | `auto` (default), `edge`, or a node ID. |
| `--memory <size>` | Memory limit, for example `256M` or `1G`. Default `256M`. |
| `--cpus <n>` | CPU limit. Default `0.5`. |
| `--storage <size>` | Cap on the persistent message store. Default `2G`. |
| `--disk <where>` | `system`, `fast`, `bulk` or a disk name. Default: the setting in **Settings → Storage**. `--volume` is an older name for this flag. |

```sh
yoal broker create jobs --project api
yoal broker create events --memory 512M --storage 10G --disk fast
```

### broker info

```sh
yoal broker info <name>
```

Shows the status, node, limits, internal hosts and attached projects. It also finds brokers in the trash. Also available as `broker show`.

```sh
yoal broker info jobs
```

### broker update

```sh
yoal broker update <name> [options]
```

Resizes a broker or moves it to a newer version. Pass at least one flag. The broker restarts with the new settings.

| Flag | Description |
| --- | --- |
| `--memory <size>` | Memory limit. |
| `--cpus <n>` | CPU limit. |
| `--storage <size>` | Message store cap. |
| `--version <version>` | Engine version. |

```sh
yoal broker update jobs --memory 512M --storage 5G
```

### broker attach

```sh
yoal broker attach <name> --project <slug> [--prefix <PREFIX>]
```

Connects a broker to a project. A running app restarts on its own and receives `<PREFIX>_URL`, `<PREFIX>_HOST`, `<PREFIX>_PORT`, `<PREFIX>_USER` and `<PREFIX>_PASSWORD` at activation. The app must run on the broker's node; `auto` placement handles that.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Project. Required. |
| `--prefix <PREFIX>` | Variable prefix. Default `NATS`. |

```sh
yoal broker attach jobs --project worker
```

### broker detach

```sh
yoal broker detach <name> --project <slug>
```

Disconnects a broker from a project. The app restarts without its broker variables; streams are untouched.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Project. Required. |

```sh
yoal broker detach jobs --project worker
```

### broker restart

```sh
yoal broker restart <name>
```

Restarts the broker container. Streams are kept.

```sh
yoal broker restart jobs
```

### broker delete

```sh
yoal broker delete <name> [--yes]
```

Moves a broker to the trash. Its container stops at once, its streams stay on the node, and you can restore it for 7 days. An attached broker is refused before the prompt: detach every project first. Asks `[y/N]`. Also available as `broker rm`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal broker delete jobs
```

### broker restore

```sh
yoal broker restore <name>
```

Brings a broker back from the trash. Attach projects again with `broker attach`.

```sh
yoal broker restore jobs
```

### broker purge

```sh
yoal broker purge <name> [--yes]
```

Permanently deletes a broker in the trash and its streams. You must type the broker's name to confirm. A broker that isn't in the trash is refused.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal broker purge jobs --yes
```

### broker logs

```sh
yoal broker logs <name> [options]
```

Prints the broker container's log lines.

| Flag | Description |
| --- | --- |
| `-f`, `--follow` | Keep polling every 2 seconds and print new lines. `--json` is ignored while following. |
| `--limit <n>` | Lines per request, 1 to 2,000. Default 500, or 200 while following. |
| `--level <level>` | `debug`, `info`, `warn` or `error`. |
| `--q <text>` | Only lines that match this text. |
| `--after <cursor>` | Start after this cursor, from an earlier `--json` response. |

```sh
yoal broker logs jobs -f
```

### broker metrics

```sh
yoal broker metrics <name> [options]
```

Summarises the message store, backlog, connections and message rates. Samples are kept only when the platform's telemetry store is installed; `broker queues` works without it.

| Flag | Description |
| --- | --- |
| `--since <duration>` | Samples from this long ago: `30m`, `6h`, `7d`. Can't be combined with `--from`. |
| `--from <time>` | Start time. |
| `--to <time>` | End time, as an ISO timestamp or epoch milliseconds. Default now. |
| `--interval <interval>` | `1m` or `1h`. |
| `--samples` | Print every sample as a table after the summary. |

```sh
yoal broker metrics jobs --since 6h --samples
```

### broker queues

```sh
yoal broker queues <name>
```

Lists the JetStream streams and consumers with their backlog. The node refreshes the listing about once a minute, and the output says when it was taken. Also available as `broker streams`.

```sh
yoal broker queues jobs
```

### broker credentials

```sh
yoal broker credentials <name>
```

Prints the connection URL alone on stdout. With `--json`, it also prints the user, password, host and port. Also available as `broker creds`. Needs `broker:credentials`, and each read is audited.

```sh
nats --server "$(yoal broker credentials jobs)" stream ls
```

The URL points at the broker's node, so run the client there or through an SSH tunnel.

### broker queue-create

```sh
yoal broker queue-create <name> <queue>
```

Creates a function queue's stream now, instead of on its first use. If the stream already exists, nothing changes.

Queue names use lowercase letters, digits and hyphens, start and end with a letter or digit, and are at most 63 characters. The queue commands run as tasks on the broker's node. The CLI waits up to 2 minutes for the result; if the node takes longer, the command fails, but the task may still finish and its result is kept for an hour. With `--json`, these commands print the task with its raw result.

```sh
yoal broker queue-create jobs emails
```

### broker send

```sh
yoal broker send <name> <queue> [body] [options]
```

Publishes a test message to a function queue. Give the body once: as the argument, with `--body`, with `--file`, or piped on stdin. One trailing newline is dropped from a file or stdin. The body is JSON unless you pass `--text`, and it is at most 128 KiB. Also available as `broker publish`.

| Flag | Description |
| --- | --- |
| `--body <text>` | Message body. |
| `--file <path>` | Read the body from a file; `-` reads stdin. |
| `--text` | Send the body as plain text. Without it, the body must be valid JSON. |
| `--delay <duration>` | Consumers see the message after this delay: seconds, or `30s`, `5m`, `2h`. At most `12h`. |
| `--count <n>` | Publish this many copies, 1 to 100. Default 1. |

```sh
yoal broker send jobs emails '{"to":"a@example.com"}' --count 5
echo '{"id":42}' | yoal broker send jobs resize --delay 30s
yoal broker send jobs logs --text --body "hello"
```

### broker peek

```sh
yoal broker peek <name> <queue> [options]
yoal broker peek <name> --stream <stream> [options]
```

Reads messages without consuming them. JSON bodies are pretty-printed, and each body is cut at 16 KiB. The output ends with the command that reads the next page.

| Flag | Description |
| --- | --- |
| `--limit <n>` | Messages to read, 1 to 50. Default 20. |
| `--from <seq>` | Start at this sequence number. |
| `--stream <stream>` | Read a stream your app created itself, instead of a function queue. |

```sh
yoal broker peek jobs emails-dlq
yoal broker peek jobs --stream EVENTS --limit 5 --from 120
```

### broker redrive

```sh
yoal broker redrive <name> <dlq> --to <queue> [--limit <n>]
```

Moves dead-lettered messages from one function queue back into another. It prints how many moved and how many are left; run it again to move more.

| Flag | Description |
| --- | --- |
| `--to <queue>` | Queue to move the messages to. Required; must differ from `<dlq>`. |
| `--limit <n>` | Messages to move, 1 to 1,000. Default 1,000. |

```sh
yoal broker redrive jobs emails-dlq --to emails
```

### broker queue-purge

```sh
yoal broker queue-purge <name> <queue> [--yes]
yoal broker queue-purge <name> --stream <stream> [--yes]
```

Removes every message from a queue's stream. The stream and its consumers stay. Asks `[y/N]`.

| Flag | Description |
| --- | --- |
| `--stream <stream>` | Act on a stream your app created itself. |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal broker queue-purge jobs emails-dlq --yes
```

### broker queue-rm

```sh
yoal broker queue-rm <name> <queue> [--yes]
yoal broker queue-rm <name> --stream <stream> [--yes]
```

Deletes a stream with every message and consumer in it. A function queue gets a new, empty stream on its next use. Asks `[y/N]`.

| Flag | Description |
| --- | --- |
| `--stream <stream>` | Act on a stream your app created itself. |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal broker queue-rm jobs old-queue
```

### broker message-rm

```sh
yoal broker message-rm <name> <queue> <seq> [--yes]
yoal broker message-rm <name> <seq> --stream <stream> [--yes]
```

Deletes one message by its sequence number. A message that's already gone changes nothing. Asks `[y/N]`.

| Flag | Description |
| --- | --- |
| `--stream <stream>` | Act on a stream your app created itself. |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal broker message-rm jobs emails-dlq 17
```

## events

Aliases: `event`

Manages event rules. A rule publishes platform events, such as uploads, alerts, deployments and backups, to a queue on one of your brokers, and a function consumes the queue. Attach the broker to the function's project first with `yoal broker attach <broker> -p <function>`. See [brokers and events](/data/brokers-and-events).

```sh
yoal events <command> [options]
```

`yoal events` with no subcommand runs `events list`.

| Source | Events | Body |
| --- | --- | --- |
| `storage` | `object-create`, `object-delete` | Cloudflare's R2 notification shape. |
| `alerts` | `firing`, `resolved` | Yoal's event envelope. |
| `deployments` | `created`, `promoted`, `failed` | Yoal's event envelope. |
| `database-backups` | `completed`, `failed` | Yoal's event envelope. |

Listing and showing rules and deliveries needs `broker:read`. Creating, changing, testing and deleting a rule needs `broker:update` on its broker. Creating one also needs read access to what it watches: `storage:read`, `metrics:read` for alerts, `deployment:read` or `database:read`.

### events list

```sh
yoal events list
```

Lists event rules. Also available as `events ls`.

```sh
yoal events list --json
```

### events create

```sh
yoal events create <source> --broker <name> --queue <name> [options]
```

Creates a rule for one source. Without `--event`, it matches every event the source has. When the first rule watches a bucket, the storage instance restarts once to turn on bucket notifications.

| Flag | Description |
| --- | --- |
| `--broker <name>` | Managed broker that holds the queue. Required. |
| `--queue <name>` | Queue to publish to. Required. |
| `-e`, `--event <event>` | Only this event. Repeatable. |
| `--storage <name>` | `storage`: the instance to watch. Required for this source. |
| `--bucket <name>` | `storage`: the bucket to watch. Required for this source. |
| `--prefix <prefix>` | `storage`: only keys that start with this, for example `uploads/`. |
| `--suffix <suffix>` | `storage`: only keys that end with this, for example `.jpg`. |
| `-p`, `--project <slug>` | `deployments`: only this project. Default: every project. |
| `--database <name>` | `database-backups`: only this database. Default: every database. |
| `--rule <id>` | `alerts`: only this alert rule. Default: every rule. |
| `--description <text>` | A note shown in the rule list. |
| `--disabled` | Create the rule switched off. |

```sh
yoal events create storage --storage media --bucket uploads --suffix .jpg \
  --event object-create --broker jobs --queue images
yoal events create alerts --event firing --broker jobs --queue pages
yoal events create deployments --project shop --broker jobs --queue deploys
```

### events info

```sh
yoal events info <id>
```

Shows one rule with its delivery counts and last error. Also available as `events show`.

```sh
yoal events info evr_123
```

### events update

```sh
yoal events update <id> [options]
```

Changes a rule's events, key filters, queue or description, or switches it on or off. Pass at least one flag. Prints the updated rule.

| Flag | Description |
| --- | --- |
| `-e`, `--event <event>` | Replace the rule's events. Repeatable. |
| `--queue <name>` | Publish to this queue instead. |
| `--prefix <prefix>` | New key prefix filter. `--prefix ""` clears it. |
| `--suffix <suffix>` | New key suffix filter. `--suffix ""` clears it. |
| `--description <text>` | New note. `--description ""` clears it. |
| `--enable` | Switch the rule on. |
| `--disable` | Switch the rule off. Can't be combined with `--enable`. |

```sh
yoal events update evr_123 --suffix .png --event object-create --event object-delete
yoal events update evr_123 --disable
```

### events delete

```sh
yoal events delete <id> [--yes]
```

Deletes a rule. Its undelivered events are dropped; the prompt says how many. Asks `[y/N]`; declining exits `0` without a message. Also available as `events rm`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal events delete evr_123 --yes
```

### events test

```sh
yoal events test <id>
```

Queues one synthetic event for the rule, to check the consumer end to end. Prints the delivery's ID; follow it with `events deliveries`.

```sh
yoal events test evr_123
```

### events deliveries

```sh
yoal events deliveries [<id>] [options]
```

Lists recent deliveries, newest first, for one rule or every rule.

| Flag | Description |
| --- | --- |
| `--status <status>` | `pending`, `delivered` or `failed`. |
| `--limit <n>` | How many deliveries to show. |

```sh
yoal events deliveries evr_123 --status failed
```

## email

Aliases: `mail`

Sends email from your own domains through Yoal's mail service, and manages domains, suppressions, sandbox recipients and SMTP credentials. See [email](/data/email).

```sh
yoal email <command> [options]
```

`yoal email` with no subcommand runs `email status`. Each group (`domains`, `suppressions`, `addresses`, `credentials`) runs its `list` subcommand when given no subcommand.

| Permission | Needed for |
| --- | --- |
| `email:read` | Viewing the status, domains, messages, suppressions and credentials. |
| `email:send` | `send`. |
| `email:update` | Adding and checking domains, suppressions, sandbox recipients, `request-access` (owners and admins only), `attach` and `detach` (with `project:update` on the project). |
| `email:delete` | `domains rm`. |
| `email:credentials` | `credentials create` and `credentials revoke`. |

New organisations start in the sandbox: they can send only to their own verified domains and to sandbox recipients who confirmed a link, up to 200 messages a day.

### email status

```sh
yoal email status
```

Shows the organisation's state (`sandbox`, `active` or `paused`), its sending limits, messages sent today, and its bounce and complaint rates against the warning and pause thresholds.

```sh
yoal email status
```

### email domains list

```sh
yoal email domains [list]
```

Lists sending domains and how many of their DNS records check out. The group is also available as `email domain`, and `list` as `ls`.

```sh
yoal email domains
```

### email domains add

```sh
yoal email domains add <domain> [--no-auto-dns] [--no-sending]
```

Adds a sending domain. When Yoal manages the domain's DNS through Cloudflare, it creates the DKIM, SPF and DMARC records itself; otherwise it prints the records to create at your DNS provider. Also available as `domains create`.

| Flag | Description |
| --- | --- |
| `--auto-dns`, `--no-auto-dns` | Create the records through Cloudflare, or only print them. |
| `--sending`, `--no-sending` | Turn sending from the domain on, or add it without sending yet. |

```sh
yoal email domains add example.com
yoal email domains add example.org --no-auto-dns
```

### email domains info

```sh
yoal email domains info <domain>
```

Shows a domain's DNS records next to what public DNS returns for each. Also available as `domains show`.

```sh
yoal email domains info example.com
```

### email domains check

```sh
yoal email domains check <domain>
```

Re-checks the domain's DNS records now and lists the ones that don't match yet. Public DNS can take a few minutes to show a new record.

```sh
yoal email domains check example.com
```

### email domains rm

```sh
yoal email domains rm <domain> [--yes]
```

Removes a sending domain. Mail from it is refused at once, its DKIM key is deleted, and records Yoal created through Cloudflare are deleted; remove any you added by hand. Asks `[y/N]`. Also available as `domains delete`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal email domains rm example.org --yes
```

### email send

```sh
yoal email send --from <address> --to <address> --subject <text> --text <text> [options]
```

Sends one message. The sender must be on a verified sending domain. A message has at least one and at most 50 recipients across `--to`, `--cc` and `--bcc`. It needs a body: `--text` or `--text-file`, `--html-file`, or a text and an HTML body together. Recipients on the suppression list are skipped and listed.

| Flag | Description |
| --- | --- |
| `--from <address>` | Sender. Required. |
| `--to <address>` | Recipients. Repeatable or comma-separated. |
| `--cc <address>` | Copy recipients. Repeatable or comma-separated. |
| `--bcc <address>` | Blind copy recipients. Repeatable or comma-separated. |
| `--subject <text>` | Subject. Required. |
| `--text <text>` | Plain-text body. |
| `--text-file <path>` | Plain-text body from a file. Can't be combined with `--text`. |
| `--html-file <path>` | HTML body from a file. |
| `--tag <key=value>` | Tag echoed in events and webhooks. Repeatable, at most 10. Keys use letters, digits, `_`, `.` and `-`, up to 64 characters. |

```sh
yoal email send --from hi@example.com --to you@example.com --subject Hello --text "It works"
yoal email send --from billing@example.com --to a@example.com,b@example.com \
  --subject "Your receipt" --text-file receipt.txt --html-file receipt.html --tag kind=receipt
```

### email log

```sh
yoal email log [options]
yoal email log <message-id>
```

Without an ID, lists recent messages, newest first. With an ID, shows one message: each recipient's status and delivery timeline; the list flags can't be used then. Also available as `email logs`.

| Flag | Description |
| --- | --- |
| `--limit <n>` | How many messages, 1 to 200. Default 50. |
| `--recipient <address>` | Only messages to this address. |
| `--status <status>` | Only messages in this state: `accepted`, `delivered`, `deferred`, `bounced`, `complained`, `rejected`, `suppressed`, `received` or `dropped`. |
| `-f`, `--follow` | Poll every 3 seconds and print new messages and status changes until you press Ctrl-C. With `--json`, prints one JSON object per line. |

```sh
yoal email log --status bounced --limit 20
yoal email log --follow
yoal email log msg_123
```

### email suppressions list

```sh
yoal email suppressions [list] [--address <address>] [--limit <n>]
```

Lists the addresses Yoal won't send to. The group is also available as `email suppression`, and `list` as `ls`.

| Flag | Description |
| --- | --- |
| `--address <address>` | Look up one address. |
| `--limit <n>` | How many entries, 1 to 1,000. |

```sh
yoal email suppressions list --address someone@example.net
```

### email suppressions add

```sh
yoal email suppressions add <address> [--reason <reason>]
```

Suppresses an address until you remove it.

| Flag | Description |
| --- | --- |
| `--reason <reason>` | `manual` or `unsubscribe`. |

```sh
yoal email suppressions add someone@example.net --reason unsubscribe
```

### email suppressions rm

```sh
yoal email suppressions rm <address>
```

Allows sending to an address again. If it bounces again, it is suppressed again. Doesn't ask. Also available as `suppressions remove` and `suppressions delete`.

```sh
yoal email suppressions rm someone@example.net
```

### email addresses list

```sh
yoal email addresses [list]
```

Lists sandbox recipients: single addresses you may send to while the organisation is in the sandbox, pending or verified. The group is also available as `email address`, and `list` as `ls`.

```sh
yoal email addresses
```

### email addresses add

```sh
yoal email addresses add <address>
```

Emails the address a confirmation link. Mail to it is refused until its owner opens the link. For a pending address it sends a fresh link; for a verified one it changes nothing. Also available as `addresses resend`.

```sh
yoal email addresses add me@example.net
```

### email addresses rm

```sh
yoal email addresses rm <address>
```

Removes a sandbox recipient. While the organisation is in the sandbox, mail to it is refused again. Doesn't ask. Also available as `addresses remove` and `addresses delete`.

```sh
yoal email addresses rm me@example.net
```

### email request-access

```sh
yoal email request-access --use-case <text> --volume <n> [--website <url>]
yoal email request-access
```

Asks a platform admin to move the organisation out of the sandbox; you get an email with the answer. Without flags, it shows your latest request and its status. Organisation owners and admins only.

| Flag | Description |
| --- | --- |
| `--use-case <text>` | What you send, and to whom. Required when requesting; at least 20 characters. |
| `--volume <n>` | Messages you expect to send a day, 1 to 10,000,000. `10k` and `2m` work. Required when requesting. |
| `--website <url>` | Your website, if you have one. |

```sh
yoal email request-access --volume 500 --use-case "Password resets and receipts for our customers"
yoal email request-access
```

### email credentials list

```sh
yoal email credentials [list]
```

Lists SMTP credentials. Passwords are never shown again. The group is also available as `email creds`, and `list` as `ls`.

```sh
yoal email credentials
```

### email credentials create

```sh
yoal email credentials create <name> [--project <slug>] [--from <domain>]
```

Creates an SMTP credential and prints its username, password, host and port. Store the password at once: it is shown only once. The same credential works as a Bearer token for `POST /api/v1/email/send`.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Scope the credential to this project. Default: organisation-wide. |
| `--from <domain>` | Only allow sending from this domain. Repeatable or comma-separated. Default: any of the organisation's sending domains. |

```sh
yoal email credentials create newsletter --from news.example.com
```

### email credentials revoke

```sh
yoal email credentials revoke <id> [--yes]
```

Revokes a credential. Apps using it can no longer send. Asks `[y/N]`. Also available as `credentials rm` and `credentials delete`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal email credentials revoke smtp_123 --yes
```

### email attach

```sh
yoal email attach --project <slug> [--prefix <PREFIX>]
```

Creates SMTP credentials for a project and injects them at its next activation: `<PREFIX>_HOST`, `<PREFIX>_PORT`, `<PREFIX>_SECURE`, `<PREFIX>_USER`, `<PREFIX>_PASSWORD` and `<PREFIX>_URL`.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Project. Required. |
| `--prefix <PREFIX>` | Variable prefix, in UPPER_SNAKE_CASE. Default `SMTP`. |

```sh
yoal email attach --project api
```

### email detach

```sh
yoal email detach --project <slug> [--prefix <PREFIX>]
```

Removes a project's SMTP variables and revokes the credential behind them. The app restarts without the variables.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Project. Required. |
| `--prefix <PREFIX>` | Which attachment to remove. Default `SMTP`. |

```sh
yoal email detach --project api
```

## log-drain

Aliases: `log-drains`

Forwards the organisation's log lines to a webhook or an OpenTelemetry (OTLP) receiver. Viewing drains needs `logs:read`; creating, changing, testing and deleting them is for organisation owners and admins. A drain to a private address can only be set up by a platform admin, in the dashboard. See [dashboards and logs](/observe/dashboards-and-logs).

```sh
yoal log-drain <command> [options]
```

`yoal log-drain` with no subcommand runs `log-drain list`.

Webhook requests carry `X-Yoal-Signature: t=<unix>,v1=<hex>`, where the hex value is the HMAC-SHA256 of `<t>.<raw body>` keyed with the drain's signing secret. The secret is printed once, by `create` and by `update --rotate-secret`.

### log-drain list

```sh
yoal log-drain list
```

Lists drains with their kind, target, scope, status, and lines delivered and dropped. Also available as `log-drain ls`.

```sh
yoal log-drain list
```

### log-drain create

```sh
yoal log-drain create <name> --url <url> [options]
```

Creates a drain. Lines logged from then on are forwarded within a few seconds. For a webhook drain, it prints the signing secret once. Also available as `log-drain add`.

| Flag | Description |
| --- | --- |
| `--url <url>` | Receiver, `https://`. Required. For OTLP, the collector; `/v1/logs` is added to a bare origin. |
| `--otlp` | Send OTLP/HTTP JSON instead of a webhook. |
| `--format <format>` | Webhook body: `ndjson`, one JSON object per line (default), or `json`, a JSON array. Not for OTLP drains. |
| `-p`, `--project <slug>` | Only this project's logs. Default: every project and managed services. |
| `--source <source>` | Only `build`, `runtime`, `system` or `services`. Repeatable or comma-separated. Default: all. |
| `--min-level <level>` | Only this level and above: `debug`, `info`, `warn` or `error`. |
| `-H`, `--header "Name: value"` | Sent with every request, such as an API key. Repeatable; `Name=value` also works. Values are write-only. |
| `--disabled` | Create the drain switched off. |

```sh
yoal log-drain create archive --url https://logs.example.com/yoal -H "Authorization: Bearer …"
yoal log-drain create grafana --otlp --url https://otlp-gateway.example.com/otlp \
  -H "Authorization: Basic …" --min-level info
yoal log-drain create shop-errors -p shop --source runtime --min-level error --url https://hooks.example.com/in
```

### log-drain info

```sh
yoal log-drain info <id>
```

Shows one drain: its target, filters, header names, delivered and dropped lines, and last error. Also available as `log-drain show`.

```sh
yoal log-drain info ldr_123
```

### log-drain update

```sh
yoal log-drain update <id> [options]
```

Changes a drain. Pass at least one flag. Prints the updated drain, and the new signing secret when you rotate it.

| Flag | Description |
| --- | --- |
| `--name <name>` | Rename the drain. |
| `--url <url>` | New receiver. |
| `--format <format>` | `ndjson` or `json`. |
| `--source <source>` | Only these sources. Repeatable or comma-separated. |
| `--all-sources` | Forward every source again. Can't be combined with `--source`. |
| `--min-level <level>` | Only this level and above. |
| `--all-levels` | Forward every level again. Can't be combined with `--min-level`. |
| `-H`, `--header "Name: value"` | Replace the headers. Repeatable; pass every header the drain should keep. |
| `--clear-headers` | Remove every header. Can't be combined with `--header`. |
| `--enable` | Switch forwarding on, from now on. |
| `--disable` | Switch forwarding off. Can't be combined with `--enable`. |
| `--rotate-secret` | Issue a new webhook signing secret, printed once. |

```sh
yoal log-drain update ldr_123 --disable
yoal log-drain update ldr_123 --min-level warn --rotate-secret
```

### log-drain test

```sh
yoal log-drain test <id>
```

Sends one test line now and prints what the receiver answered. Exits `1` when the test fails, with or without `--json`.

```sh
yoal log-drain test ldr_123
```

### log-drain delete

```sh
yoal log-drain delete <id> [--yes]
```

Deletes a drain. Forwarding stops at once. Asks `[y/N]`; declining exits `0` without a message. Also available as `log-drain rm`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. |

```sh
yoal log-drain delete ldr_123 --yes
```
