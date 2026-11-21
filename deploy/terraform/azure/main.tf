# Yoal on Azure: the HA-PLAN R1 shape in one region, three zones (HA-PLAN H27, W14).
#
# Creates machines, a Standard Load Balancer, a storage account for the platform object store and
# the arbiter, and optional DNS. Yoal is installed by cloud-init (deploy/cloud-init) running the
# public installer and /install/node.sh, exactly as an operator would. Nothing here is a Yoal code
# path. Two applies: the first machine, then (with join tokens) the others. See README.md.

provider "azurerm" {
  features {}
}

locals {
  first   = var.nodes[var.first_node]
  joiners = { for name, node in var.nodes : name => node if name != var.first_node }
  # Created nodes: the first always, the others once create_join_nodes is on.
  created     = merge({ (var.first_node) = local.first }, var.create_join_nodes ? local.joiners : {})
  ssh_index   = { for index, name in sort(keys(var.nodes)) : name => index }
  subnet_cidr = cidrsubnet(var.address_space, 8, 1)
  zone_label  = { for name, node in var.nodes : name => "${var.location}-${node.zone}" }
  health_path = "/.well-known/yoal/health"
}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_resource_group" "yoal" {
  name     = "${var.name}-rg"
  location = var.location
  tags     = var.tags
}

# --- Network -----------------------------------------------------------------------------------

resource "azurerm_virtual_network" "yoal" {
  name                = "${var.name}-vnet"
  resource_group_name = azurerm_resource_group.yoal.name
  location            = azurerm_resource_group.yoal.location
  address_space       = [var.address_space]
  tags                = var.tags
}

resource "azurerm_subnet" "nodes" {
  name                 = "nodes"
  resource_group_name  = azurerm_resource_group.yoal.name
  virtual_network_name = azurerm_virtual_network.yoal.name
  address_prefixes     = [local.subnet_cidr]
}

# Azure's default rules already allow the balancer's probes (AzureLoadBalancer, 168.63.129.16)
# and traffic inside the virtual network, which carries the WireGuard overlay (UDP 51820).
resource "azurerm_network_security_group" "nodes" {
  name                = "${var.name}-nodes"
  resource_group_name = azurerm_resource_group.yoal.name
  location            = azurerm_resource_group.yoal.location
  tags                = var.tags

  security_rule {
    name                       = "web"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_address_prefix      = "Internet"
    source_port_range          = "*"
    destination_address_prefix = "*"
    destination_port_ranges    = ["80", "443"]
  }

  dynamic "security_rule" {
    for_each = length(var.admin_cidrs) > 0 ? [1] : []
    content {
      name                       = "ssh"
      priority                   = 110
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_address_prefixes    = var.admin_cidrs
      source_port_range          = "*"
      destination_address_prefix = "*"
      destination_port_range     = "22"
    }
  }
}

resource "azurerm_subnet_network_security_group_association" "nodes" {
  subnet_id                 = azurerm_subnet.nodes.id
  network_security_group_id = azurerm_network_security_group.nodes.id
}

# --- Load balancer -----------------------------------------------------------------------------

resource "azurerm_public_ip" "lb" {
  name                = "${var.name}-lb"
  resource_group_name = azurerm_resource_group.yoal.name
  location            = azurerm_resource_group.yoal.location
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = ["1", "2", "3"]
  tags                = var.tags
}

resource "azurerm_lb" "yoal" {
  name                = "${var.name}-lb"
  resource_group_name = azurerm_resource_group.yoal.name
  location            = azurerm_resource_group.yoal.location
  sku                 = "Standard"
  tags                = var.tags

  frontend_ip_configuration {
    name                 = "public"
    public_ip_address_id = azurerm_public_ip.lb.id
  }
}

# Ingress nodes receive traffic; every node uses the balancer for outbound (apt, GitHub, ACME).
resource "azurerm_lb_backend_address_pool" "ingress" {
  name            = "ingress"
  loadbalancer_id = azurerm_lb.yoal.id
}

resource "azurerm_lb_backend_address_pool" "outbound" {
  name            = "outbound"
  loadbalancer_id = azurerm_lb.yoal.id
}

# The health endpoint on the plain port: no TLS, no SNI, no PROXY header. 200 only when Caddy is
# up, routes are converged, releases are present and certificates are loaded; 503 while draining.
resource "azurerm_lb_probe" "health" {
  name                = "yoal-health"
  loadbalancer_id     = azurerm_lb.yoal.id
  protocol            = "Http"
  port                = var.health_port
  request_path        = local.health_path
  interval_in_seconds = var.probe_interval_seconds
  probe_threshold     = var.probe_threshold
}

# Layer 4 and pass-through: TLS ends on the ingress, and Azure keeps the client's source address,
# so Yoal needs neither PROXY protocol nor trusted proxies (ingress.proxyProtocol "off").
resource "azurerm_lb_rule" "web" {
  for_each                       = { https = 443, http = 80 }
  name                           = each.key
  loadbalancer_id                = azurerm_lb.yoal.id
  protocol                       = "Tcp"
  frontend_port                  = each.value
  backend_port                   = each.value
  frontend_ip_configuration_name = "public"
  backend_address_pool_ids       = [azurerm_lb_backend_address_pool.ingress.id]
  probe_id                       = azurerm_lb_probe.health.id
  disable_outbound_snat          = true
  tcp_reset_enabled              = true
  idle_timeout_in_minutes        = 15
}

