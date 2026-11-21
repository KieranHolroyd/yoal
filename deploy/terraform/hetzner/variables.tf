# Inputs for Yoal on Hetzner Cloud (HA-PLAN H27, W14). Hetzner has no availability zones inside
# a location, so each node's Yoal zone is its location (fsn1, nbg1, hel1), all in the eu-central
# network zone so one private network and one balancer reach them.

variable "name" {
  description = "Prefix for every resource name. Lower-case letters, digits and dashes."
  type        = string
  default     = "yoal"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name must be lower-case letters, digits or dashes, starting with a letter."
  }
}

variable "network_zone" {
  description = "Hetzner network zone every location below belongs to."
  type        = string
  default     = "eu-central"
}

variable "ip_range" {
  description = "Private network range. Nodes and the balancer use the first /24."
  type        = string
  default     = "10.41.0.0/16"
}

variable "nodes" {
  description = <<-EOT
    The machines, keyed by node name. `location` doubles as the Yoal zone. `roles` are the Yoal
    roles to give the node under Nodes > Edit node after it joins (no installer flag yet). Nodes
    with the `ingress` role are balancer targets.
  EOT
  type = map(object({
    location    = string
    roles       = list(string)
    private_ip  = string
    server_type = optional(string)
  }))
  default = {
    "node-a" = { location = "hel1", roles = ["control", "ingress"], private_ip = "10.41.1.10" }
    "node-b" = { location = "hel1", roles = ["ingress", "compute", "data"], private_ip = "10.41.1.11" }
    "node-c" = { location = "fsn1", roles = ["ingress", "compute", "data"], private_ip = "10.41.1.12" }
    "node-d" = { location = "nbg1", roles = ["ingress", "compute", "data"], private_ip = "10.41.1.13" }
  }
  validation {
    condition = alltrue([
      for node in values(var.nodes) :
      length(node.roles) > 0 &&
      alltrue([for role in node.roles : contains(["ingress", "control", "compute", "data", "build"], role)])
    ])
    error_message = "roles must come from ingress, control, compute, data, build."
  }
  validation {
    condition     = alltrue([for key in keys(var.nodes) : can(regex("^[a-z][a-z0-9-]{0,30}$", key))])
    error_message = "Node names must be lower-case letters, digits and dashes."
  }
}

variable "first_node" {
  description = "The node that installs the control plane. Every other node joins it."
  type        = string
  default     = "node-a"
}

variable "server_type" {
  description = "Default server type (check `hcloud server-type list`); a node's `server_type` overrides it."
  type        = string
  default     = "cpx32"
}

variable "image" {
  description = "Server image."
  type        = string
  default     = "debian-13"
}

variable "ssh_public_key" {
  description = "OpenSSH public key for root."
  type        = string
}

variable "admin_cidrs" {
  description = "Source ranges allowed to SSH to the nodes' public addresses. Empty: none."
  type        = list(string)
  default     = []
}

# --- Yoal install inputs (cloud-init). Only flags the installer has today. ---------------------

variable "platform_host" {
  description = "Dashboard, API and MCP domain (installer --platform-host). Point it at the balancer."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$", var.platform_host))
    error_message = "platform_host must be a lower-case DNS name."
  }
}

variable "content_domain" {
  description = "Sites domain (installer --content-domain). Its zone must be on Cloudflare: the wildcard certificate is issued over DNS-01."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$", var.content_domain))
    error_message = "content_domain must be a lower-case DNS name."
  }
}

variable "acme_email" {
  description = "ACME account email (installer --acme-email). Turns on HTTPS, which joining needs."
  type        = string
  validation {
    condition     = can(regex("^[^'\\s]+@[^'\\s]+$", var.acme_email))
    error_message = "acme_email must be an email address."
  }
}

variable "admin_email" {
  description = "Prefills the owner email in the setup wizard (installer --admin-email). Optional."
  type        = string
  default     = ""
  validation {
    condition     = var.admin_email == "" || can(regex("^[^'\\s]+@[^'\\s]+$", var.admin_email))
    error_message = "admin_email must be empty or an email address."
  }
}

variable "channel" {
  description = "Release channel: stable (default) or canary (installer --canary)."
  type        = string
  default     = "stable"
  validation {
    condition     = contains(["stable", "canary"], var.channel)
    error_message = "channel must be stable or canary."
  }
}

