# Provisioning (optional, outside the core)

HA-PLAN H27 and W14: "Provisioning is optional and outside the core." These files create machines,
a balancer, a bucket and optional DNS, then install Yoal with **the same commands an operator
would type**: the public installer (`install.sh`, flags from `scripts/install/USAGE.txt`) on the
first machine and the `node.sh` line that **Nodes → Enroll node** prints on every other one.
Nothing here is a Yoal code path, and a single-node install never sees it.

| Path | What |
|---|---|
| `cloud-init/first-machine.yaml.tftpl` | Control plane and first ingress: `install.sh --yes --platform-host … --content-domain … --acme-email … --cloudflare-token-file …` |
| `cloud-init/join-machine.yaml.tftpl` | Every other machine: `curl <control>/install/node.sh \| sh -s -- --token … --name … --endpoint …` |
| `cloud-init/cloud-init.test.ts` | Renders both, checks YAML, `sh -n`, and that every flag exists in `USAGE.txt` / `node.sh` |
| `terraform/azure` | The reference (R1): 4 VMs in 3 zones, Standard LB, ZRS storage with versioning, Key Vault, optional Azure DNS |
| `terraform/hetzner` | 4 servers across eu-central locations, private network, LB11 with the S9 (cloud) health check |
| `terraform/aws` | 4 instances in 3 AZs, NLB with an HTTP check, versioned S3, optional Route 53. Validated only |

The balancer settings and where each number comes from are in the user docs page
`packages/docs/content/self-hosting/load-balancers.md`.

## Secrets

No template and no Terraform variable default holds a secret.

- **Join tokens** are template variables (`join_tokens`, sensitive). They are single-use, expire an
  hour after creation, and the joining machine blanks its copy after `node.sh` runs. They do end up
  in Terraform state and the VM's user data until then; both are harmless once the token is used.
- **The Cloudflare DNS-01 token** (the installer refuses HTTPS without it, and joining needs an
  https control URL) never enters Terraform. On Azure, the first machine reads it from Key Vault
  with its managed identity; elsewhere it waits for you to copy it in over SSH.
- **Object-store keys** are not created. The modules create the bucket and scoped identities;
  you add the key Yoal uses by hand (see below).

## Walkthrough (Azure; Hetzner and AWS differ only where noted)

```sh
cd deploy/terraform/azure
terraform init
cat > yoal.auto.tfvars <<'EOF'
ssh_public_key = "ssh-ed25519 AAAA… you@example"
admin_cidrs    = ["203.0.113.7/32"]
platform_host  = "control.example.org"
content_domain = "apps.example.org"
acme_email     = "ops@example.org"
features       = ["INGRESS_SET", "STEERING"]   # until `yoal ha init --profile ha` exists
EOF
terraform apply                       # 1. network, balancer, bucket, Key Vault, the first VM
```

2. **DNS.** Point `platform_host`, `content_domain` and `*.content_domain` at `lb_public_ip`, in
   the Cloudflare zone your DNS-01 token can edit (the sites wildcard certificate is DNS-01 only).
3. **Cloudflare token.** Azure: `az keyvault secret set --id "$(terraform output -raw
   key_vault_secret_id)" --file cloudflare.token` (the first VM polls for it). Hetzner:
   `ssh root@<node-a> 'install -m 600 /dev/stdin /etc/caddy/cloudflare.token' < cloudflare.token`;
   AWS: the same as `admin@<node-a>` with `sudo install …`.
   Follow the install with `ssh … tail -f /var/log/yoal-provision.log`.
4. **Setup.** Open `https://<platform_host>`, finish the wizard (setup token: `sudo cat
   /etc/yoal/setup-token`), create a platform admin API key.
5. **Ingress settings.** `terraform output -json ingress_settings` is the
   `PATCH /api/v1/cluster/config` body for this balancer. **Hetzner:** apply it, then
   `terraform apply -var proxy_protocol=true` **straight away**. Yoal accepts header-less
   connections from a trusted address, so this order never breaks traffic (the reverse order
   does), but until the balancer sends PROXY headers Yoal believes a client-sent
   `X-Forwarded-For` through it, so Access rules can be bypassed in that window.