resource "azurerm_lb_outbound_rule" "all" {
  name                     = "outbound"
  loadbalancer_id          = azurerm_lb.yoal.id
  protocol                 = "All"
  backend_address_pool_id  = azurerm_lb_backend_address_pool.outbound.id
  allocated_outbound_ports = 8000

  frontend_ip_configuration {
    name = "public"
  }
}

resource "azurerm_lb_nat_rule" "ssh" {
  for_each                       = length(var.admin_cidrs) > 0 ? var.nodes : {}
  name                           = "ssh-${each.key}"
  resource_group_name            = azurerm_resource_group.yoal.name
  loadbalancer_id                = azurerm_lb.yoal.id
  protocol                       = "Tcp"
  frontend_port                  = 2200 + local.ssh_index[each.key]
  backend_port                   = 22
  frontend_ip_configuration_name = "public"
}

# --- Machines ----------------------------------------------------------------------------------

resource "azurerm_network_interface" "node" {
  for_each            = local.created
  name                = "${var.name}-${each.key}"
  resource_group_name = azurerm_resource_group.yoal.name
  location            = azurerm_resource_group.yoal.location
  tags                = var.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.nodes.id
    private_ip_address_allocation = "Static"
    private_ip_address            = each.value.private_ip
  }
}

resource "azurerm_network_interface_backend_address_pool_association" "ingress" {
  for_each                = { for name, node in local.created : name => node if contains(node.roles, "ingress") }
  network_interface_id    = azurerm_network_interface.node[each.key].id
  ip_configuration_name   = "primary"
  backend_address_pool_id = azurerm_lb_backend_address_pool.ingress.id
}

resource "azurerm_network_interface_backend_address_pool_association" "outbound" {
  for_each                = local.created
  network_interface_id    = azurerm_network_interface.node[each.key].id
  ip_configuration_name   = "primary"
  backend_address_pool_id = azurerm_lb_backend_address_pool.outbound.id
}

resource "azurerm_network_interface_nat_rule_association" "ssh" {
  for_each              = length(var.admin_cidrs) > 0 ? local.created : {}
  network_interface_id  = azurerm_network_interface.node[each.key].id
  ip_configuration_name = "primary"
  nat_rule_id           = azurerm_lb_nat_rule.ssh[each.key].id
}

# The first machine's identity: reads the Cloudflare token from Key Vault; full access to the
# platform container for when Yoal's Azure store accepts a managed identity.
resource "azurerm_user_assigned_identity" "control" {
  name                = "${var.name}-control"
  resource_group_name = azurerm_resource_group.yoal.name
  location            = azurerm_resource_group.yoal.location
  tags                = var.tags
}

# Every other node's identity: lease writes under yoal/ha/ only (HA-PLAN section 10).
resource "azurerm_user_assigned_identity" "arbiter" {
  name                = "${var.name}-arbiter"
  resource_group_name = azurerm_resource_group.yoal.name
  location            = azurerm_resource_group.yoal.location
  tags                = var.tags
}

resource "azurerm_linux_virtual_machine" "first" {
  name                            = "${var.name}-${var.first_node}"
  computer_name                   = var.first_node
  resource_group_name             = azurerm_resource_group.yoal.name
  location                        = azurerm_resource_group.yoal.location
  zone                            = local.first.zone
  size                            = coalesce(local.first.size, var.vm_size)
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.node[var.first_node].id]
  tags                            = merge(var.tags, { yoal-node = var.first_node })

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.control.id]
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 64
  }

  source_image_reference {
    publisher = var.image.publisher
    offer     = var.image.offer
    sku       = var.image.sku
    version   = var.image.version
  }

  custom_data = base64encode(templatefile("${path.module}/../../cloud-init/first-machine.yaml.tftpl", {
    install_url          = var.install_url
    channel              = var.channel
    platform_host        = var.platform_host
    content_domain       = var.content_domain
    acme_email           = var.acme_email
    admin_email          = var.admin_email
    skip_dns_check       = tostring(var.skip_dns_check)
    features             = join(",", var.features)
    key_vault_secret_uri = var.key_vault ? "${azurerm_key_vault.yoal[0].vault_uri}secrets/cloudflare-dns-token" : ""
    identity_client_id   = azurerm_user_assigned_identity.control.client_id
    token_wait_minutes   = tostring(var.token_wait_minutes)
    zone                 = local.zone_label[var.first_node]
    roles                = join(",", local.first.roles)
  }))

  lifecycle {
    # Cloud-init runs once. A later change to its inputs must not replace a running node.
    ignore_changes = [custom_data]
    precondition {
      condition     = contains(keys(var.nodes), var.first_node)
      error_message = "first_node must be a key of nodes."
    }
  }
}

