# Yoal on Hetzner Cloud (HA-PLAN H27, W14): four servers across eu-central locations, one private
# network, one Load Balancer with the S9 (cloud) health check. Yoal is installed by cloud-init
# (deploy/cloud-init) running the public installer and /install/node.sh, as an operator would.
# Two applies: the first machine, then (with join tokens) the others. See README.md.

provider "hcloud" {}

locals {
  first       = var.nodes[var.first_node]
  joiners     = { for name, node in var.nodes : name => node if name != var.first_node }
  created     = merge({ (var.first_node) = local.first }, var.create_join_nodes ? local.joiners : {})
  ingress     = { for name, node in local.created : name => node if contains(node.roles, "ingress") }
  subnet      = cidrsubnet(var.ip_range, 8, 1)
  health_path = "/.well-known/yoal/health"
  user_labels = merge(var.labels, { yoal-stack = var.name })
}

resource "hcloud_network" "yoal" {
  name     = "${var.name}-net"
  ip_range = var.ip_range
  labels   = local.user_labels
}

resource "hcloud_network_subnet" "nodes" {
  network_id   = hcloud_network.yoal.id
  type         = "cloud"
  network_zone = var.network_zone
  ip_range     = local.subnet
}

resource "hcloud_ssh_key" "admin" {
  name       = "${var.name}-admin"
  public_key = var.ssh_public_key
  labels     = local.user_labels
}

# Applies to the public interface only. The balancer reaches the nodes over the private network,
# so nothing public is open but SSH from admin_cidrs. S9 recommended closing public 443/8099.
resource "hcloud_firewall" "nodes" {
  name   = "${var.name}-nodes"
  labels = local.user_labels

  dynamic "rule" {
    for_each = length(var.admin_cidrs) > 0 ? [1] : []
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = "22"
      source_ips = var.admin_cidrs
    }
  }
}

# --- Machines ----------------------------------------------------------------------------------

resource "hcloud_server" "first" {
  name         = "${var.name}-${var.first_node}"
  server_type  = coalesce(local.first.server_type, var.server_type)
  image        = var.image
  location     = local.first.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.nodes.id]
  labels       = merge(local.user_labels, { yoal-node = var.first_node })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  network {
    network_id = hcloud_network.yoal.id
    ip         = local.first.private_ip
  }

  user_data = templatefile("${path.module}/../../cloud-init/first-machine.yaml.tftpl", {
    install_url          = var.install_url
    channel              = var.channel
    platform_host        = var.platform_host
    content_domain       = var.content_domain
    acme_email           = var.acme_email
    admin_email          = var.admin_email
    skip_dns_check       = tostring(var.skip_dns_check)
    features             = join(",", var.features)
    key_vault_secret_uri = ""
    identity_client_id   = ""
    token_wait_minutes   = tostring(var.token_wait_minutes)
    zone                 = local.first.location
    roles                = join(",", local.first.roles)
  })

  lifecycle {
    # Cloud-init runs once. A later change to its inputs must not replace a running node.
    ignore_changes = [user_data, ssh_keys]
    precondition {
      condition     = contains(keys(var.nodes), var.first_node)
      error_message = "first_node must be a key of nodes."
    }
  }

  depends_on = [hcloud_network_subnet.nodes]
}

resource "hcloud_server" "join" {
  for_each     = var.create_join_nodes ? local.joiners : {}
  name         = "${var.name}-${each.key}"
  server_type  = coalesce(each.value.server_type, var.server_type)
  image        = var.image
  location     = each.value.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  firewall_ids = [hcloud_firewall.nodes.id]
  labels       = merge(local.user_labels, { yoal-node = each.key })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  network {
    network_id = hcloud_network.yoal.id
    ip         = each.value.private_ip
  }

  user_data = templatefile("${path.module}/../../cloud-init/join-machine.yaml.tftpl", {
    control_origin  = "https://${var.platform_host}"
    control_address = local.first.private_ip
    node_name       = each.key
    join_token      = lookup(var.join_tokens, each.key, "")
    endpoint        = each.value.private_ip
    wait_minutes    = tostring(var.join_wait_minutes)
    zone            = each.value.location
    roles           = join(",", each.value.roles)
  })

  lifecycle {
    # The token is single-use: dropping it from join_tokens later must not replace the node.
    ignore_changes = [user_data, ssh_keys]
  }

  depends_on = [hcloud_network_subnet.nodes, hcloud_server.first]
}

locals {
  server_ids = merge(
    { (var.first_node) = hcloud_server.first.id },
    { for name, server in hcloud_server.join : name => server.id },
  )
}

# --- Load balancer: the shape S9 (cloud) tested ------------------------------------------------

resource "hcloud_load_balancer" "yoal" {
  name               = "${var.name}-lb"
  load_balancer_type = var.lb_type
  location           = var.lb_location
  labels             = local.user_labels

  algorithm {
    type = "least_connections"
  }
}

resource "hcloud_load_balancer_network" "yoal" {
  load_balancer_id = hcloud_load_balancer.yoal.id
  subnet_id        = hcloud_network_subnet.nodes.id
  ip               = var.lb_private_ip
}

resource "hcloud_load_balancer_target" "ingress" {
  for_each         = local.ingress
  type             = "server"
  load_balancer_id = hcloud_load_balancer.yoal.id
  server_id        = local.server_ids[each.key]
  use_private_ip   = true

  depends_on = [hcloud_load_balancer_network.yoal]
}

# TCP pass-through on 443 and 80: TLS ends on the ingress. Probes hit the plain health port
# without a PROXY header (S9 saw them come from the balancer's private address).
resource "hcloud_load_balancer_service" "web" {
  for_each         = toset(["443", "80"])
  load_balancer_id = hcloud_load_balancer.yoal.id
  protocol         = "tcp"
  listen_port      = tonumber(each.value)
  destination_port = tonumber(each.value)
  proxyprotocol    = var.proxy_protocol

  health_check {
    protocol = "http"
    port     = var.health_port
    interval = var.health_interval_seconds
    timeout  = var.health_timeout_seconds
    retries  = var.health_retries

    http {
      path         = local.health_path
      status_codes = ["200"]
    }
  }
}
