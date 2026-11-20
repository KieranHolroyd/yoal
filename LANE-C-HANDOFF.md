# Lane C hand-off — W8 edge health, lame duck, PROXY protocol, trusted proxies

Branch `ha/w2-c-edge-health`, base `ha/integration` `416996dd`. Code commit `f215f342`.
No migration used: `0126` is untouched (the health endpoint and settings needed no new table).
`VERSION` untouched; every commit used `--no-verify`.

## What ships

- `packages/contracts/src/ingress.ts`
  - `INGRESS_HEALTH_PATH`, `INGRESS_HEALTH_PORT` (8099, now reserved in the host-port registry),
    `INGRESS_DRIFT_WINDOW_MS` (120 s, CLUSTERING §7.1), the six one-word answers.
  - `ingressDesiredSchema`: the cluster settings plus lane B's optional
    `certificateFingerprint`; `trustedProxies` are validated CIDRs at the schema, so a malformed
    range never reaches a node.
  - Desired state gains an optional `ingress` block and the heartbeat an optional
    `ingressHealth` (the existing `ingressHealthSchema`).
- `packages/site-config/src/compile.ts`
  - `compileIngressProtection()`: health routes on the content server (443), the redirect server
    (80) and a dedicated plain listener (`:8099` or `ingress.healthPort`); `Connection: close`
    while the drain file exists; PROXY protocol wrapper (`allow` = trusted proxies,
    `fallback_policy: ignore`); server-level `trusted_proxies` + `client_ip_headers` +
    `trusted_proxies_strict`; a Caddy `grace_period` no shorter than the drain.
  - Health answers are constant 16 bytes, host-agnostic, terminal, with `Server` deleted. Order:
    `draining`, `caddy`, `desired-state`, `releases`, `certificates`, then 200 `ok`; no state file
    means 503 `caddy` (the agent has not confirmed a config).
  - The protected-copy health-probe exemption now matches Caddy's `client_ip` (resolved address),
    not `remote_ip`.
  - `compileCaddyConfig` accepts `httpListen`, so `YOAL_CADDY_LISTEN` is honoured with TLS on.
- `apps/agent/src/ingress-health.ts` — pure decision: 200 only when Caddy is up, routes are at the
  desired version or inside the drift window, every release the applied routes need is on disk,
  and the loaded fingerprint (when the fleet has one) matches. Includes the one-word mapping.
- `apps/agent/src/lame-duck.ts` — idempotent drain state machine: write 503 `draining` *before*
  the wait; the caller stops only after `begin()` resolves; `reset()` restores serving.
- `apps/agent/src/main.ts`
  - Recomputes health every 5 s and before each heartbeat, writing exactly one state file; sends
    `ingressHealth` in the heartbeat.
  - SIGTERM/SIGINT drains an ingress for `drainSeconds` while Caddy keeps serving, then stops; the
    node-update restart travels the same SIGTERM path, so the binary swap is preceded by the 503
    window without changing the update runner.
  - A reconcile that removes the `ingress` role drains on the old config first, then drops the
    edge config; a failed converge leaves the old config serving.
  - Reads the served leaf certificate's SHA-256 fingerprint (cached 60 s) for the certificate
    condition; TLS managers and cert custody are untouched.
  - `YOAL_CADDY_LISTEN` is split into secure content listeners and `:80` redirect listeners when
    TLS is on; the default `:443,:80` renders exactly as before.