resource "azurerm_linux_virtual_machine" "join" {
  for_each                        = var.create_join_nodes ? local.joiners : {}
  name                            = "${var.name}-${each.key}"
  computer_name                   = each.key
  resource_group_name             = azurerm_resource_group.yoal.name
  location                        = azurerm_resource_group.yoal.location
  zone                            = each.value.zone
  size                            = coalesce(each.value.size, var.vm_size)
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.node[each.key].id]
  tags                            = merge(var.tags, { yoal-node = each.key })

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.arbiter.id]
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 128
  }

  source_image_reference {
    publisher = var.image.publisher
    offer     = var.image.offer
    sku       = var.image.sku
    version   = var.image.version
  }

  custom_data = base64encode(templatefile("${path.module}/../../cloud-init/join-machine.yaml.tftpl", {
    control_origin  = "https://${var.platform_host}"
    control_address = local.first.private_ip
    node_name       = each.key
    join_token      = lookup(var.join_tokens, each.key, "")
    endpoint        = each.value.private_ip
    wait_minutes    = tostring(var.join_wait_minutes)
    zone            = local.zone_label[each.key]
    roles           = join(",", each.value.roles)
  }))

  lifecycle {
    # The token is single-use: dropping it from join_tokens later must not replace the node.
    ignore_changes = [custom_data]
  }

  depends_on = [azurerm_linux_virtual_machine.first]
}

# --- Platform object store and arbiter ---------------------------------------------------------

# Versioned, zone-redundant, private. Azure Blob honours If-Match / If-None-Match, which the
# arbiter's conditional writes need.
resource "azurerm_storage_account" "yoal" {
  name                            = "${substr(replace(var.name, "-", ""), 0, 14)}${random_string.suffix.result}"
  resource_group_name             = azurerm_resource_group.yoal.name
  location                        = azurerm_resource_group.yoal.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = var.storage_replication
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  # Yoal's Azure store signs with an account key or a SAS today.
  shared_access_key_enabled = true
  is_hns_enabled            = false
  tags                      = var.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = var.retention_days
    }
    container_delete_retention_policy {
      days = var.retention_days
    }
  }
}

resource "azurerm_storage_container" "platform" {
  name                  = "yoal-platform"
  storage_account_id    = azurerm_storage_account.yoal.id
  container_access_type = "private"
}

resource "azurerm_role_assignment" "control_blob" {
  scope                = azurerm_storage_container.platform.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.control.principal_id
}

# HA-PLAN section 10, "Arbiter credentials": every data node holds them, so they grant nothing
# but reads and writes under the yoal/ha/ prefix. An attribute-based condition limits the role.
resource "azurerm_role_assignment" "arbiter_blob" {
  scope                = azurerm_storage_container.platform.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.arbiter.principal_id
  condition_version    = "2.0"
  condition            = <<-EOT
    (
      (
        !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'})
        AND
        !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'})
        AND
        !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action'})
        AND
        !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete'})
      )
      OR
      (
        @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringStartsWith 'yoal/ha/'
      )
    )
  EOT
}

# --- Key Vault for the Cloudflare DNS-01 token -------------------------------------------------

data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "yoal" {
  count                      = var.key_vault ? 1 : 0
  name                       = "${substr(var.name, 0, 14)}-kv-${random_string.suffix.result}"
  resource_group_name        = azurerm_resource_group.yoal.name
  location                   = azurerm_resource_group.yoal.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = false
  soft_delete_retention_days = 7
  tags                       = var.tags
}

resource "azurerm_role_assignment" "kv_reader" {
  count                = var.key_vault ? 1 : 0
  scope                = azurerm_key_vault.yoal[0].id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.control.principal_id
}

# Lets whoever runs Terraform put the secret in with `az keyvault secret set`.
resource "azurerm_role_assignment" "kv_writer" {
  count                = var.key_vault ? 1 : 0
  scope                = azurerm_key_vault.yoal[0].id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# --- Optional DNS ------------------------------------------------------------------------------

locals {
  # Names relative to the zone; "" is the zone apex.
  dns_platform = trimsuffix(trimsuffix(var.platform_host, var.dns_zone_name), ".")
  dns_content  = trimsuffix(trimsuffix(var.content_domain, var.dns_zone_name), ".")
  dns_names = var.dns_zone_name == "" ? {} : {
    platform = local.dns_platform == "" ? "@" : local.dns_platform
    content  = local.dns_content == "" ? "@" : local.dns_content
    wildcard = local.dns_content == "" ? "*" : "*.${local.dns_content}"
  }
}

resource "azurerm_dns_a_record" "yoal" {
  for_each            = local.dns_names
  name                = each.value
  zone_name           = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group
  ttl                 = 300
  records             = [azurerm_public_ip.lb.ip_address]
  tags                = var.tags

  lifecycle {
    precondition {
      condition     = endswith(var.platform_host, var.dns_zone_name) && endswith(var.content_domain, var.dns_zone_name)
      error_message = "platform_host and content_domain must both be inside dns_zone_name."
    }
  }
}
