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
