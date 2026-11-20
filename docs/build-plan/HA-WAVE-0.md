# HA Wave 0 — report

Plan: [HA-PLAN.md](../HA-PLAN.md) §5 wave 0, §6.5. Audited base `main` at `83d4e469`. Everything below
is on local branches; nothing is merged to `main`. `ha/integration` merges all of them (S10 pending)
and passes `bun run check` and `bun test` (6,024 pass, 0 fail, 67 skip).

## Branches

| Branch | What | Review | Merge notes |
|---|---|---|---|
| `ha/w0-fixes` | F1–F6; F5 code only (no CLI release) | Independent review; findings fixed in `641ac60e` | Commit `docs/HA-PLAN.md` first (the branch links to it). `docs/ROADMAP.md` has an adjacent-line conflict with the owner's uncommitted edit |
| `ha/w0-checker-sim` | Checker (I1–I7, I11–I16), seeded lease simulator, mutants | Independent review; fix round done | Merge before `ha/w0-lab` (lab merged an older checker commit) |
| `ha/w0-lab` | Four-node nested-container lab + s3lab, fault verbs (test builds only), `kill-node-b`, `ha.yml` | Independent review; fix round done | The CI edge step exits 2 until F7 (health Host header) lands |
| `ha/w0-spike-s2` | Litestream follow: MinIO and R2 | Read | — |
| `ha/w0-spike-s3`, `ha/w0-spike-s3-cloud` | Conditional writes: MinIO, Garage, RustFS; R2 and GCS (S7) | Read | — |
| `ha/w0-spike-s4`, `ha/w0-spike-s4-cloud` | Certificate distribution; DNS-01 on Cloudflare (staging CA) | Read | — |
| `ha/w0-spike-s8` | Member-failover spec (model check skipped at the owner's request) | — | Uncommitted TLC model files remain in the `ha/w0-spike-s8-model` worktree |
| `ha/w0-spike-s9`, `ha/w0-spike-s9-cloud` | HAProxy, keepalived; Hetzner LB (€0.09) | Independent review | `ha/w0-spike-s9-cloud` history contains edge-b's public IP (as a refusal guard in `hcloud.ts:13`) |
| `ha/w0-spike-s10` | Container → forwarder on the gateway address | Pending | Still running (2 h soak replacing the 24 h one) |

## Spikes

| # | Result | Key numbers | Fallback triggered |
|---|---|---|---|
| S2 local (MinIO) | Conditional pass | Litestream 0.3.13 (pinned) cannot follow; 0.5.x needed. 1 s interval: p95 1.38 s (fail), p99 1.42 s; 250 ms: p95 0.73 s. Promotion fingerprint identical. 60 s cut: 47 s to recover (no request timeout; 4.3 s with a watchdog). Restart keeps position | No |
| S2 R2 | **Fail on lag**, follow itself correct | 1 s: p95 2.17 s (fail), p99 2.33 s; 250 ms worse (p95 9.56 s, rising). 60 s cut: 80 s to recover. Promotion identical. 429 on 1.7% of LISTs, retried silently. ≈ $106/month per idle standby in LISTs | No: restore-and-swap is still worse. C6's ≤ 1 s replay lag over R2 needs a new bound (proposed p95 2.5 s / p99 5 s) or batched/parallel follow upstream. Keep 1 s on R2 |
| S3 Garage | **Fail** | No conditional writes at all | Not offered as an arbiter |
| S3 MinIO, RustFS | **Fail** (fixable in the client) | CAS correct; ABA through MD5 ETags; p99 at 200 writers 371 ms (MinIO) / 4 s (RustFS) | Not offered until the `seq` counter lands; then re-test |
| S3 R2 | Pass with client fixes | One winner per ETag; 412 for stale conditions, 0 × 409 in 12,200 contended writes; p99 282 ms; no throttling at 1 s renewals. **Unchanged `ControlLease` never renews**: R2 gzips GETs and returns weak `W/` ETags, so `If-Match` always fails. With identity reads: 13 terms, 0 overlaps | No, given the fixes below |
| S7 GCS | **Pass** | 412 everywhere; new generation on every write; p99 251 ms; 429 above 1 write/s per object | No |
| S3 AWS, S7 Azure | Not run | — | — |
| S4 | Pass for B-hot | Control-plane issuer with hot swap passes all five criteria. Caddy-as-holder fails (certmagic ARI duplicates); `POST /load` drops 1,000/1,000 connections. HTTP-01 relay is mandatory. DNS-01 on Cloudflare: lego one order (wildcard + apex, 25 s), Caddy two orders; both leak the TXT record when the API is down at cleanup, Caddy silently | No. Azure DNS and Route 53 not run |
| S8 | Spec done; model check skipped | Partial TLC: mutants 1 and 2 caught; healthy-cluster liveness holds (2.07 M states). Suspected `MonoReset` defect unconfirmed | Not decided. Spec decisions D-S8-1…17 and three open questions await the owner |
| S9 local | Pass except reload | HAProxy removal 9.2–13.3 s; lame duck 0 failures (22/23 runs); PROXY v2 67/67; VIP move 2.8–3.4 s; health body constant 16 bytes. Reload with 1,000 keep-alive fails behind L4, passes with HAProxy `mode http` | No |
| S9 Hetzner LB | Pass except reload | Removal 0.3–7.9 s; drain 0 failures 10/10; PROXY 38/38; health-check floor 3 s / 1 s / 1 retry; `trusted_proxies` = the LB's private address. Azure LB, AWS NLB not run | No |
| S10 | Pending | Interim: a Bun forwarder restart bug found and fixed in a variant; after raising conntrack, 100k/100k clean for the fixed Bun forwarder, caddy-l4 and direct; < 2 ms; idle RSS at 200 routes 35 MB (Bun) / 50 MB (caddy-l4) | Pending |

## M0 exit criteria

| Criterion | Status |
|---|---|
| Fixes merged | Merge-ready on `ha/w0-fixes`; merging is the owner's step |
| Spike results in SPIKES.md | Yes for S2, S3, S4, S7, S9 (consolidated on `ha/integration`); S8 is a spec; S10 pending |
| The lab runs one scenario | Yes: `kill-node-b` runs and reports. In edge mode it reports *invalid* because of F7; in direct mode it measured failover |

## Production bugs found (new fix-now items, being fixed on `ha/w1-fixes`)

| # | Bug |
|---|---|
| F7 | The edge's active health check sends no Host header (`compile.ts:259-264`): remote copies are always unhealthy and never get traffic |
| F8 | A copy re-placed by failover has no `DATABASE_URL` and crash-loops |
| F9 | "Offline at 30 s" is 30–90 s: offline marking runs in a 60 s sweep |
| F10 | `caddy.service` has `Restart=no` on every node |
| F11 | Retrying a node join returns 500 (UNIQUE on `nodes.wg_public_key`) |
| F12 | With Caddy preinstalled the installer keeps the stock Caddyfile, whose admin API is on TCP |

Reported, owned later: the Kubernetes allowlist matches `remote_ip`, so it returns 403 behind an
L7 balancer (`caddy-config.ts:230`, W8); the Cloudflare token sits in Caddy's JSON
(`compile.ts:395`, `caddy-config.ts:134`, W7); `release.yml` builds Caddy with Go 1.24 but Caddy
2.11.8 needs 1.26 (owner).

## `ha-lease.ts` defects (confirmed by the simulator, the S8 spec, S3 local and S3 R2)

1. A renewal is stamped when the reply arrives, not when it was sent; a pause over 20 s gives two
   primaries. `S3ObjectStore` has no request timeout (`object-store.ts:377`).
2. A node never retakes a lease that names it (liveness).
3. A follower's epoch can go backwards under stale reads.
4. R2 weak ETags (above): send `Accept-Encoding: identity` and fail closed on `W/`.
5. MD5 ETags allow ABA: add a `seq` counter to the lease body.
6. Use an active conformance probe rather than relying on 501.

The object-store parts (4, and the request timeout) are in Wave 1 lane E. The lease state machine
(1–3, 5) is W9 core and goes through the §6.4 procedure in Wave 3.

## Where the plan is wrong

- **C6 lag bound.** ≤ 1 s replay lag over R2 is not reachable with Litestream follow (S2).
- **Litestream pin.** 0.3.13 cannot follow; W9 needs 0.5.x, which ignores the 720 h retention
  setting and holds a reader lock (walstall).
- **H23 add order** is unsafe, `ANY 1` breaks I12, H21 needs the member list in the lease, the
  arbiter has a clock dependency, the agent alone cannot enforce the fence (use a systemd dead-man
  timer), a 30 s `statement_timeout` fakes a sync ack, and the 25 s budget assumes no sync wait
  (S8 spec).
- **CLUSTERING §1 and §19.1** number I7 and I8 differently.
- **§6.3's** "no instant both accept writes" depends on an unenforced reply bound (lease defect 1).
- **HA-PLAN §2.1** "Load balancing works" is wrong for more than one node until F7 lands.
- **§7.3 / H20 distribution** needs a hot swap: `POST /load` drops every connection (S4).
- **Reload behind a TCP balancer** drops in-flight requests (S9 local and Hetzner): W8 needs HAProxy
  `mode http` or a drain before reload, and HTTP/3 off behind a TCP LB.
- **W4 flag.** `SERVICE_ENDPOINTS` defaults on, so W4's new behaviour needs its own opt-in flag
  (`ENDPOINTS_GATEWAY`); see [HA-WAVE-1.md](./HA-WAVE-1.md).

## Incidents and hygiene

- **S4 local:** a test issuer policy without an issuer contacted the public Let's Encrypt
  directory and registered six ACME accounts. Orders were refused and no certificate was issued;
  the rig was fixed to refuse a missing issuer.
- **S9 cloud:** the first Hetzner token was the production project's. The rig's guard (which
  refuses any project containing edge-b) stopped it at €0; the owner replaced the token.
- **Credentials:** `creds/creds.env` and `creds/gcs-sa.json` should be `chmod 600`; an untracked
  `.ha-env` is not covered by `.gitignore`.
- **Spend:** S9 Hetzner €0.090; S2 R2 ≈ $0.05; S3/S7 cents. Every cloud prefix was emptied.