variable "install_url" {
  description = "The bootstrap script cloud-init downloads and runs."
  type        = string
  default     = "https://raw.githubusercontent.com/KieranHolroyd/yoal/main/install.sh"
  validation {
    condition     = can(regex("^https://[^'\\s]+$", var.install_url))
    error_message = "install_url must be an https URL."
  }
}

variable "skip_dns_check" {
  description = "Pass --skip-dns-check (for example while DNS still points elsewhere)."
  type        = bool
  default     = false
}

variable "features" {
  description = <<-EOT
    Opt-in YOAL_FEATURE_<NAME> flags to append to /etc/yoal/yoal.env on the first machine, for
    example ["INGRESS_SET", "STEERING"]. Empty by default, which changes nothing. Replaced by
    `yoal ha init --profile ha` once that command exists.
  EOT
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for flag in var.features : can(regex("^[A-Z0-9_]+$", flag))])
    error_message = "Feature names are upper-case letters, digits and underscores, without the YOAL_FEATURE_ prefix."
  }
}

variable "token_wait_minutes" {
  description = "How long the first machine waits for the Cloudflare token before giving up."
  type        = number
  default     = 30
}

variable "create_join_nodes" {
  description = "Create the joining VMs. Turn on in the second apply, with one fresh token per node in join_tokens."
  type        = bool
  default     = false
}

variable "join_tokens" {
  description = <<-EOT
    One single-use join token per joining node, keyed by node name, from Nodes > Enroll node or
    POST /api/v1/nodes/join-token. Tokens expire after an hour and are consumed on use. A node
    without a token boots and prints the join command instead.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
  validation {
    condition     = alltrue([for token in values(var.join_tokens) : can(regex("^[A-Za-z0-9_-]+$", token))])
    error_message = "Join tokens contain only letters, digits, dashes and underscores."
  }
}

variable "join_wait_minutes" {
  description = "How long a joining machine waits for the control plane to answer."
  type        = number
  default     = 45
}

# --- Balancer: the S9 (cloud) Hetzner numbers -----------------------------------------------

variable "lb_location" {
  description = "Balancer location, in network_zone."
  type        = string
  default     = "hel1"
}

variable "lb_type" {
  description = "Balancer type. S9 measured lb11."
  type        = string
  default     = "lb11"
}

variable "lb_private_ip" {
  description = "The balancer's fixed private address. It is the one entry ingress.trustedProxies needs."
  type        = string
  default     = "10.41.1.5"
}

variable "proxy_protocol" {
  description = <<-EOT
    Send PROXY protocol to the ingress nodes. Leave false for the first apply. Turn it on only
    after Yoal has ingress.proxyProtocol "v2" and ingress.trustedProxies set to the balancer's
    private address (see the README): before that, Caddy reads the header as a broken TLS hello.
  EOT
  type        = bool
  default     = false
}

variable "health_port" {
  description = "The plain HTTP port every ingress answers /.well-known/yoal/health on (ingress.healthPort; default 8099)."
  type        = number
  default     = 8099
}

# S9 (cloud): the tightest values the Hetzner API accepts. A silently dead node was out in 4.6-7.9 s,
# a crashed Caddy in at most 4.7 s.
variable "health_interval_seconds" {
  description = "Health check interval. Hetzner's minimum, 3, is what S9 measured."
  type        = number
  default     = 3
}

variable "health_timeout_seconds" {
  description = "Health check timeout. S9 used 1."
  type        = number
  default     = 1
}

variable "health_retries" {
  description = "Retries after a failed check before a target is unhealthy. Hetzner's minimum, 1, is what S9 measured."
  type        = number
  default     = 1
  validation {
    # A failed check plus `retries` more: (retries + 1) failures. 3 s x 2 + 1 s = 7 s.
    condition = (
      var.health_retries >= 1 && var.health_interval_seconds >= 3 && var.health_timeout_seconds >= 1 &&
      var.health_interval_seconds * (var.health_retries + 1) + var.health_timeout_seconds <= 15
    )
    error_message = "interval x (retries + 1) + timeout must stay within the 15 s bound (Hetzner minimums: interval 3, timeout 1, retries 1)."
  }
}

variable "labels" {
  description = "Labels on every resource."
  type        = map(string)
  default     = { app = "yoal" }
}