6. **Put the first machine on the overlay.** The installer enrols it as the edge with host
   networking and no `wg0`; joining nodes only peer with nodes that have an overlay endpoint
   and the `ingress` role. Adopt it onto the managed overlay with its private address as the
   WireGuard endpoint (port 51820 is added):
   ```sh
   NODE_A=$(curl -sS "https://control.example.org/api/v1/nodes" -H "Authorization: Bearer $YOAL_KEY" \
     | python3 -c 'import json,sys; print([n["id"] for n in json.load(sys.stdin)["nodes"] if n["mode"] == "edge"][0])')
   curl -sS -X POST "https://control.example.org/api/v1/nodes/$NODE_A/overlay" \
     -H "Authorization: Bearer $YOAL_KEY" -H 'Content-Type: application/json' \
     -d '{"endpoint":"10.40.1.10"}'   # node-a's private_ip
   ```
   This needs a platform admin key, which exists only after setup, so cloud-init cannot do it.
7. **Join tokens**, one per node, within the hour before the next step:
   ```sh
   for n in node-b node-c node-d; do
     curl -sS -X POST "https://control.example.org/api/v1/nodes/join-token" \
       -H "Authorization: Bearer $YOAL_KEY" -H 'Content-Type: application/json' -d "{\"name\":\"$n\"}"
   done
   ```
   Put them in `join_tokens = { node-b = "…", … }` in a git-ignored `tokens.auto.tfvars`, then
   `terraform apply -var create_join_nodes=true`. A node without a token boots and prints the
   `node.sh` line to run by hand. Each joining machine pins the platform host to node-a's
   private address in `/etc/hosts` for the join only, and removes the pin afterwards.
8. **Zones and roles.** Set each node's zone and roles under **Nodes → Edit node**, or with
   `PATCH /api/v1/nodes/<id>` and `{"zone":"uksouth-2","roles":["ingress","compute","data"]}`
   (the outputs and `/var/log/yoal-provision.log` name the intended ones). Then `yoal ha status`.
9. **Platform store (optional).** `terraform output platform_store_env` gives the non-secret lines
   for `/etc/yoal/yoal.env`; add `YOAL_AZURE_SAS_TOKEN` (or `YOAL_AZURE_ACCOUNT_KEY`) yourself and
   restart `yoal-control-plane`. AWS: the same with the `R2_*` keys and an IAM user's key.
   Hetzner: create the bucket in Object Storage by hand (the `hcloud` provider has no resource).

Re-running `terraform apply` never replaces a running node: `custom_data`/`user_data` changes are
ignored, so removing spent tokens later is safe.

## Installer flags HA-PLAN §8 assumes that do not exist (TODO for lanes A/B or the installer owner)

Each is a `TODO(installer):` comment in the templates, and `cloud-init.test.ts` fails once the
installer gains it, so the template gets wired.

| §8 flag | Where §8 uses it | Today |
|---|---|---|
| `--profile ha` | `install.sh` | No flag. `features` appends `YOAL_FEATURE_INGRESS_SET/STEERING`; later `yoal ha init --profile ha` (lane B) |
| `--zone <zone>` | `install.sh` and `node.sh` | No flag on either. Set under **Nodes → Edit node** |
| `--roles <list>` | `node.sh` | No flag. Set under **Nodes → Edit node** |
| `--object-store azure://<container>` (and `s3://`, `gcs://`) | `install.sh` | `--object-store local\|r2` only. Azure/GCS are env-only (`YOAL_OBJECT_STORE`, `YOAL_AZURE_*`, `YOAL_GCS_*`, behind `OBJECT_STORE_*` flags) |
| `--domain` | `install.sh` | The real flag is `--platform-host` (the templates use it) |

Also missing for a hands-off run: a `node.sh` way to pass the token other than `--token` on the
command line, and an installer or join option that puts the first machine on the overlay (step 6).

**HA-PLAN §10 "Arbiter credentials" is not reached today.** The modules create an arbiter identity
scoped to blob reads, writes and deletes under `yoal/ha/` (Azure: a custom role with only those
four data actions plus an attribute condition; AWS: an IAM role limited to the prefix). Nothing
uses it: Yoal's Azure store signs only with an account key or a SAS, and its S3 store only with
static keys, so whatever key you give Yoal in step 9 covers the whole container or bucket.

## Not verified

- No `terraform plan` or `apply` against any cloud account; no money spent. `terraform validate`
  and `fmt -check` pass for all three modules.
- The bootstrap order (health endpoint on the first machine only after `INGRESS_SET` is on, so
  the balancer has a healthy target) is reasoned from the code, not run.
- Azure LB and AWS NLB timings: not measured (S9 did not run them).
