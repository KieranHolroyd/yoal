# Inputs for the Azure reference shape (HA-PLAN R1, section 8). The module only creates machines,
# a balancer, a bucket and optional DNS; Yoal itself is installed by cloud-init with the same
# commands an operator would type.

variable "name" {
  description = "Prefix for every resource name. Lower-case letters, digits and dashes."
  type        = string
  default     = "yoal"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}$", var.name))
    error_message = "name must be 2-15 lower-case letters, digits or dashes, starting with a letter."
  }
}

variable "location" {
  description = "Azure region with availability zones, for example uksouth."
  type        = string
  default     = "uksouth"
}

variable "address_space" {
  description = "Virtual network range. The node subnet is the first /24."
  type        = string
  default     = "10.40.0.0/16"
}

variable "nodes" {
  description = <<-EOT
    The machines, keyed by node name. `zone` is the Azure availability zone ("1", "2" or "3").
    `roles` are the Yoal roles to give the node under Nodes > Edit node after it joins (the
    installer has no roles flag yet). Nodes with the `ingress` role sit behind the balancer.
  EOT
  type = map(object({
    zone       = string
    roles      = list(string)
    private_ip = string
    size       = optional(string)
  }))
  default = {
    "node-a" = { zone = "1", roles = ["control", "ingress"], private_ip = "10.40.1.10" }
    "node-b" = { zone = "1", roles = ["ingress", "compute", "data"], private_ip = "10.40.1.11" }
    "node-c" = { zone = "2", roles = ["ingress", "compute", "data"], private_ip = "10.40.1.12" }
    "node-d" = { zone = "3", roles = ["ingress", "compute", "data"], private_ip = "10.40.1.13" }
  }
  validation {
    condition = alltrue([
      for node in values(var.nodes) :
      contains(["1", "2", "3"], node.zone) &&
      length(node.roles) > 0 &&
      alltrue([for role in node.roles : contains(["ingress", "control", "compute", "data", "build"], role)])
    ])
    error_message = "Each node needs zone 1, 2 or 3 and roles from ingress, control, compute, data, build."
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

variable "vm_size" {
  description = "Default VM size; a node's `size` overrides it."
  type        = string
  default     = "Standard_D2s_v5"
}

variable "image" {
  description = "Debian 13 marketplace image."
  type = object({
    publisher = string
    offer     = string
    sku       = string
    version   = string
  })
  default = {
    publisher = "Debian"
    offer     = "debian-13"
    sku       = "13-gen2"
    version   = "latest"
  }
}

variable "admin_username" {
  description = "SSH user on every VM."
  type        = string
  default     = "yoal"
}

variable "ssh_public_key" {
  description = "OpenSSH public key for admin_username."
  type        = string
}

variable "admin_cidrs" {
  description = "Source ranges allowed to SSH through the balancer (port 2200 + node index). Empty: no SSH from outside."
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

variable "key_vault" {
  description = <<-EOT
    Create a Key Vault the first machine reads the Cloudflare DNS-01 token from, through its
    managed identity. You put the secret in after apply (see the README); it never enters
    Terraform state or user data. Off: copy the token to /etc/caddy/cloudflare.token over SSH.
  EOT
  type        = bool
  default     = true
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
    One single-use join token per joining node, keyed by node name, from `yoal nodes enrol --roles`,
    Nodes > Enroll node or POST /api/v1/nodes/join-token. The token must allow the node's roles, or
    its join is refused. Tokens expire after an hour and are consumed on use. A node
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

# --- Balancer (HA-PLAN section 1.2: out of rotation in 15 s) -----------------------------------

variable "health_port" {
  description = "The plain HTTP port every ingress answers /.well-known/yoal/health on (ingress.healthPort; default 8099)."
  type        = number
  default     = 8099
}

variable "probe_interval_seconds" {
  description = "Probe interval. Azure's minimum is 5 s."
  type        = number
  default     = 5
  validation {
    condition     = var.probe_interval_seconds >= 5
    error_message = "Azure's minimum probe interval is 5 s."
  }
}

# Azure has no probe timeout setting. The bound below counts one more interval as the timeout,
# the longest a probe to a node that stopped answering can take before the next one is due.
variable "probe_threshold" {
  description = "Consecutive failed probes before Azure stops sending new connections."
  type        = number
  default     = 2
  validation {
    condition     = var.probe_threshold >= 1 && var.probe_interval_seconds * var.probe_threshold + var.probe_interval_seconds <= 15
    error_message = "interval x failures + timeout (one interval on Azure) must stay within the 15 s bound: 5 s x 2 + 5 s = 15 s."
  }
}

# --- Object store and arbiter ------------------------------------------------------------------

variable "storage_replication" {
  description = "Storage account replication. ZRS survives a zone; GZRS adds a second region."
  type        = string
  default     = "ZRS"
}

variable "retention_days" {
  description = "Soft-delete retention for blobs and containers (with versioning on, for forensics)."
  type        = number
  default     = 30
}

# --- Optional DNS ------------------------------------------------------------------------------

variable "dns_zone_name" {
  description = <<-EOT
    An Azure DNS zone to create A records in for platform_host, content_domain and
    *.content_domain, pointing at the balancer. Empty: manage DNS yourself. The sites wildcard
    certificate still needs the content domain's zone on Cloudflare today.
  EOT
  type        = string
  default     = ""
}

variable "dns_zone_resource_group" {
  description = "Resource group of dns_zone_name."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags on every resource."
  type        = map(string)
  default     = { app = "yoal" }
}
