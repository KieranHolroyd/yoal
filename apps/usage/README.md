# `@yoal/usage`: usage analytics collector and dashboard

The service behind `yoal-analytics-engine.kierancloud.dev`. It receives the opt-in, anonymous
once-a-day ping that a self-hosted Yoal install sends from **Settings → Usage analytics** (or the
setup wizard). It also serves an operator dashboard over those pings.

The point of keeping it in this repository is that the people sending data can read exactly what
is sent and what happens to it:

- the wire format is [`packages/contracts/src/usage-analytics.ts`](../../packages/contracts/src/usage-analytics.ts);
- the full design, including the exact payload, retention and the dashboard's sign-in rules, is
  [`docs/USAGE-ANALYTICS.md`](../../docs/USAGE-ANALYTICS.md).

It is a plain Bun process with one SQLite file holding the pings, the installs and Better Auth's
tables. There is no third-party analytics, no cookies on the ingest path, no IP storage and no user
or organisation names.

## Run it

```sh
bun run --cwd apps/usage dev          # http://localhost:8790, rebuilds the dashboard on change
```

`dev` sets `NODE_ENV=development`, so Bun serves the React dashboard with hot reload. On first boot
the log prints a setup token. Open `/setup`, enter it, and create the first admin.

| Variable | Default | Purpose |
| --- | --- | --- |
| `YOAL_USAGE_HOST` | `$HOST`, else `127.0.0.1` | Listen address; keep it on loopback behind Caddy. |
| `YOAL_USAGE_PORT` | `$PORT`, else `8790` | Listen port. |
| `YOAL_USAGE_DATA_DIR` | `$STATE_DIRECTORY`, else `/var/lib/yoal/usage` | Data directory (created 0700). |
| `YOAL_USAGE_DB` | `<dataDir>/usage.db` | SQLite file. |
| `YOAL_USAGE_PUBLIC_URL` | `http://localhost:<port>` | The dashboard's public origin: Better Auth's base URL, the trusted origin and the passkey relying party. Set it to the real HTTPS URL in production. |
| `YOAL_USAGE_AUTH_SECRET` | generated | Better Auth's secret. Without it, one is generated once and kept in `<dataDir>/auth-secret` (0600). |
| `YOAL_USAGE_SETUP_TOKEN` | generated | Token for `/setup`. Without it, a fresh one is logged at each boot while no account exists. |
| `YOAL_USAGE_ADMIN_TOKEN` | — | Bearer token for `GET /api/v1/stats` from scripts. Signed-in operators can use that route without it. |
| `YOAL_USAGE_RETENTION_DAYS` | `400` | How long raw pings are kept (30–3650). |
| `YOAL_USAGE_TRUST_PROXY` | `1` | Read the client address from `X-Forwarded-For` (Caddy) for rate limits. |
| `YOAL_USAGE_VERSION` | `0.2.0` | Version shown by `/healthz`. |

## Routes

| Route | What it does |
| --- | --- |
| `POST /api/v1/ping` | Validate and store one ping. `202` accepted, `400` invalid, `413` too large, `429` rate-limited. |
| `GET /healthz` | `{ ok, version }`. |
| `GET /`, `/login`, `/setup`, `/installs`, `/users`, `/account` | The dashboard (one React app). |
| `GET /api/v1` | What this service is, and where the docs are. |
| `GET /api/v1/session` | Whether setup is needed, who is signed in, and whether they have a second factor. |
| `POST /api/v1/setup` | Create the first admin with the setup token. Closed once any account exists. |
| `GET /api/v1/overview?days=30` | Stats plus the daily series. Session with a second factor. |
| `GET /api/v1/installs?limit&offset&version` | Installs, newest first. Session with a second factor. |
| `GET /api/v1/stats?days=30` | Stats as JSON: the bearer token or a session with a second factor. |
| `/api/auth/*` | Better Auth: email and password, TOTP and backup codes, passkeys, sessions, account admin. |

Ingest is limited to 60 requests a minute per client address, in memory. Pings are idempotent by
their `id`, so a sender may retry safely.

## Sign-in

- Public sign-up is off. Admins add accounts on **Users**, with a temporary password.
- Nobody sees data until they have a second factor (an authenticator app or a passkey). The
  server enforces this on every data and admin route. The UI sends them to **Account** to enrol.
- `admin` manages accounts; `user` (shown as "Viewer") reads.

## Deploy on Yoal

The project is a process app whose settings are in [`deploy/blueprint.yaml`](deploy/blueprint.yaml):

```sh
yoal blueprint plan apps/usage/deploy/blueprint.yaml   # then apply the plan it prints
apps/usage/deploy/deploy.sh                            # build, deploy, wait for /healthz
```

`deploy.sh` runs `bun build --target=bun --production`. The output is `process.js` plus the
dashboard's hashed assets, with no `node_modules`, which `yoal deploy` never uploads. The app reads
Yoal's `PORT`, `HOST` and `$STATE_DIRECTORY` directly. Its database and auth secret stay in the
state directory across deploys.

Point an install at another collector with
`YOAL_USAGE_ANALYTICS_ENDPOINT=https://<host>/api/v1/ping`. The ingest endpoint is public and
anonymous by design, so give the collector a hostname of its own.
