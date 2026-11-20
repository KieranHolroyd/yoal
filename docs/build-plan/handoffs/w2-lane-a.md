# Lane A hand-off — W6 ingress payload (full edge on every ingress)

Branch `ha/w2-a-ingress-payload`, based on `ha/integration` `416996dd`. Worked only in
`/Users/kieranholroyd/.t3/worktrees/private-cloud-deploys/t3-w2-a-ingress-payload`; no other
worktree was touched, nothing was merged or pushed, and `VERSION` was not bumped.

Code/tests commit: `229ddac9` (`feat(ha): W6 ingress payload — full edge on every ingress, worker
listeners, activation secrets, drift`). The hand-off commit is the tip; `git log -1` is
authoritative.

## 1. What was verified

### Static checks, migrations and the full suite

| Command | Result |
|---|---|
| `bun run check` | 0 errors; the one pre-existing Svelte warning in `settings/registry/+page.svelte`; `iam lint` baseline 0 |
| `bun test` | **6356 tests across 571 files: 6282 pass, 74 skip, 0 fail** (240 s) |
| `bun scripts/check-migrations.ts` | `ok`, 123 migrations, 0123 appended with no edits to history |
| focused suite | `bun test packages/core/src/ingress-set.test.ts apps/agent/src/ingress.test.ts apps/agent/src/verify.test.ts apps/agent/src/caddy-config.test.ts packages/core/src/desired-state/golden.test.ts` — 80 pass, 0 fail |

The desired-state golden test (`packages/core/src/desired-state/golden.test.ts`) passes unchanged
with `INGRESS_SET` off: the snapshot file was not regenerated, so the flag-off, single-node payload
is byte-identical. `apps/agent/src/capabilities.test.ts` and the contract suite also pass with
`nodeCapabilities` now including `ingress-set`.

### What the new tests prove

- `packages/core/src/ingress-set.test.ts`
  - the set is the compatibility first ingress plus every **capable** node with the `ingress` role;
    `setEdge` still hands the role over;
  - two ingresses render the same hosts, release hashes, production/preview routes, custom domains
    (cloned with the same site key) and placeholders; static production routes have `upstream:
    null` on both and both download the release; the platform route is present on both;
  - an app copy on the first ingress is named identically by the second (`http://…` proxy);
  - a worker that gains the role gets `ingress.listeners`, `ingress.tls` and `ingress.platform`
    from desired state, and a node outside the set gets no `ingress` field;
  - the activation returns `YOAL_ACCESS_JWT_SECRET`, the site-cookie secret and the optional
    Cloudflare token, refuses a non-ingress, and none of them appears in the desired-state JSON;
  - drift: `actualStateVersion` below desired is not drifted inside the 120 s window and is
    drifted after it; the report and `view()` both expose it; a fresh heartbeat clears it;
  - `gateDesiredState` strips `ingress` without the flag or without the `ingress-set` capability.
- `apps/agent/src/ingress.test.ts`
  - listeners: a worker keeps its private `<overlay>:8080` and adds `:443`; an existing edge drops
    the redirect port; no desired listeners keeps the old `[':443']` / env behaviour;
  - secrets cache: 0600, survives a new store instance, missing/corrupt cache is `null`;
  - redeemed-token cache: a claimed id is refused by a new instance from the same file, and the
    memory-only constructor is unchanged.
- `apps/agent/src/caddy-config.test.ts`: an `https://` platform upstream becomes `dial host:443`
  with `tls.server_name` set to the platform host; a `unix//` upstream stays a plain hop.
- `apps/agent/src/verify.test.ts`: the existing one-time-token tests still pass.

## 2. What was not verified, and why

- **The authoritative two-node lab run.** Launching two real ingress nodes, killing one and
  checking byte-for-byte responses for every route type is the lab lane's scenario; this worktree
  ran only unit/contract tests and no cloud credentials or real DNS.
- **Real Caddy/ACME.** The listener merge and desired TLS settings are unit-tested; forcing a
  certificate issue on a worker that gained the role needs a real DNS-01 token or reachable
  HTTP-01, which is lane B's certificate custody and the lab's job.
- **The HTTP activation route end to end.** `GET /api/agent/ingress/activation` is a thin dispatch
  over `IngressSetService.activation()`; the service is tested, the SvelteKit route only compiles
  (`bun run check`), no browser/agent round trip ran here.
- **Platform route after `setEdge`.** The relay target is the compatibility first ingress. Today
  `setEdge` moves the ingress role but not the control-plane host (D98); until W9 renders the
  control-node upstream list, a promotion that moves the control host is not handled by this
  relay. The normal two-ingress case (control host is the edge, second node relays to it) is what
  the tests cover.