- `apps/agent/src/caddy-config.ts` — wires the protection only when desired state carries
  `ingress` (a worker's config is unchanged), keeps health probes out of analytics buckets, and the
  Kubernetes allowlist now matches `client_ip`.
- `packages/core/src/nodes.ts` / `cluster-config-service.ts` — the ingress settings ride desired
  state to ingress nodes only; an ingress setting change bumps the watermark. Golden state was
  regenerated with the additive block (28 lines on the edge nodes).
- `scripts/systemd/agent.ts`, `scripts/systemd/yoal-agent.service` — `TimeoutStopSec` 20 → 150 so
  the largest allowed drain (120 s) can finish before systemd kills the agent.

## Verified

- `bun run check` — all packages 0 errors (control-plane keeps its pre-existing 1 Svelte warning);
  `iam lint: no new role/kind checks`.
- `bun test` (full) — 6,294 pass, 74 skip, 0 fail on the final two runs. One earlier full run
  reported 4 transient failures that did not reproduce (the failing test names were not captured;
  no new test was among the candidate output).
- Focused tests:
  - `apps/agent/src/ingress-health.test.ts` — 200 only with every condition; each 503 reason;
    drift window boundary; releases; fingerprint normalisation/mismatch; drain precedence; first
    failure ordering.
  - `apps/agent/src/lame-duck.test.ts` — 503 is written before the wait, the stop happens only
    after the drain, zero-second drain still flips state first, concurrent callers share one
    drain, reset restores serving.
  - `packages/site-config/src/ingress-protection.test.ts` — health on 443/80/8099; any Host;
    16-byte one-word bodies; PROXY v1 and v2 wrapper with `allow` and TLS wrapper on content;
    trusted-proxy resolver fields; defaults render none; invalid CIDRs and ports 80/443 refused;
    custom `listen`/`httpListen`; grace period.
  - `apps/agent/src/caddy-config.test.ts` — an ingress gets the health routes and health listener;
    proxy settings render; a worker's config is byte-unchanged and has no health path; health
    probes are skipped in the access log; protected-copy probe uses `client_ip`.
  - `apps/agent/src/config.test.ts` — `splitIngressListen` for `:443,:80`, host-bound addresses,
    a non-80 secure port, TLS off, and a `:80`-only TLS refusal; default health dir.
  - `packages/core/src/cluster-config-service.test.ts` — ingress merges without resetting
    neighbours, bumps once on change, and a same-value save does not bump.
  - Golden desired-state fixture updated deliberately.

## Not verified (needs the lab)

- Real Caddy 2.11.8 `caddy validate` / `POST /load` of the rendered config, and the health answer
  through Caddy on 80, 443 and 8099 with the documented headers and constant size.
- HAProxy/Azure LB/Hetzner probe removal within the 15 s bound and a drained ingress with zero
  failed requests (S9 rig exists; this lane only renders the config).
- PROXY v1/v2 through a real balancer; forged PROXY/XFF from an unlisted source; direct probes
  without a PROXY header; garbage headers; `client_ip` in the Caddy access log.
- The certificate condition with a real fleet fingerprint: `nodes.ts` still sends
  `certificateFingerprint: null`, so the check is inert until lane B wires
  `CertificateService.fingerprint()` (or the heartbeat equivalent) into that field.
- Role removal while live (agent converge drain + Caddy config drop), and a node update's SIGTERM
  drain against the helper's restart ordering.
- `YOAL_CADDY_LISTEN` bound to a floating/balancer address with TLS and ACME issuance.
- Rate limiting of the health endpoint (the pinned Caddy build has no rate-limit module) and
  HTTP/3: S9 recommends disabling HTTP/3 on ingress behind a TCP balancer, not implemented here.

## Deviations / integration notes

1. **Desired state is no longer byte-identical with all flags off.** The edge now always receives
   an additive `ingress` block (defaults: 20 s drain, PROXY off, no trusted proxies, health port
   null → 8099) so the health endpoint and lame duck exist without a new flag, as the brief asked.
   Golden was regenerated; workers are unchanged.
2. **Health/lame duck add a 20 s stop delay on an ingress.** That is H19's default. The agent
   unit timeout moved to 150 s to cover the 120 s maximum; a worker still stops immediately.
3. **PROXY v1 and v2 render the same Caddy wrapper.** Caddy's `proxy_protocol` wrapper detects the
   version from the header; the setting chooses whether to accept a header at all and from whom.
4. **Analytics stores no client address by design** (usage analytics is address-free), so no
   analytics code read `remote_ip` before or after. What changed is the Caddy server's
   `trusted_proxies`, which makes its `client_ip` (and therefore the access log) the resolved
   address; the access rule exemption and the Kubernetes allowlist now match `client_ip`.
5. **Lane A owns the ingress payload.** This lane added one `ingress` line to `nodes.ts` and the
   settings merge in `cluster-config-service.ts`; lane A should rebase those two small edits over
   its payload changes. `apps/agent/src/main.ts` and `compile.ts` are the shared hot files named in
   HA-WAVE-2 §"Known integration conflicts".
6. **Certificate field ownership.** `ingressDesiredSchema.certificateFingerprint` is the contract
   point for lane B; the agent compares the served leaf's SHA-256 against it when non-null. Until
   lane B fills it, the certificate condition passes and health depends on the other three.

## Final SHA

Code: `f215f342efe79093c91cc1f482b7a91117b5e36c`; this hand-off file is committed on top.
