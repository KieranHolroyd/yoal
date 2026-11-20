# Spike S4 — one certificate, issued once, on every ingress (local half)

Branch `ha/w0-spike-s4`. Sources: CLUSTERING §15.2 S4 and §7.3, HA-PLAN H20, O1 and §4 W2 (S4 row).

## Question

Is one certificate per name set, issued once and distributed to every ingress, workable? Which
design wins (HA-PLAN open question **O1**)?

- **(A) Caddy holder.** One ingress's Caddy issues the certificate. certmagic's storage is shared
  on the object store through an S3 storage module (with its lock), and the other ingresses load
  the certificate from there.
- **(B) Control-plane issuer.** An ACME client outside Caddy issues the certificate, and each
  ingress's agent fetches the PEM pair (as Yoal's activation endpoint would serve it), replaces the
  file atomically and has Caddy load it from file (`load_files`).

And: does HTTP-01 work behind a balancer when every ingress forwards
`/.well-known/acme-challenge/*` to the current ACME holder?

## Pass criteria

Quoted from CLUSTERING §15.2 S4 (*"Both ingresses report one fingerprint; one issuance per name set
per 7 days at steady state; a renewal reloads with ≤ 0.1% dropped connections; a 6 h control-plane
outage does not stop renewal of the file on disk"*) and HA-PLAN H20 (HTTP-01 relay), with the
measurement made explicit. Each is judged per design.

1. **One fingerprint.** Every ingress (three, not two) serves the same certificate (SHA-256 of the
   leaf, read by a TLS handshake to each ingress directly with SNI) at steady state, and again after
   every renewal once distribution has finished.
2. **One issuance per name set per renewal window at steady state.** Counted at the ACME server
   (Pebble's issuance log), not by the client: over the run, issuances = 1 initial + 1 per renewal
   window, with all ingresses starting at the same moment. "7 days" is compressed with Pebble's
   short certificate lifetimes; the run says by how much.
3. **A renewal reloads with ≤ 0.1% dropped connections out of 1,000 keep-alive connections.**
   1,000 TLS keep-alive connections through HAProxy (round-robin over the ingresses), each sending a
   request every 2 s, held across a renewal and its distribution. A connection is *dropped* if the
   server closes it or a request on it fails (no response, reset, non-2xx). Pass: ≤ 1 of 1,000.
4. **A control-plane outage does not stop renewal of the file already on disk.** The plan's 6 h
   outage is compressed: the outage starts at the moment renewal is due and lasts a stated fraction
   of the renewal window. Pass: every ingress serves a valid certificate throughout, and renewal
   completes (one issuance) and reaches every ingress before the old certificate expires.
5. **HTTP-01 behind a balancer.** HTTP-01 succeeds when the challenge request lands on a non-holder
   ingress behind HAProxy round-robin. Shown failing without the relay (or, for design A, without
   shared storage).

Also answered, without a pass mark: key custody (where each design keeps the private key; can it be
sealed with the master key and delivered 0640 root:caddy, HA-PLAN §10), ingress removal (does each
design reissue?), and the ACME lease (behaviour under the weak MinIO lease found by S3; a double
issuance hits the rate limit but is not unsafe). DNS-01 runs against `pebble-challtestsrv` only, to
show the flow; Cloudflare, Azure DNS and Route 53 are not run.

## Agreed fallback (HA-PLAN §4 W2)

**Per-ingress ACME with the HTTP-01 relay; BYO certificates only for wildcard.**
(CLUSTERING §15.4 adds Cloudflare Origin CA for installs where every name is proxied.)

## Rules

Local only: OrbStack containers named `yoal-w0-s4-*` on one bridge network, no published host
ports, no real DNS, no real CA, no Cloudflare. The rig keeps no data, credentials or binaries;
pinned versions are fetched at run time. Results go in `docs/SPIKES.md` (`## S4 — …`).

## Rig

`./run.sh` (all scenarios, about 45 min) or `./run.sh a b-hot …`; numbers land in `results.json`
(git-ignored). It builds three images, starts only `yoal-w0-s4-*` containers on an `--internal`
bridge (no egress), and removes everything at the end. Results: `docs/SPIKES.md`, section S4.

| File | Role |
|---|---|
| `images/ingress.Dockerfile` | Yoal's pinned Caddy build (2.11.8, xcaddy v0.4.7, caddy-dns/cloudflare v0.2.4) **plus one** certmagic S3 storage module: `github.com/techknowlogick/certmagic-s3@v1.5.0` (image `:lock`) or `github.com/ss098/certmagic-s3@8af482af` (image `:nolock`; its `Lock` is a no-op). The module's `go 1.26.0` directive makes `GOTOOLCHAIN=auto` build with Go 1.26.0. Bun is copied in for the agent |
| `images/cp.Dockerfile` | Design B's issuer: lego v5.6.0 beside Bun |
| `lab.ts` | Names, addresses, pinned images (Pebble and challtestsrv 2.10.3 by digest, HAProxy 3.4.8, MinIO's last community image by digest) |
| `caddy.ts` | Ingress Caddy JSON: design A (shared S3 storage or local), design B (`load_files` + `POST /load`, or `get_certificate` from the agent), the HTTP-01 relay route |
| `cp.ts` | Design B issuer loop: renew at 1/3 lifetime left, retry every 5 s, serve the pair to agents, `POST /reissue` |
| `agent.ts` | Design B ingress agent: pull, write 0640 root:caddy by atomic rename, then `POST /load` or serve the pair to Caddy on loopback |
| `load.ts` | Client: fingerprint probe and watch, 1,000-connection keep-alive hold |
| `dns-exec.sh` | lego `exec` DNS provider → challtestsrv |
| `run.ts` | Scenarios `a`, `a-nolock`, `a-local`, `b`, `b-hot`, `b-norelay`, `dns01`; asserts no container log names a public ACME endpoint |

Topology: Pebble (lifetime `S4_LIFETIME`, default 240 s; no authz reuse, no nonce rejection, no VA
sleep) resolves every name through challtestsrv to HAProxy, which round-robins plain TCP on :80 and
:443 over three ingresses with no health checks. Pebble makes three concurrent validations per
challenge and needs all three, so each HTTP-01 challenge reaches all three ingresses.

MinIO no longer publishes images; the rig uses the last community image by digest (as S2 did). If
it is not in the local cache, build it from source with
`spikes/s3-cas/stores/minio.Dockerfile` on `ha/w0-spike-s3` and add `mc` to it.

## Result (2026-11-20)

Numbers, verdict and what could not be tested: `docs/SPIKES.md`, section S4. In short:
- **O1:** the control-plane issuer, delivered without a config reload (`b-hot`), passed all five
  criteria.
- **Caddy holder (A):** failed criterion 2. certmagic's ARI logic renewed early and twice in a row.
  A forced reissue does not reach the other ingresses.
- **`load_files` + `POST /load` (B):** failed criterion 3, dropping 1,000 of 1,000 connections per
  reload.

### Deviations from the brief and the plan

- Three ingresses rather than two; the criteria are judged on all three.
- Compression: lifetime 240 s, renewal window 80 s, outage 40 s (half the window, against the plan's
  1/120). Design A's outage is of the object store, since it has no control plane in the path.
- Added design variant **B-hot** (Caddy `get_certificate` from the agent) after B failed criterion 3,
  and the **A-nolock**, **A-local** and **a-ari** controls.
- Go toolchain 1.26.0 for the Caddy build (the S3 storage module requires it); release.yml pins 1.24.
- MinIO is the last community image from the local cache (no published image remains).
- Pebble clamps its ARI window to the whole lifetime for short certificates. This exposed certmagic's
  early renewals and is a lab property; real Let's Encrypt windows were not tested.
- One run reached public Let's Encrypt (production and staging) by accident: six accounts, refused
  orders, no certificate. See `docs/SPIKES.md`. The rig now has no egress and asserts on it.
