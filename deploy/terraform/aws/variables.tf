# Inputs for Yoal on AWS (HA-PLAN H27, W14): four instances across three availability zones behind
# a Network Load Balancer.

variable "name" {
  description = "Prefix for every resource name. Lower-case letters, digits and dashes."
  type        = string
  default     = "yoal"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "name must be lower-case letters, digits or dashes, starting with a letter."
  }
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-2"
}

variable "availability_zones" {
  description = "Three availability zones in region. A node's `zone` is an index into this list."
  type        = list(string)
  default     = ["eu-west-2a", "eu-west-2b", "eu-west-2c"]
}

variable "vpc_cidr" {
  description = "VPC range. Subnet i is the /24 at index i + 1."
  type        = string
  default     = "10.42.0.0/16"
}

variable "nodes" {
  description = <<-EOT
    The machines, keyed by node name. `zone` indexes availability_zones (0, 1, 2). `roles` are
    the Yoal roles to give the node under Nodes > Edit node after it joins (no installer flag
    yet). Nodes with the `ingress` role are balancer targets. `private_ip` must sit in its zone's
    subnet (10.42.<zone + 1>.0/24 by default).
  EOT
  type = map(object({
    zone          = number
    roles         = list(string)
    private_ip    = string
    instance_type = optional(string)
  }))
  default = {
    "node-a" = { zone = 0, roles = ["control", "ingress"], private_ip = "10.42.1.10" }
    "node-b" = { zone = 0, roles = ["ingress", "compute", "data"], private_ip = "10.42.1.11" }
    "node-c" = { zone = 1, roles = ["ingress", "compute", "data"], private_ip = "10.42.2.12" }
    "node-d" = { zone = 2, roles = ["ingress", "compute", "data"], private_ip = "10.42.3.13" }
  }
  validation {
    condition = alltrue([
      for node in values(var.nodes) :
      contains([0, 1, 2], node.zone) && length(node.roles) > 0 &&
      alltrue([for role in node.roles : contains(["ingress", "control", "compute", "data", "build"], role)])
    ])
    error_message = "Each node needs zone 0, 1 or 2 and roles from ingress, control, compute, data, build."
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

variable "instance_type" {
  description = "Default instance type; a node's `instance_type` overrides it."
  type        = string
  default     = "m7i.large"
}

variable "ssh_public_key" {
  description = "OpenSSH public key for the admin user (admin on Debian AMIs)."
  type        = string
}

variable "admin_cidrs" {
  description = "Source ranges allowed to SSH to the instances. Empty: none."
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

variable "health_interval_seconds" {
  description = "Target group health check interval. 5 is the NLB minimum."
  type        = number
  default     = 5
}

variable "health_timeout_seconds" {
  description = "Health check timeout."
  type        = number
  default     = 2
}

variable "unhealthy_threshold" {
  description = "Failed checks before a target is unhealthy. 2 x 5 s fits the 15 s bound."
  type        = number
  default     = 2
  validation {
    condition     = var.unhealthy_threshold >= 2 && var.unhealthy_threshold * var.health_interval_seconds + var.health_timeout_seconds <= 15
    error_message = "interval x unhealthy_threshold + timeout must stay within the 15 s bound: 5 s x 2 + 2 s = 12 s (NLB minimum threshold is 2)."
  }
}

variable "proxy_protocol" {
  description = <<-EOT
    Send PROXY protocol v2. Not needed with instance targets, which keep the client address.
    Turn it on only after Yoal has ingress.proxyProtocol "v2" and trustedProxies set to the
    subnet ranges (see the README).
  EOT
  type        = bool
  default     = false
}

# --- Optional DNS ------------------------------------------------------------------------------

variable "route53_zone_id" {
  description = "A Route 53 hosted zone for platform_host, content_domain and *.content_domain. Empty: manage DNS yourself."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags on every resource."
  type        = map(string)
  default     = { app = "yoal" }
}