- **An external first ingress with no overlay address.** Cross-ingress proxies use
  `<privateAddress>:8080` when present and the recorded public address otherwise. An external node
  with no private address only works when its public address is a plain listener; that is the
  pre-existing cross-node assumption, not a new one.
- One earlier full-suite run showed the known flaky helper app-volume test; it passed alone and in
  the final two full runs.

## 3. Deviations and choices

1. **Migration 0123 is used — it was truly needed.** Drift must survive a control-plane restart, so
   `nodes` gained `actual_state_version` (the agent's reported applied version) and
   `actual_state_at` (when that value last changed, not every heartbeat). The migration is
   additive only; no table was added. The Wave 2 reservation table listed 0124 for this lane, but
   the brief allowed 0123 if needed; the integrator should renumber at merge as usual.
2. **`IngressSetService.nodes()`** widens to every node with the raw `ingress` role **and** the
   `ingress-set` capability, unioned with the compatibility `mode: 'edge'` / `YOAL_EDGE_NODE_ID`
   nodes. The compatibility first ingress stays first and `setEdge` keeps working; a demoted edge
   with no stored `ingress` role leaves the set (D98 semantics).
3. **The desired-state payload is a new optional `ingress` field**, rendered only for a set member
   while `INGRESS_SET` is on and stripped by the capability gate for any agent without
   `ingress-set`. It carries `listeners` (`:443`, plus `<privateAddress>:8080` when the node has an
   overlay address), `tls` (`email`, optional `ca`; public data) and `platform` (`host`, upstream).
   No secret is in it. `nodeCapabilities` now advertises `ingress-set`, which is what makes the
   field reachable.
4. **Platform route:** a node that is the edge/control node dials its own
   `YOAL_PLATFORM_UPSTREAM` (default `unix//run/yoal/control.sock`). Any other ingress relays to
   the first ingress over HTTPS, with the platform host as SNI; the agent's Caddy config adds the
   TLS transport to the compiled platform route (the compiler in `packages/site-config` was not
   edited). The control-node upstream list of CLUSTERING §6.4/H17 is W9; this relay is the W6
   bridge.
5. **Shared secrets through activation:** new `GET /api/agent/ingress/activation` (node token),
   returning `accessJwtSecret`, `siteCookieSecret` and the optional `cloudflareApiToken`. The agent
   caches it 0600 as `<dataDir>/ingress-secrets.json`, loads it at start, refreshes every six hours
   and retries a failed first fetch after a minute; the access-secret and token override the env
   values. The **control plane** must have `YOAL_ACCESS_JWT_SECRET`, `YOAL_ACME_EMAIL` and
   optionally `YOAL_CLOUDFLARE_API_TOKEN`/`_FILE` in its own environment (previously those were
   documented as agent-only). The site-cookie secret is delivered and cached as H20 asks, but the
   agent does not otherwise read it: route site keys already arrive in `routes[].access.siteKey`.
6. **Redeemed-token cache:** `UsedTokenCache` gained an optional file, written atomically with 0600
   and reloaded on start. Persistence is best effort (a failed write keeps the in-memory cache
   correct); the token lifetime still bounds the file.
7. **Worker listeners:** the agent merges `config.caddyListen` with the desired listeners instead
   of replacing it with `:443`. A worker that gained the role keeps `<overlay>:8080` (other
   ingresses proxy its app copies there) and adds `:443`. With no desired listeners the old
   `[':443']`/env behaviour is unchanged.
8. **Cross-node proxy address:** while `INGRESS_SET` is on, the route/gateway/storage/registry
   helpers prefer `<privateAddress>:8080` over the recorded public address, so a second ingress
   reaches an edge's Caddy over the overlay rather than its public :80 redirect. Flag off keeps
   `publicAddress`, which is why the golden is unchanged.
9. **Drift is reported, not acted on.** `IngressSetService.drift()`, `drifted()` and the
   `IngressNodeView` fields expose `actualStateVersion`/`drifted`; withdrawing a drifted node from
   rotation is the steering drivers' write (lanes D/E), which this lane deliberately did not touch.
10. Files not touched: `packages/site-config/src/compile.ts` (lane C), certificate custody
    (lane B), steering drivers (lanes D/E), migration 0122, and `VERSION`. No new daemon, no
    helper shell verb, no secret in desired state or audit.

## 4. Final commit

Branch: `ha/w2-a-ingress-payload` (not merged to `ha/integration`, not pushed).

- Code and tests: `229ddac9e83b9f57a2244f24459e0bb065b1d1ff`
- Final (this hand-off): the tip of the branch; print it with `git log -1 --format=%H`.
