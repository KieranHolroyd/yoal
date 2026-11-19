---
title: Identity and access
description: Reference for yoal iam, identity, sts, sa, federation, access, key, pool and access-policy, with every subcommand, flag, prompt and JSON shape.
---

These commands manage who can do what in your organisation and how machines prove who they are: roles, bindings and groups, service accounts and their keys, federation trusts and token exchange, workload tokens, just-in-time access requests, managed user pools and Yoal Access policies. Roles and permissions are explained in [organisations and roles](/accounts/organizations-and-roles), and credentials in [API keys and tokens](/accounts/api-keys-and-tokens). Switching organisation is [`yoal org`](/cli/accounts-and-settings#org).

Global options (`--profile`, `--json`, `--help`), environment variables and exit codes are described once in the [CLI overview](/clients/cli); this page lists what each command adds. Arguments in angle brackets are required and arguments in square brackets are optional. Every boolean flag also has a `--no-` form, and every subcommand accepts `-h, --help`, which prints the command's full help. Unless a section says otherwise, a command exits `0` on success and `1` on any error.

Every check happens on the server, so a command you lack the permission for fails with an HTTP 403 error that names the missing permission. Commands that take a name or an id (a role, group, service account, pool or policy) fetch the list first and match an exact id before an exact name.

### Confirmations

Commands that delete, remove or revoke something ask `[y/N]` first. Answering anything other than `y` or `yes` prints `Cancelled.` and exits `0` without changing anything. When stdin is not a terminal the CLI cannot ask, so the command fails with the code `confirmation_required` and exits `1` unless you pass `-y, --yes`.

### Secrets shown once

`yoal key create`, `yoal sa keys create` and `yoal sa token` print a secret exactly once, indented on its own line and followed by `Copy it now: the secret is shown once and cannot be recovered.` Later reads only ever show a key's first characters (`START`). With `--json` the whole response is printed, secret included, so don't send that output to a log.

## iam

```sh
yoal iam <command> [options]
```

Roles, role bindings and groups at organisation scope, plus the "why can or can't I?" and "who can?" views, signing-key rotation and the legacy key migration. `yoal iam` on its own, `yoal iam help` and `yoal iam --help` print the help.

Aliases: none. Subcommand aliases: `roles` is also `role`, `bindings` is also `binding`, `groups` is also `group`, `who-can` is also `whocan`, `keys` is also `key`, and `migrate-keys` is also `migrate-access-keys`.

A scope or resource is written as one of:

| Form | Meaning |
| --- | --- |
| `org` | The whole organisation. An org binding covers every project and environment. |
| `platform` | The whole platform. Only a platform admin can write platform bindings. |
| `project:<id>` | One project and its environments, for example `project:prj_shop`. |
| `environment:<project>/<id>` | One environment of one project, for example `environment:prj_shop/env_staging`. |

Bindings nest: a project binding covers that project and its environments. Durations for `--expires` are a whole number followed by `s`, `m`, `h`, `d` or `w` (`30m`, `8h`, `7d`, `2w`), or an ISO timestamp such as `2026-12-01T09:00:00Z`. An expiry must be in the future.

### iam roles

```sh
yoal iam roles [list] [--json]
```

Lists built-in and custom roles with columns `ID`, `KIND` (`built-in` or `custom`), `NAME` and `PERMISSIONS` (how many permissions the role holds). `ls` is an alias of `list`. With `--json` the output is `{ "roles": [...] }`, where each role has `id`, `name`, `description`, `permissions` and `builtIn`. Reading IAM needs `iam:read`.

```sh
yoal iam roles
yoal iam roles --json
```

### iam roles create

```sh
yoal iam roles create <name> --permission <p> [--permission <p>…] [--description <text>] [--json]
```

Creates a custom role from catalogue permissions. At least one `--permission` is required; duplicates are dropped. `add` is an alias of `create`. Needs `iam:manage-roles`. On success the CLI prints the new id and the `yoal iam bind` command to use it.

| Flag | Description |
| --- | --- |
| `--permission <p>` | A catalogue permission such as `project:read`. Repeat it, or separate several with commas. Required. |
| `--description <text>` | A note shown in the role list. |
| `--json` | Print the created role as JSON. |

```sh
yoal iam roles create billing --permission project:read --permission database:read
yoal iam roles create auditor --permission audit:read,project:read --description "Read-only audit"
```

### iam roles delete

```sh
yoal iam roles delete <id> [--yes] [--json]
```

Deletes a custom role by id. The server refuses while any binding still uses it. `rm` is an alias of `delete`. Asks `Delete role <id>? It must not be bound to anyone. [y/N]` first; see [confirmations](#confirmations). Needs `iam:manage-roles`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Delete without asking. Required when stdin is not a terminal. |
| `--json` | Print the server response as JSON. |

```sh
yoal iam roles delete role_abc123 --yes
```

### iam bindings

```sh
yoal iam bindings [list] [--json]
```

Lists who is bound to which role, where, and until when, with columns `ID`, `PRINCIPAL` (`<type>:<id>`), `ROLE`, `SCOPE` and `EXPIRES` (`never` when there is no expiry). `ls` is an alias of `list`. With `--json` the output is `{ "bindings": [...] }`; each binding has `id`, `principalType`, `principalId`, `roleId`, `roleName`, `scope`, `expiresAt`, `reason`, `createdBy` and `createdAt`. To add or remove a binding, use [`iam bind`](#iam-bind) and [`iam unbind`](#iam-unbind).

```sh
yoal iam bindings
```

### iam bind

```sh
yoal iam bind <type>:<id> <role> --scope <scope> [--expires <when>] [--reason <text>] [--json]
```

Gives a principal a role at a scope. The principal is `user:<id>`, `group:<id>` or `serviceAccount:<id>`; any other type is refused. The role is matched by id or by name. Needs `iam:manage-bindings` at that scope.

| Flag | Description |
| --- | --- |
| `--scope <scope>` | Where the role applies: `org`, `platform`, `project:<id>` or `environment:<project>/<id>`. Required. |
| `--expires <when>` | A duration (`8h`, `7d`, `2w`) or an ISO timestamp. Without it the binding never expires. |
| `--reason <text>` | Why the grant exists. Kept on the binding and in the audit log. |
| `--json` | Print the created binding as JSON. |

```sh
yoal iam bind user:user_abc owner --scope org
yoal iam bind group:grp_eng deployer --scope project:prj_shop --expires 7d --reason "release week"
yoal iam bind serviceAccount:sa_ci deployer --scope environment:prj_shop/env_staging
```

### iam unbind

```sh
yoal iam unbind <id> [--yes] [--json]
```

Removes a binding by id; its access stops at once. Asks `Remove binding <id>? Its access stops at once. [y/N]` first. Needs `iam:manage-bindings`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Remove without asking. Required when stdin is not a terminal. |
| `--json` | Print the server response as JSON. |

```sh
yoal iam unbind bnd_abc123
```

### iam groups

```sh
yoal iam groups [list] [--json]
```

Lists groups with columns `ID`, `NAME`, `MEMBERS` (a count) and `SOURCE`. `ls` is an alias of `list`, and `group` works in place of `groups`. With `--json` the output is `{ "groups": [...] }`, each with `id`, `name`, `description`, `source` and `members`.

```sh
yoal iam groups
```

### iam group create

```sh
yoal iam group create <name> [--description <text>] [--json]
```

Creates a group. Bind roles to it with `yoal iam bind group:<id> …`. Needs `iam:manage-groups`.

| Flag | Description |
| --- | --- |
| `--description <text>` | A note shown in the group list. |
| `--json` | Print the created group as JSON. |

```sh
yoal iam group create eng --description "Engineering"
```

### iam group add

```sh
yoal iam group add <group> <user> [--json]
```

Adds a member. The group is matched by name or id; the member must be a user id such as `user_abc`, because the API takes an id rather than an email. Needs `iam:manage-groups`.

```sh
yoal iam group add eng user_abc
```

### iam group remove

```sh
yoal iam group remove <group> <user> [--json]
```

Removes a member from a group, without a confirmation. `rm` is an alias of `remove`. Needs `iam:manage-groups`.

```sh
yoal iam group remove eng user_abc
```

### iam explain

```sh
yoal iam explain <permission> [--resource <resource>] [--json]
```

Explains whether you can use a permission on a resource, and why. The first line is `Allowed` or `Denied` with the permission and resource, followed by the reason, the binding it came through (`Via`), and a `Grants considered` table with columns `BINDING`, `ROLE`, `SCOPE` and `OUTCOME`. An outcome is `allow`, `expired`, `condition`, `scope` or `restricted`. The command exits `0` whether the answer is allowed or denied. Needs `iam:read`.

| Flag | Description |
| --- | --- |
| `--resource <resource>` | `org` (the default), `platform`, `project:<id>` or `environment:<project>/<id>`. |
| `--json` | Print the decision: `allow`, `reason`, `via` and `chain`. |

```sh
yoal iam explain deployment:promote --resource project:prj_shop
yoal iam explain database:credentials --json
```

### iam who-can

```sh
yoal iam who-can <permission> [--resource <resource>] [--json]
```

Lists everyone who can use a permission on a resource, with columns `PRINCIPAL`, `TYPE` and `VIA`. Group bindings are expanded to their members. When nobody can, it prints `No one can <permission> on <resource>.` Needs `iam:read`.

| Flag | Description |
| --- | --- |
| `--resource <resource>` | `org` (the default), `platform`, `project:<id>` or `environment:<project>/<id>`. |
| `--json` | Print `{ "permission": …, "principals": [{ "principalType", "principalId", "via" }] }`. |

```sh
yoal iam who-can database:credentials --resource project:prj_shop
```

### iam keys

```sh
yoal iam keys [list] [--json]
```

Shows the platform's signing keys by purpose, with columns `PURPOSE`, `ACTIVE` and `NEXT` (key ids), `RETIRED` (a count) and `DUE` (the next rotation action, or `no`). Below the table it prints the last rotation and the next check. Signing keys are platform-wide, so reading them needs a platform admin; when your credential cannot rotate them, the output says so. `ls` is an alias of `list`.

With `--json` the output has `purposes` (each with `purpose`, `automatic`, `active`, `next`, `retired`, `keys` and `rotation`), `policy` (`intervalDays`, `overlapHours`, `automaticPurposes`), `lastRotatedAt`, `nextCheckAt` and `can.rotate`.

```sh
yoal iam keys
```

### iam keys rotate

```sh
yoal iam keys rotate --purpose <p> | --all [--json]
```

Rotates one signing-key purpose, or every purpose the automatic monthly sweep rotates. Rotation publishes a new `next` key and promotes the previous one, so a purpose always keeps a signer. Pass exactly one of `--purpose` or `--all`. Needs platform maintenance, which a platform admin's dashboard session or API key has. Prints one line per purpose: `Rotated <purpose>: active <kid>, next <kid>, retired <kid>.`

| Flag | Description |
| --- | --- |
| `--purpose <p>` | `sts`, `registry`, `oidc`, `workload`, or a user pool's `pool:<id>`. |
| `--all` | Rotate every automatically rotated purpose. User-pool keys are never included. |
| `--json` | Print `{ "rotations": [...], "rotatedAt": … }`. |

```sh
yoal iam keys rotate --purpose sts
yoal iam keys rotate --all
```

### iam migrate-keys

```sh
yoal iam migrate-keys [--org <id>] [--json]
```

Copies API keys created before access keys existed into organisation-bound access keys. Old `yoal_…` keys keep working without being reissued, and running it again is safe: keys already copied are counted, not copied twice. The summary reports how many keys were examined, migrated and already migrated, how many migrated keys were disabled and stay revoked, and how many were skipped (the owner has no organisation membership, the key belongs to another organisation, or the stored hash has an unexpected format).

Needs `accessKey:read-all`, which migrates your current organisation only, or platform maintenance.

| Flag | Description |
| --- | --- |
| `--org <id>` | Limit the run to one organisation. Only honoured for a platform admin; without it a platform admin migrates every organisation. |
| `--json` | Print the counts: `examined`, `migrated`, `alreadyMigrated`, `disabled`, `skippedNoOrg`, `skippedOtherOrg` and `skippedInvalid`. |

```sh
yoal iam migrate-keys
```

## identity

```sh
yoal identity token [--audience <aud>] [--token-file <path>] [--metadata-url <url>] [--json]
```

Prints a workload identity token. Run it inside a process or container workload on Yoal: the agent writes an audience-bound token for the `yoal` audience to `/var/run/yoal/token`, and the node's metadata endpoint mints tokens for other audiences, such as a cloud provider's token exchange. This command does not use your profile or API key, and the token file's contents never appear in an error message. `yoal identity` on its own prints the help.

Aliases: none.

### identity token

For the `yoal` audience (the default) the CLI prints the token file as it is. For any other audience it presents that file as a bearer token to the metadata endpoint's `/identity/token`, which asks the control plane for a token that lasts one hour. The request times out after 15 seconds.

| Flag | Description |
| --- | --- |
| `--audience <aud>` | The token audience: `yoal` (the default), `sts.amazonaws.com`, a GCP workload identity provider resource name, `api://AzureADTokenExchange`, or any other 1 to 512 printable characters. |
| `--token-file <path>` | The workload token file. Default: `$YOAL_TOKEN_FILE`, then `/var/run/yoal/token`. |
| `--metadata-url <url>` | The node metadata endpoint, an `http` or `https` URL. Default: `$YOAL_IDENTITY_URL`, then `http://127.0.0.1:8086`. Containers reach it at `http://host.containers.internal:8086`. |
| `--json` | Print `{ "access_token", "expires_in", "token_type" }` instead of the bare token. For the `yoal` audience `expires_in` is read from the token's `exp` claim. |

| Variable | Effect |
| --- | --- |
| `YOAL_TOKEN_FILE` | Path of the workload token file when `--token-file` is not given. |
| `YOAL_IDENTITY_URL` | Metadata endpoint when `--metadata-url` is not given. |

The command fails with the code `io` when the token file is missing or empty, `network` when the metadata endpoint cannot be reached, and `identity_rejected` when the endpoint refuses (for example, a disabled service account or a stale token file).

```sh
yoal identity token
yoal identity token --audience sts.amazonaws.com
TOKEN=$(yoal identity token --audience api://AzureADTokenExchange)
```

## sts

```sh
yoal sts exchange --subject-token-file <path> --audience <aud> [--scope <permission>…] [--trust-id <id>] [--json]
```

Exchanges a subject token for a short-lived Yoal access token (RFC 8693 token exchange). The subject token can be a Yoal workload token, a pipeline OIDC token (see [pipelines](/deploying/pipelines)), a GitHub Actions OIDC token, or a token from any issuer that has a [federation trust](#federation). The new token carries the trust's service account's bindings, narrowed by the trust's ceiling and your `--scope`. It lasts as long as the trust's maximum, 15 minutes by default and at most one hour. `yoal sts` on its own prints the help.

Aliases: none.

### sts exchange

The CLI sends `POST /api/iam/token` with the grant type `urn:ietf:params:oauth:grant-type:token-exchange` and prints the new access token. The subject token is the credential: it is read from a file, never printed, and never included in an error. Treat the file like a password and keep the platform URL on TLS.

The token endpoint ignores API keys, but the CLI still needs a platform URL and an API key to start, from a profile or from `YOAL_URL` and `YOAL_TOKEN`.

| Flag | Description |
| --- | --- |
| `--subject-token-file <path>` | File holding the subject JWT. Required. |
| `--audience <aud>` | The audience of the token to mint, 1 to 512 printable characters. Required. |
| `--scope <permission>` | Narrow the trust's permissions. Repeat it, or separate several with commas or spaces. A scope outside the trust's ceiling is refused. |
| `--trust-id <id>` | Use this federation trust instead of the first one that matches. |
| `--json` | Print `{ "access_token", "issued_token_type", "token_type", "expires_in" }`. |

A refused exchange fails with the code `sts_rejected` and the endpoint's `error` and `error_description`. Check the trust's issuer, audience and subject pattern, and that the service account is enabled.

```sh
yoal sts exchange --subject-token-file "$YOAL_TOKEN_FILE" --audience https://control.example.com
yoal sts exchange --subject-token-file /tmp/github.jwt --audience yoal --scope project:read
```

## sa

```sh
yoal sa <command> [options]
```

Service accounts: organisation-owned machine principals with a stable `sa_…` id. You bind roles to a service account like any other principal (`yoal iam bind serviceAccount:<id> …`), mint access keys for it, or mint a short impersonation token. `yoal sa` on its own prints the help; `yoal sa --json` lists accounts.

Aliases: `service-account`, `service-accounts`. Subcommand aliases: `list` is also `ls`, `create` is also `add`, `disable` is also `off`, `enable` is also `on`, `delete` is also `rm`, and `keys` is also `key`.

### sa list

```sh
yoal sa list [--json]
```

Lists service accounts with columns `ID`, `NAME`, `STATE` (`active` or `disabled`), `OWNER` (the owner group, or `org`), `DESCRIPTION` and `CREATED`. With `--json` the output is `{ "serviceAccounts": [...] }`; each account has `id`, `name`, `description`, `ownerGroupId`, `disabled`, `disabledAt`, `createdBy` and `createdAt`. Needs `serviceAccount:read`.

```sh
yoal sa list
```

### sa create

```sh
yoal sa create <name> [--description <text>] [--owner-group <id>] [--json]
```

Creates a service account and prints the commands to bind it and to mint a key for it. Needs `serviceAccount:create`.

| Flag | Description |
| --- | --- |
| `--description <text>` | A note shown in the list and the dashboard. |
| `--owner-group <id>` | The IAM group that owns it (`grp_…`). Default: the organisation. |
| `--json` | Print the created account as JSON. |

```sh
yoal sa create ci-bot --description "GitHub Actions"
yoal sa create deployer --owner-group grp_eng
```

### sa disable

```sh
yoal sa disable <name|id> [--json]
```

Switches an account off without a confirmation. Its keys and bindings stay but can no longer authenticate, and a disabled account cannot be impersonated. This is the normal off-switch. Needs `serviceAccount:update`.

```sh
yoal sa disable ci-bot
```

### sa enable

```sh
yoal sa enable <name|id> [--json]
```

Switches a disabled account back on. Needs `serviceAccount:update`.

```sh
yoal sa enable ci-bot
```

### sa delete

```sh
yoal sa delete <name|id> [--yes] [--json]
```

Removes an account. The server refuses while any binding still uses it, so unbind it first or [disable](#sa-disable) it instead. Asks `Delete service account <name> (<id>)? It must not be bound to any role. [y/N]` first. Needs `serviceAccount:delete`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Delete without asking. Required when stdin is not a terminal. |
| `--json` | Print the server response as JSON. |

```sh
yoal sa delete ci-bot --yes
```

### sa token

```sh
yoal sa token <name|id> [--ttl <duration>] [--audience <aud>] [--json]
```

Mints a short-lived impersonation token for the account. The token carries the account's bindings, not yours, records you as the actor, and is audited. It is not a standing key. The token is printed once (see [secrets shown once](#secrets-shown-once)) with its lifetime in seconds. Needs `serviceAccount:impersonate`.

| Flag | Description |
| --- | --- |
| `--ttl <duration>` | How long the token lasts, for example `15m`, `30m` or `1h`. Accepts the same durations as `--expires`. Default and maximum: one hour. |
| `--audience <aud>` | The token's audience. Default: the platform's own origin. |
| `--json` | Print `access_token`, `token_type`, `expires_in`, `audience` and `service_account`. |

```sh
yoal sa token ci-bot --ttl 30m
TOKEN=$(yoal sa token ci-bot --json | jq -r .access_token)
```

### sa keys list

```sh
yoal sa keys [list] <name|id> [--json]
```

Lists the account's access keys with columns `ID`, `NAME`, `START`, `EXPIRES`, `LAST USED` and `STATE` (`active` or `revoked`). With `--json` the output is `{ "accessKeys": [...] }`. `ls` is an alias of `list`. Needs `serviceAccount:read`, plus `serviceAccount:manage-keys` or `accessKey:read-all`.

```sh
yoal sa keys list ci-bot
```

### sa keys create

```sh
yoal sa keys create <name|id> <key> [--permission <p>…] [--resource <r>…] [--expires <when>] [--cidr <cidr>…] [--json]
```

Mints an access key named `<key>` for the account and prints the `yoal_…` secret once, followed by its expiry. `add` is an alias of `create`. It does the same as [`yoal key create --service-account`](#key-create). Needs `serviceAccount:read` and `serviceAccount:manage-keys`.

| Flag | Description |
| --- | --- |
| `--permission <p>` | A permission ceiling, such as `project:read`. The key can never do more than this, whatever the account is bound to. Repeat it or comma-separate. |
| `--resource <r>` | A resource ceiling, as `type:id` or `type:*`. Repeat it or comma-separate. |
| `--expires <when>` | A duration (`30d`, `90d`) or an ISO timestamp. Default: 90 days. |
| `--cidr <cidr>` | Accept the key only from these networks. Repeat it or comma-separate. |
| `--json` | Print the whole response, including the secret in `key` and the key record in `accessKey`. |

```sh
yoal sa keys create ci-bot ci --expires 90d
yoal sa keys create ci-bot readonly --permission project:read --cidr 10.0.0.0/8
```

### sa keys revoke

```sh
yoal sa keys revoke <key-id> --service-account <name|id> [--yes] [--json]
```

Revokes one of the account's keys; it stops working at once. `--service-account` is required. `rm` is an alias of `revoke`. Asks `Revoke key <id> for <name>? It stops working at once. [y/N]` first. Needs `serviceAccount:read` and `serviceAccount:manage-keys`.

| Flag | Description |
| --- | --- |
| `--service-account <name\|id>` | The account the key belongs to. Required. |
| `-y`, `--yes` | Revoke without asking. Required when stdin is not a terminal. |
| `--json` | Print the server response as JSON. |

```sh
yoal sa keys revoke ak_abc123 --service-account ci-bot --yes
```

## federation

```sh
yoal federation <command> [options]
```

Federation trusts map an external OIDC issuer to a service account. When a token from that issuer is exchanged with [`yoal sts exchange`](#sts-exchange), the trust decides whether it is accepted and caps what the minted token can do. A trust with no permission ceiling uses the service account's bindings as its ceiling; a trust never widens the account. `yoal federation` on its own prints the help.

Aliases: `federations`. Subcommand aliases: `list` is also `ls`, `create` is also `add`, and `delete` is also `rm`.

### federation list

```sh
yoal federation list [--json]
```

Lists the organisation's trusts with columns `ID`, `ISSUER`, `AUDIENCE`, `SUBJECT`, `SERVICE ACCOUNT` and `MAX TTL`. With `--json` the output is `{ "federationTrusts": [...] }`; each trust has `id`, `orgId`, `serviceAccountId`, `issuer`, `audiences`, `subjectPattern`, `claimConditions`, `maxTtlSeconds` and `restriction`. Needs `federation:read`.

```sh
yoal federation list
```

### federation create

```sh
yoal federation create --issuer <url> --audience <aud> --service-account <name|id> [options]
```

Creates a trust. Needs `federation:create`. The CLI prints the trust id, issuer, subject pattern and maximum token lifetime.

| Flag | Description |
| --- | --- |
| `--issuer <url>` | The exact OIDC issuer, as it appears in the token's `iss` claim. Required. |
| `--audience <aud>` | An accepted audience. Repeat it or comma-separate. At least one is required. |
| `--service-account <name\|id>` | The account whose bindings exchanges carry. Required. |
| `--subject <glob>` | The subject pattern: `*` matches within a segment and `**` across segments. Default: any subject. |
| `--claim <key=value>` | Require a claim to have this value. Repeat it for each claim. A value that parses as JSON keeps its type, so `--claim admin=true` requires a boolean. |
| `--ttl <duration>` | Maximum lifetime of a minted token, as a number followed by `s`, `m` or `h`. At most `1h`. Default: `15m`. |
| `--permission <p>` | Permission ceiling. Repeat it or comma-separate. |
| `--resource <r>` | Resource ceiling, as `type:id` or `type:*`. Repeat it or comma-separate. |
| `--json` | Print the created trust as JSON. |

```sh
yoal federation create --issuer https://token.actions.githubusercontent.com \
  --audience https://control.example.com \
  --subject 'repo:acme/web:ref:refs/heads/main' \
  --service-account github-actions --claim ref=refs/heads/main --ttl 15m
```

### federation delete

```sh
yoal federation delete <id> [--yes] [--json]
```

Removes a trust; new exchanges through it stop at once. Asks `Delete federation trust <id>? New exchanges stop at once. [y/N]` first. Needs `federation:delete`.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Delete without asking. Required when stdin is not a terminal. |
| `--json` | Print the server response as JSON. |

```sh
yoal federation delete ft_abc123
```

## access

```sh
yoal access <command> [options]
```

Just-in-time access: anyone in the organisation can ask for a role at a scope for a few hours, and someone else who can manage bindings at that scope approves or denies it. Approving creates a binding that expires on its own. `yoal access` on its own prints the help.

Aliases: none. Subcommand aliases: `request` is also `ask`.

### access request

```sh
yoal access request --role <name|id> --reason <text> [--scope <scope>] [--duration <when>] [--change-ref <ref>] [--json]
```

Asks for a role. The role is matched by id or name. The request stays pending for 24 hours, then expires. You can only have one pending request for the same role at the same scope. Prints the request id, which approvers pass to `approve` or `deny`.

| Flag | Description |
| --- | --- |
| `--role <name\|id>` | The role you need. Required. |
| `--reason <text>` | What you will do, and why now. At least 3 characters. Required. |
| `--scope <scope>` | `org` (the default), `project:<id>` or `environment:<project>/<id>`. Platform scope is refused. |
| `--duration <when>` | How long the grant should last, such as `1h`, `4h` or `8h`. Default `1h`, maximum `8h`. |
| `--change-ref <ref>` | A ticket, deploy or incident id to record with the request. |
| `--json` | Print the request: `id`, `requesterId`, `roleId`, `roleName`, `scope`, `durationSeconds`, `reason`, `status` and the decision fields. |

```sh
yoal access request --role deployer --scope project:prj_shop --duration 2h --reason "release"
yoal access request --role admin --reason "rotate SSO certificate" --change-ref INC-142
```

### access approve

```sh
yoal access approve <id> [--json]
```

Grants a pending request, creating a binding that expires after the requested duration. You cannot approve your own request, and you need `iam:manage-bindings` at the request's scope.

> [!NOTE]
> The server accepts a decision only from a signed-in person, and the CLI authenticates with an API key, so `approve` and `deny` are refused from the CLI with a 403 (`only a human session can decide a request`). Decide requests in the dashboard. An agent or script can still ask with `yoal access request`.

```sh
yoal access approve req_abc123
```

### access deny

```sh
yoal access deny <id> [--json]
```

Refuses a pending request; the request and its reason stay on record. The same rules as `approve` apply.

```sh
yoal access deny req_abc123
```

## key

```sh
yoal key <command> [options]
```

Access keys: `yoal_…` keys that belong to one organisation and one principal, either you or a service account. The raw key is shown once, from `create`; later reads only show its `start`. How keys are used is covered in [API keys and tokens](/accounts/api-keys-and-tokens). `yoal key` on its own prints the help; `yoal key --json` lists keys.

Aliases: `keys`, `access-key`, `access-keys`. Subcommand aliases: `list` is also `ls`, `create` is also `add`, and `revoke` is also `rm`.

### key list

```sh
yoal key list [--principal <id>] [--json]
```

Lists the keys you can see, with columns `ID`, `NAME`, `PRINCIPAL`, `START`, `EXPIRES`, `LAST USED` and `STATE` (`active` or `revoked`). Without `accessKey:read-all` you see your own keys (`accessKey:read`); with it you see the whole organisation. With `--json` the output is `{ "accessKeys": [...] }`; each key has `id`, `orgId`, `principalType`, `principalId`, `name`, `prefix`, `start`, `permissions`, `resources`, `allowedCidrs`, `expiresAt`, `lastUsedAt`, `createdBy`, `revokedAt` and `createdAt`.

| Flag | Description |
| --- | --- |
| `--principal <id>` | Only this principal's keys. Another user's keys need `accessKey:read-all`; a service account's (`sa_…`) also work with `serviceAccount:manage-keys`. |
| `--json` | Print the list as JSON. |

```sh
yoal key list
yoal key list --principal sa_ci --json
```

### key create

```sh
yoal key create <name> [--service-account <name|id>] [--permission <p>…] [--resource <r>…] [--expires <when>] [--cidr <cidr>…] [--json]
```

Mints a key and prints the secret once, then its expiry. Without `--service-account` the key is for yourself, which needs `accessKey:create`; you can only mint user keys for yourself. A service-account key needs `serviceAccount:manage-keys`.

| Flag | Description |
| --- | --- |
| `--service-account <name\|id>` | Mint the key for this service account instead of yourself. |
| `--permission <p>` | A permission ceiling, such as `project:read`. Repeat it or comma-separate. |
| `--resource <r>` | A resource ceiling, as `type:id` or `type:*`. Repeat it or comma-separate. |
| `--expires <when>` | A duration (`30m`, `8h`, `90d`, `1w`) or an ISO timestamp. Default: 90 days for a service-account key; a user key does not expire. |
| `--cidr <cidr>` | Accept the key only from these networks. Repeat it or comma-separate. A key with CIDRs is refused when the request carries no client IP. |
| `--json` | Print the whole response, including the secret in `key` and the key record in `accessKey`. |

```sh
yoal key create ci --service-account ci-bot --expires 90d
yoal key create ci --service-account ci-bot --permission project:read --cidr 10.0.0.0/8
yoal key create laptop --expires 30d
```

### key revoke

```sh
yoal key revoke <id> [--yes] [--json]
```

Revokes a key; it stops working at once. Revoking your own key needs `accessKey:revoke`, a service account's key `serviceAccount:manage-keys`, and anyone else's `accessKey:revoke-any`. Asks `Revoke access key <id>? It stops working at once. [y/N]` first.

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Revoke without asking. Required when stdin is not a terminal. |
| `--json` | Print the server response as JSON. |

```sh
yoal key revoke ak_abc123 --yes
```

## pool

```sh
yoal pool <command> [options]
```

Managed user pools: a hosted OIDC provider for the end users of one of your deployed apps. This command manages the pool and reads its OIDC clients; creating clients, managing users and the hosted sign-in pages live in the dashboard under **Settings → Identity**. A pool's discovery document is public at `/api/v1/user-pools/<id>/.well-known/openid-configuration` and its keys at `/api/v1/user-pools/<id>/.well-known/jwks.json`. `yoal pool` on its own prints the help; `yoal pool --json` lists pools.

Aliases: `pools`, `user-pool`, `user-pools`. Subcommand aliases: `list` is also `ls`, `create` is also `add`, `disable` is also `off`, and `clients` is also `client`.

### pool list

```sh
yoal pool list [--json]
```

Lists pools with columns `ID`, `NAME`, `ENGINE`, `SIGNUP`, `STATE` and `ISSUER`. With `--json` the output is `{ "pools": [...] }`; each pool has `id`, `orgId`, `name`, `description`, `engine`, `issuer`, `signingKeyId`, `signupMode`, `disabled`, `disabledAt`, `createdAt` and `updatedAt`. Needs `userPool:read`.

```sh
yoal pool list
```

### pool create

```sh
yoal pool create <name> [--description <text>] [--signup invite|open] [--engine yoal-identity] [--json]
```

Creates a pool and prints its id and issuer URL. Needs `userPool:create` at organisation scope.

| Flag | Description |
| --- | --- |
| `--description <text>` | A note shown in the list and the dashboard. |
| `--signup <mode>` | `invite` (the default): users join only by invitation. `open`: anyone can sign up. |
| `--engine <engine>` | `yoal-identity`, the default and only engine. |
| `--json` | Print the server response as JSON. |

```sh
yoal pool create customer-auth --signup open
yoal pool create staff-portal --description "Contractor sign-in"
```

### pool disable

```sh
yoal pool disable <name|id> [--json]
```

Switches a pool off without a confirmation. Its clients and signing key stay, and its discovery and JWKS endpoints return 404 while it is disabled. The CLI has no `enable`; turn a pool back on in the dashboard. Needs `userPool:update`.

```sh
yoal pool disable customer-auth
```

### pool clients

```sh
yoal pool clients <name|id> [--json]
```

Lists the pool's OIDC clients with columns `CLIENT ID`, `NAME`, `TYPE` (`public` or `confidential`), `REDIRECTS` and `CREATED`. Client secrets are shown only when a client is created and never again. With `--json` the output is `{ "pool": "<name>", "clients": [...] }`; each client has `id`, `poolId`, `name`, `clientId`, `redirectUris`, `public` and `createdAt`. Needs `userPool:read`.

```sh
yoal pool clients customer-auth
```

## access-policy

```sh
yoal access-policy <command> [options]
```

Yoal Access policies: ordered allow and deny rules that decide who can open a site. Assigning a policy switches a project scope to the `access` protection mode, alongside the `public`, `password` and `platform` modes described in [access and share links](/deploying/access-and-sharing#access-modes). `yoal access-policy` on its own prints the help; `yoal access-policy --json` lists policies.

Aliases: `access-policies`. Subcommand aliases: `list` is also `ls`, `create` is also `add`, and `assign` is also `attach`.

### access-policy list

```sh
yoal access-policy list [--project <id>] [--json]
```

Lists the policies you can read, with columns `ID`, `NAME`, `SCOPE`, `STATE` (`enabled` or `disabled`), `RULES` (a count) and `DESCRIPTION`. With `--json` the output is `{ "accessPolicies": [...] }`; each policy has `id`, `orgId`, `name`, `description`, `scope`, `enabled`, `rules` (each with `idx`, `action` and `matcher`), `createdAt` and `updatedAt`. Needs `accessPolicy:read`.

| Flag | Description |
| --- | --- |
| `--project <id>` | Only policies that apply to this project id. There is no short form here. |
| `--json` | Print the list as JSON. |

```sh
yoal access-policy list --project prj_abc
```

### access-policy create

```sh
yoal access-policy create <name> --scope <where> [--description <text>] [--rule <rule>…] [--json]
```

Creates an enabled policy. Rules are kept in the order you give them. A matching deny beats every allow, and a visitor who matches no rule is denied. Needs `accessPolicy:create` at the policy's scope.

| Flag | Description |
| --- | --- |
| `--scope <where>` | `org`, `project:<id>` or `environment:<project>/<id>`. Required. Platform scope is refused. |
| `--description <text>` | A note shown in the list and the dashboard. |
| `--rule <rule>` | One rule; repeat for more. Quote each rule, since it contains spaces. |
| `--json` | Print the created policy as JSON. |

A rule is `allow` or `deny` (lower-case), a matcher and its value:

| Rule | Matches |
| --- | --- |
| `allow member` | Any member of the organisation. `any-member` and `anymember` also work. |
| `allow group <group id>` | Members of an IAM group. |
| `allow email <address>` | One email address, compared in lower case. |
| `allow domain <example.com>` | Any email address at that domain. |
| `allow sso <provider id>` | People signed in through that SSO provider. |
| `allow pool <pool id>[:group,…]` | Users of a [user pool](#pool), optionally only those in the listed pool groups. |
| `allow cidr <10.0.0.0/8>[,<cidr>…]` | Requests from these networks. |

Each form also works with `deny`.

```sh
yoal access-policy create staff-only --scope org --rule "allow group grp_eng"
yoal access-policy create office --scope project:prj_abc --rule "allow cidr 10.0.0.0/8"
yoal access-policy create partners --scope org --rule "deny email ex-partner@example.com" --rule "allow domain example.com"
```

### access-policy assign

```sh
yoal access-policy assign <name|id> --project <slug> [--scope production|previews] [--json]
```

Turns Yoal Access on for one project scope and points it at the policy: the scope's protection mode becomes `access`, and visitors must match an allow rule. Needs `project:update` on the project.

| Flag | Description |
| --- | --- |
| `-p`, `--project <slug>` | The project whose scope changes. Required. |
| `--scope <scope>` | `production` (the default) or `previews`. |
| `--json` | Print the server response as JSON. |

Named environments cannot be assigned from the CLI; use the dashboard. To turn Yoal Access off, set the scope back to `public`, `password` or `platform` as described in [set the access mode](/deploying/access-and-sharing#set-the-access-mode).

```sh
yoal access-policy assign staff-only --project api
yoal access-policy assign office --project my-site --scope previews
```
