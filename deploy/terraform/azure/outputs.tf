output "lb_public_ip" {
  description = "Point platform_host, content_domain and *.content_domain here."
  value       = azurerm_public_ip.lb.ip_address
}

output "node_private_ips" {
  description = "Private addresses, used as each node's WireGuard endpoint."
  value       = { for name, node in var.nodes : name => node.private_ip }
}

output "ssh" {
  description = "SSH through the balancer (only with admin_cidrs set)."
  value = length(var.admin_cidrs) == 0 ? {} : {
    for name, index in local.ssh_index : name => "ssh -p ${2200 + index} ${var.admin_username}@${azurerm_public_ip.lb.ip_address}"
  }
}

# Azure Load Balancer has no private address of its own on the data path and keeps the client's
# source address, so Yoal trusts no proxy and reads no PROXY header. Probes come from
# 168.63.129.16 and need neither.
output "trusted_proxies" {
  description = "Value for ingress.trustedProxies: empty, because Azure LB preserves the client address."
  value       = []
}

output "ingress_settings" {
  description = "PATCH /api/v1/cluster/config body for this balancer."
  value = {
    steering = { driver = "external-lb" }
    ingress = {
      proxyProtocol  = "off"
      trustedProxies = []
      drainSeconds   = 20
    }
  }
}

output "storage_account" {
  description = "Platform object store and arbiter account."
  value       = azurerm_storage_account.yoal.name
}

output "storage_container" {
  description = "Platform object store and arbiter container. The arbiter writes under yoal/ha/."
  value       = azurerm_storage_container.platform.name
}

output "platform_store_env" {
  description = "Non-secret lines for /etc/yoal/yoal.env on the first machine; add YOAL_AZURE_SAS_TOKEN or YOAL_AZURE_ACCOUNT_KEY by hand."
  value = {
    YOAL_FEATURE_OBJECT_STORE_AZURE = "1"
    YOAL_OBJECT_STORE               = "azure"
    YOAL_AZURE_ACCOUNT              = azurerm_storage_account.yoal.name
    YOAL_AZURE_CONTAINER            = azurerm_storage_container.platform.name
  }
}

output "key_vault_secret_id" {
  description = "Where the first machine reads the Cloudflare DNS-01 token. Set it with az keyvault secret set."
  value       = var.key_vault ? "${azurerm_key_vault.yoal[0].vault_uri}secrets/cloudflare-dns-token" : null
}

output "identities" {
  description = "Managed identities: control (first machine) and arbiter (every other node, yoal/ha/ only)."
  value = {
    control = azurerm_user_assigned_identity.control.client_id
    arbiter = azurerm_user_assigned_identity.arbiter.client_id
  }
}
