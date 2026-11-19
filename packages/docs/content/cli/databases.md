---
title: Databases and backups
description: Every yoal db and yoal backup-target command, with its flags, prompts and permissions, for managed databases, credentials, backups, PITR and replicas.
---

This page is the complete reference for `yoal db`, which manages databases, their credentials, backups, point-in-time recovery and read replicas, and for `yoal backup-target`, which sets where backups are written. For what these features do and when to use them, see [databases](/data/databases) and [backups and point-in-time recovery](/data/backups-and-pitr). Global options such as `--profile`, environment variables and the general exit codes are on the [CLI overview](/clients/cli).

Arguments in angle brackets are required and arguments in square brackets are optional. Every subcommand accepts `-h`/`--help`, which prints help without contacting the server, and `--json`, which prints the server's response instead of the human summary. Boolean flags also have a `--no-` form and accept `--flag=true` or `--flag=false`.

## db

```sh
yoal db <command> [options]
```

Manages databases: PostgreSQL by default, and also MySQL, MariaDB, MongoDB, Valkey, Redis and ClickHouse. Each database runs on one node. Projects you attach it to receive connection variables named with a prefix, such as `DATABASE_URL`. With no command, or with only flags, `yoal db` runs [`db list`](#db-list).

Aliases: `databases`.

Commands that change or remove something ask first. Off a terminal, such as in CI, they fail with the error code `confirmation_required` and exit `1` unless you pass `-y`/`--yes`. Answering no at a prompt also exits `1`, and nothing is changed.

Permissions are checked by the server against the database, or the organisation for `create`. Reading needs `database:read`, changing needs `database:update`, deleting needs `database:delete`, and anything that returns or changes a password needs `database:credentials`. Each subcommand below says which it needs. Every read of a password is audited. See [organisations and roles](/accounts/organizations-and-roles).

### db list

```sh
yoal db list [--all] [--json]
```

Lists the databases you can read, with their status, engine and version, node, size against budget, attached projects and creation time. Also available as `ls`. Needs `database:read`.

| Flag | Description |
| --- | --- |
| `-a`, `--all` | Include databases in the trash. |

```sh
yoal db
yoal db list --all
```

### db create

```sh
yoal db create <name> [options]
```

Creates a database. With `--project`, it is attached to that project at once and placed on the project's node. Needs `database:create` on the organisation, and `project:update` on the project when you pass `--project`. See [create a database](/data/databases#create-a-database).

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | Attach the new database to this project. |
| `--engine <engine>` | `postgres` (default), `mysql`, `mariadb`, `mongodb`, `valkey`, `redis` or `clickhouse`. |
| `--version <version>` | Engine version. See the table below for the accepted versions and the default. |
| `--variant <variant>` | PostgreSQL image: `standard` (default), `postgis` or `pg_cron`. `postgis` and `pg_cron` need PostgreSQL 18, keep pgvector, and can't be changed later. See [image variants](/data/databases#image-variants). |
| `--prefix <PREFIX>` | Env prefix for the attachment. Needs `--project`. Use upper snake case that starts with a letter and doesn't end in `_`, such as `ANALYTICS_DB`. The default depends on the engine. |
| `--placement <where>` | `auto` (default), `edge`, or a node ID. |
| `--memory <size>` | Memory limit. A plain number is megabytes; `M` and `G` suffixes are accepted, such as `512M` or `1G`. 128 MB to 16 GB. The default depends on the engine. |
| `--cpus <n>` | CPU limit, a positive number up to 8, such as `0.5` or `2`. Default `1`. |
| `--storage <size>` | Storage budget used for alerts and the size gauge, in the same format as `--memory`. 256 MB to 1 TB. Default `10G`. |
| `--disk <where>` | Where the data lives: `system`, `fast`, `bulk` or a disk name. Default: the setting in **Settings → Storage**. |
| `--pooler`, `--no-pooler` | Run a PgBouncer sidecar and inject `<PREFIX>_POOL_URL`. PostgreSQL only. On by default. |
| `--extension <name>` | Enable an allowlisted extension, such as `pg_trgm` or `uuid-ossp`. Repeat the flag for more. PostgreSQL only. See [extensions](/data/databases#extensions). |

| Engine | Versions | Default version | Default prefix | Default memory |
| --- | --- | --- | --- | --- |
| `postgres` | `18`, `17`, `16` | `17` | `DATABASE` | 256 MB |
| `mysql` | `9.7`, `8.4` | `8.4` | `DATABASE` | 512 MB |
| `mariadb` | `11.8`, `11.4` | `11.8` | `DATABASE` | 256 MB |
| `mongodb` | `9.0`, `8.0` | `8.0` | `MONGODB` | 512 MB |
| `valkey` | `9.1`, `8.1` | `9.1` | `REDIS` | 256 MB |
| `redis` | `8.10`, `8.8` | `8.10` | `REDIS` | 256 MB |
| `clickhouse` | `26.8`, `26.3` | `26.8` | `CLICKHOUSE` | 2 GB |

```sh
yoal db create main --project api
yoal db create cache --engine valkey --project api          # api receives REDIS_URL
yoal db create geo --version 18 --variant postgis --extension pg_trgm --memory 1G
```

### db info

```sh
yoal db info <name> [--json]
```

Shows a database's status, engine and version, node, size against its storage budget, attached projects and largest tables. Databases in the trash are shown too, with how to restore or purge them. Also available as `show`. Needs `database:read`.

```sh
yoal db info main
```

### db update

```sh
yoal db update <name> [options]
```

Changes a database's limits, pooler, extensions or version. Pass at least one flag. Needs `database:update`.

New memory, CPU and storage limits apply the next time the database restarts, so follow them with [`db restart`](#db-restart). A change to the pooler, extensions or version restarts the database straight away. Raising memory re-checks that the node has room.

| Flag | Description |
| --- | --- |
| `--memory <size>` | New memory limit, as for `create`. |
| `--cpus <n>` | New CPU limit. |
| `--storage <size>` | New storage budget. |
| `--pooler`, `--no-pooler` | Turn the PgBouncer sidecar on or off. PostgreSQL only. |
| `--extension <name>` | Enable another allowlisted extension. Repeatable. PostgreSQL only. Extensions already enabled are kept; this never drops one. |
| `--version <version>` | Move to a newer version in place, for MySQL, MariaDB, Valkey, Redis and ClickHouse. Asks for confirmation, because there is no way back. A PostgreSQL major goes through [`db upgrade`](#db-upgrade); MongoDB needs a backup and restore. |
| `-y`, `--yes` | Skip the `--version` confirmation. Required with `--version` off a terminal. |

```sh
yoal db update main --memory 1G --cpus 2
yoal db update main --no-pooler
yoal db update cache --version 9.1 --yes
```

### db attach

```sh
yoal db attach <name> --project <slug> [--prefix <PREFIX>] [--credential <id|role>]
```

Connects a database to a project. The project receives `<PREFIX>_URL`, `_HOST`, `_PORT`, `_USER`, `_PASSWORD` and `_NAME` at its next activation, and a running app restarts on its own. Static projects can't use a database. Needs `project:update` on the project and `database:update` on the database. See [attach to a project](/data/databases#attach-to-a-project) and [environment variables](/data/databases#environment-variables).

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | The project. Required. |
| `--prefix <PREFIX>` | Env prefix, in upper snake case. Default: the engine's prefix, such as `DATABASE`. |
| `--credential <id\|role>` | Connect as a [named credential](#db-credentials-create) instead of the owner, by ID or by role (`app`, `readonly` or `backup`). PostgreSQL only. |

```sh
yoal db attach main --project api
yoal db attach main --project reports --prefix REPORTS_DB --credential readonly
```

### db detach

```sh
yoal db detach <name> --project <slug>
```

Disconnects a database from a project. The app restarts without the database variables; the data is untouched. Needs `database:update`.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | The project. Required. |

```sh
yoal db detach main --project reports
```

### db delete

```sh
yoal db delete <name> [--yes]
```

Moves a database to the trash. Its container stops, and its data stays on the node for 7 days by default, after which it is purged automatically. Refused while any project is attached; the error lists the `db detach` commands to run first. Asks `[y/N]` before deleting. Also available as `rm`. Needs `database:delete`. See [restart, delete, restore and purge](/data/databases#restart-delete-restore-and-purge).

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. Required off a terminal. |

```sh
yoal db delete old-main
```

### db restore

```sh
yoal db restore <name> [--json]
```

Brings a database back from the trash, on the same node and with its data. Attachments are not restored, so re-attach the projects that need it with [`db attach`](#db-attach). Needs `database:delete`.

To restore a backup rather than the trash, use [`db restore-backup`](#db-restore-backup).

```sh
yoal db restore old-main
```

### db purge

```sh
yoal db purge <name> [--yes]
```

Permanently deletes a database that is in the trash, and its data on the node. This can't be undone. Refused if the database isn't in the trash. You confirm by typing the database's name. Needs `database:delete`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for the name. Required off a terminal. |

```sh
yoal db purge old-main
```

### db logs

```sh
yoal db logs <name> [options]
```

Prints the database container's log: time, level and message per line. Needs `database:read`.

| Flag | Description |
| --- | --- |
| `-f`, `--follow` | Keep polling every 2 seconds and print new lines until you press Ctrl-C. `--json` is ignored while following. |
| `--limit <n>` | Lines per request, 1 to 2,000. Default 500, or 200 while following. |
| `--level <level>` | Only `debug`, `info`, `warn` or `error`. |
| `--q <text>` | Only lines that contain this text. |
| `--after <cursor>` | Start after this cursor, a number from a previous page's `cursor` in `--json` output. |

```sh
yoal db logs main --level error
yoal db logs main --follow --q checkpoint
```

### db credentials

```sh
yoal db credentials <name> [--json]
```

Prints the owner's connection URL, alone on stdout, so you can pass it straight to a client. On a terminal, a note follows on stderr. With `--json`, the full object is printed, including `username`, `password`, `host`, `port`, `databaseName`, `directUrl`, `poolerUrl`, `sslmode`, the CA certificate and connection snippets for common clients. Also available as `creds`. Needs `database:credentials`, and the read is audited.

The URL points at `127.0.0.1` on the database's node. Run the client on that node, or tunnel to it first with `ssh -L <port>:127.0.0.1:<port> <node>`. See [connections and TLS](/data/databases#connections-and-tls).

`yoal db credentials --help` shows the help for this command and its subcommands below. The subcommands are recognised when a database name follows the verb, so `yoal db credentials list` on its own prints the URL of a database called `list`.

```sh
psql "$(yoal db credentials main)"
yoal db credentials main --json
```

### db credentials list

```sh
yoal db credentials list <name> [--json]
```

Lists the database's credentials: the built-in owner and monitor roles and any named credentials, with their ID, role, username, status, purpose, expiry and creation time. No passwords are shown. Needs `database:read`. See [named credentials](/data/databases#named-credentials).

```sh
yoal db credentials list main
```

### db credentials create

```sh
yoal db credentials create <name> [--role <role>] [--purpose <text>] [--expires <time>]
```

Creates a named credential, a separate database login that the node provisions next. It prints the credential's ID and username, never its password. PostgreSQL only. Needs `database:credentials` and `database:update`.

| Flag | Description |
| --- | --- |
| `--role <role>` | `app` (default) reads and writes tables in the `public` schema, `readonly` can only `SELECT`, `backup` reads for dumps. |
| `--purpose <text>` | A note saying what the credential is for. |
| `--expires <time>` | An ISO 8601 date or time after which the credential expires, such as `2026-12-31T00:00:00Z`. |

```sh
yoal db credentials create main --role readonly --purpose BI
yoal db credentials create main --role app --expires 2026-12-31
```

### db credentials rotate

```sh
yoal db credentials rotate <name> <id> [--json]
```

Sets a new password on a named credential. The node applies it first, then apps attached with that credential restart with it. Refused for a revoked credential; rotate the owner or monitor with [`db rotate`](#db-rotate) instead. Needs `database:credentials` and `database:update`.

```sh
yoal db credentials rotate main dbc_abc123
```

### db credentials revoke

```sh
yoal db credentials revoke <name> <id> [--yes]
```

Disables a named credential's login on the node's next pull. Anything still connecting with it is locked out. Refused while a project is attached with it, and for the owner and monitor roles. Asks `[y/N]` first. Needs `database:credentials` and `database:update`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. Required off a terminal. |

```sh
yoal db credentials revoke main dbc_abc123 --yes
```

### db credentials reveal

```sh
yoal db credentials reveal <name> <id> [--json]
```

Prints a named credential's password, alone on stdout so it can be piped. On a terminal, the role, username and expiry follow on stderr. Needs `database:credentials`, and the read is audited. AI agents can't reveal passwords over MCP.

```sh
yoal db credentials reveal main dbc_abc123
```

### db restart

```sh
yoal db restart <name> [--pooler]
yoal db restart --all
```

Restarts a database and its pooler. Attached apps reconnect when it is back. With `--all`, every database restarts and any that were skipped are listed with the reason. Needs `database:update`.

| Flag | Description |
| --- | --- |
| `--pooler` | Restart only the PgBouncer sidecar. PostgreSQL keeps its connections. Ignored with `--all`. |
| `--all` | Restart every database instead of one. Don't pass a name. |

```sh
yoal db restart main
yoal db restart main --pooler
yoal db restart --all
```

### db upgrade

```sh
yoal db upgrade <name> --to <major> [--apply] [--yes]
```

Plans a PostgreSQL major-version upgrade. Without `--apply`, it prints the plan: the versions, any blockers and warnings, and the numbered steps. With `--apply`, it asks for confirmation, then queues a pinned pre-upgrade backup and prints the manual steps to follow. The major version is never switched automatically. A blocked plan fails with the error code `upgrade_blocked`. PostgreSQL only; other engines move forward with [`db update --version`](#db-update). Needs `database:update`, for the plan as well as `--apply`. See [changing the version and moving nodes](/data/databases#changing-the-version-and-moving-nodes).

| Flag | Description |
| --- | --- |
| `--to <major>` | The target major version, such as `18`. Required. |
| `--apply` | Queue the pinned backup and the upgrade runbook. |
| `--plan` | Show the plan only. This is already what happens without `--apply`. |
| `-y`, `--yes` | Skip the `--apply` confirmation. Required with `--apply` off a terminal. |

```sh
yoal db upgrade main --to 18
yoal db upgrade main --to 18 --apply
```

### db rotate

```sh
yoal db rotate <name> [--monitor]
```

Queues a new password for the owner role. The node applies it on its next pull, and attached apps restart with the new secret. Needs `database:credentials` and `database:update`. See [rotating the owner password](/data/databases#rotating-the-owner-password).

| Flag | Description |
| --- | --- |
| `--monitor` | Rotate the monitor role's password instead of the owner's. |

```sh
yoal db rotate main
yoal db rotate main --monitor
```

### db backups

```sh
yoal db backups <name> [--json]
```

Shows the backup policy, with the next scheduled backup and the last verified restore, then lists the backups: ID, kind (`manual` or `scheduled`), status, size, time, when it was verified, when it expires and the target it was written to. A backup on a deleted target is marked `(unavailable)` and can't be restored until you add a target with the same location. `--json` prints the backup list, including each backup's location. Needs `database:read`. See [backups and point-in-time recovery](/data/backups-and-pitr).

```sh
yoal db backups main
```

### db backup

```sh
yoal db backup <name> [--pin]
yoal db backup --all
```

Queues a backup now. The node picks it up on its next pull; follow it with [`db backups`](#db-backups). With `--all`, a backup is queued for every database, and any that were skipped are listed with the reason. Needs `database:update`. See [on-demand backups](/data/backups-and-pitr#on-demand-backups).

| Flag | Description |
| --- | --- |
| `--pin` | Keep this backup past the retention period. Ignored with `--all`. |
| `--all` | Back up every database instead of one. Don't pass a name. |

```sh
yoal db backup main --pin
yoal db backup --all
```

### db backup-delete

```sh
yoal db backup-delete <name> <backup-id>
```

Deletes one backup. There is no confirmation prompt. With `--json`, it prints `{"ok": true}`. Needs `database:delete`.

```sh
yoal db backup-delete main bkp_abc123
```

### db restore-backup

```sh
yoal db restore-backup <name> <backup-id> --as <new-name> [options]
```

Restores a backup into a new database; the source database isn't touched. The node verifies the restore, so follow it with [`db info`](#db-info). Needs `database:create`. See [restore to a new database](/data/backups-and-pitr#restore-to-a-new-database).

| Flag | Description |
| --- | --- |
| `--as <new-name>` | Name of the new database. Required. |
| `--placement <where>` | `auto`, `edge` or a node ID for the new database. |
| `-p`, `--project <slug>` | Attach the new database to this project. |
| `--prefix <PREFIX>` | Env prefix for that attachment, in upper snake case. |

```sh
yoal db restore-backup main bkp_abc123 --as main-restored
yoal db restore-backup main bkp_abc123 --as main-copy --project staging --prefix DATABASE
```

### db backup-policy

```sh
yoal db backup-policy <name> [options]
```

Shows a database's backup policy, or changes it when you pass a flag. The policy is printed as JSON either way. Showing needs `database:read`; changing needs `database:update`. See [scheduled backups](/data/backups-and-pitr#scheduled-backups).

| Flag | Description |
| --- | --- |
| `--schedule <cron>` | Five-field cron expression, in UTC. Quote it. |
| `--retention <days>` | Days to keep each backup, a whole number from 1 to 365. Applies to backups taken after the change. |
| `--enable` | Turn scheduled backups on. |
| `--disable` | Turn scheduled backups off. Wins if you also pass `--enable`. |

```sh
yoal db backup-policy main
yoal db backup-policy main --schedule "0 */6 * * *" --retention 14
yoal db backup-policy main --disable
```

### db pitr

```sh
yoal db pitr <name> [--enable | --disable [--yes]]
```

Shows or changes point-in-time recovery for a database. With no flag, it shows whether PITR is on, the repository, WAL archive health, the last base backup, the recoverable window, the next full and differential backups, the last verified restore and any problem. PostgreSQL 18 on the standard image only, and only once a platform admin has configured the PITR repository. Showing needs `database:read`; changing needs `database:update`. See [point-in-time recovery](/data/backups-and-pitr#point-in-time-recovery).

| Flag | Description |
| --- | --- |
| `--enable` | Turn PITR on. The database restarts on the PITR image, then the node takes the first full backup; the recoverable window appears once that backup is reported. Doesn't ask. |
| `--disable` | Stop archiving WAL. Point-in-time restores stop at this moment until you enable it again; existing backups stay in the repository. Asks `[y/N]` first. |
| `-y`, `--yes` | Skip the `--disable` confirmation. Required with `--disable` off a terminal. |

Passing both `--enable` and `--disable` is an error.

```sh
yoal db pitr main
yoal db pitr main --enable
yoal db pitr main --disable --yes
```

### db pitr-backup

```sh
yoal db pitr-backup <name> [--type <type>]
```

Queues a PITR base backup now. Follow it with [`db pitr`](#db-pitr). Needs `database:update`.

| Flag | Description |
| --- | --- |
| `--type <type>` | `full` (default), `diff` or `incr`. |

```sh
yoal db pitr-backup main
yoal db pitr-backup main --type diff
```

### db restore-to

```sh
yoal db restore-to <name> --time <timestamp> --as <new-name>
```

Restores a database to a moment in time, into a new database on the same node. The new database stays pending until the node verifies it; follow it with [`db info`](#db-info). Needs `database:create`. See [restore to a point in time](/data/backups-and-pitr#restore-to-a-point-in-time).

| Flag | Description |
| --- | --- |
| `--time <timestamp>` | ISO 8601 timestamp with `Z` or an offset, such as `2026-11-05T09:30:00Z` or `2026-11-05T10:30:00+01:00`. It must be inside the recoverable window that `db pitr` shows. Required. |
| `--as <new-name>` | Name of the new database. Required. |

```sh
yoal db restore-to main --time 2026-11-05T09:30:00Z --as main-before-migration
```

### db replica list

```sh
yoal db replica list <name> [--json]
```

Lists a PostgreSQL database's read replicas: ID, node (marked `(same node)` when it shares the primary's node), status, lag in seconds and bytes, replay position, host port and a note. The five most recent promotions follow, with the primary's current generation. `replica` is also available as `replicas`, and `list` as `ls`. `yoal db replica` with no verb prints the replica help. Needs `database:read`. See [read replicas](/data/databases#read-replicas).

```sh
yoal db replica list main
```

### db replica add

```sh
yoal db replica add <name> --node <node> [--disk <where>]
```

Adds an asynchronous streaming replica on a node. It copies the primary first, then streams. Attached apps get `<PREFIX>_READ_URL`, `_READ_URLS`, `_READ_HOST` and `_READ_PORT` while a replica they can reach is streaming or lagging. A replica on the primary's own node is for read scaling only and can't be promoted. Also available as `create`. Needs `database:update`.

| Flag | Description |
| --- | --- |
| `--node <node>` | Node ID or name. Required. |
| `--disk <where>` | `system`, `fast`, `bulk` or a disk on that node. Default: the same kind of disk as the primary. |

```sh
yoal db replica add main --node edge-b
yoal db replica add main --node edge-b --disk fast
```

### db replica remove

```sh
yoal db replica remove <name> <replica-id> [--yes]
```

Stops a replica. Its node deletes its copy of the data and the primary drops its replication slot; the primary is otherwise untouched. Asks `[y/N]` first. Also available as `rm` and `delete`. Needs `database:update`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Don't ask for confirmation. Required off a terminal. |

```sh
yoal db replica remove main dbr_abc123
```

### db replica promote

```sh
yoal db replica promote <name> <replica-id> [--accept-data-loss] [--yes]
```

Makes a replica the primary: the old primary is fenced and stopped, the replica is promoted and attached apps are re-pointed to it. This can't be undone in place. You confirm by typing the database's name. The CLI sends the primary generation it saw, so the promotion is refused if another promotion got there first. Needs `database:update`. See [promote a replica](/data/databases#promote-a-replica).

| Flag | Description |
| --- | --- |
| `--accept-data-loss` | Promote even though the replica is behind (more than 64 MB or 60 seconds), its lag report is stale, or the old primary's node can't confirm that it stopped. Commits the replica hasn't replayed are lost. |
| `-y`, `--yes` | Don't ask for the name. Required off a terminal. |

```sh
yoal db replica promote main dbr_abc123
yoal db replica promote main dbr_abc123 --accept-data-loss --yes
```

## backup-target

```sh
yoal backup-target <command> [options]
```

Configures where database backups are written: a directory on the control-plane host, or an S3-compatible bucket such as Cloudflare R2, AWS S3, MinIO, RustFS or Garage. With no command, or with only flags, it runs [`backup-target list`](#backup-target-list). See [backup targets](/data/backups-and-pitr#backup-targets).

Aliases: `backupTargets`.

A target is used by the next backup once it is the one that applies: the organisation's oldest target, otherwise the platform default. Existing backups stay where they were written, because each backup records its target and exact location, and restores and retention use that record.

Listing needs `database:read` on the organisation. Adding, testing and removing an organisation target need `database:update`; doing the same to a platform target needs a platform admin. Adding, testing and removing are refused when a platform admin has turned backup management off.

### backup-target list

```sh
yoal backup-target list [--json]
```

Lists backup targets with their ID, name, kind, scope (`org` or `platform`), status, when they were last checked and their location. Secrets are never returned. Also available as `ls`.

```sh
yoal backup-target list
```

### backup-target add

```sh
yoal backup-target add <name> --kind local --path <dir>
yoal backup-target add <name> --bucket <bucket> --access-key <id> --secret-key <secret> [options]
```

Adds a target. The name uses 3 to 40 lowercase letters, digits and single hyphens, and must be unique in its scope. Secrets are sealed with the organisation key. For an S3 target, the key pair is printed once after it is created and never again. If backups were left unavailable by an earlier `remove --force`, adding a target with the same location reconnects them. Also available as `create`.

| Flag | Description |
| --- | --- |
| `--kind <kind>` | `local` or `s3`. Default `s3`. |
| `--path <dir>` | Local only, and required for it. An absolute directory without a trailing slash, using only letters, digits, `.`, `_`, `-` and `/`, such as `/var/lib/yoal/backups`. |
| `--endpoint <url>` | S3 endpoint for R2, MinIO, RustFS, Garage and other compatible services. Omit it for AWS S3. |
| `--bucket <name>` | S3 bucket. Required for S3. |
| `--region <region>` | Signing region. Default `us-east-1`; R2 uses `auto`. |
| `--prefix <path>` | Key prefix inside the bucket, without a leading or trailing slash. Default `yoal/backups`. |
| `--access-key <id>` | S3 access key ID. Required for S3. |
| `--secret-key <secret>` | S3 secret access key. Required for S3. |
| `--write-only` | The key can write and list but not delete. Yoal then never deletes backups on this target for retention. |
| `--object-lock` | Record that the bucket has object lock enabled. S3 only. |
| `--platform` | Create the platform default target instead of an organisation target. Platform admins only. |

```sh
yoal backup-target add local --kind local --path /var/lib/yoal/backups
yoal backup-target add garage --endpoint https://s3.internal:3900 --bucket yoal \
  --access-key "$KEY" --secret-key "$SECRET" --write-only
yoal backup-target add r2 --endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com --region auto \
  --bucket yoal-backups --access-key "$KEY" --secret-key "$SECRET" --platform
```

### backup-target test

```sh
yoal backup-target test <id> [--json]
```

Probes a target and prints `OK` or `FAILED` with a message, and for S3 whether the bucket has versioning and object lock enabled. A failed probe is reported in the output; the command still exits `0`.

```sh
yoal backup-target test bt_abc123
```

### backup-target remove

```sh
yoal backup-target remove <id> [--force] [--yes]
```

Deletes a target. Refused while it holds backups that are still retained, because its sealed credentials are the only way Yoal can restore or prune them: delete those backups first with [`db backup-delete`](#db-backup-delete), wait for retention, or use `--force`. Even with `--force`, it is refused while a backup to the target is running or a database is being restored from it. Objects in the target are never deleted. Asks for confirmation first; answering no prints `Cancelled.` and exits `0`. Also available as `rm` and `delete`.

| Flag | Description |
| --- | --- |
| `--force` | Delete it even though backups were written to it. They stay listed as unavailable and can't be restored until you add a target with the same location. |
| `-y`, `--yes` | Don't ask for confirmation. Required off a terminal. |

```sh
yoal backup-target remove bt_abc123
yoal backup-target remove bt_abc123 --force --yes
```
