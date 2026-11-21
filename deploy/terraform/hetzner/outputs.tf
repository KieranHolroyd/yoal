output "lb_public_ipv4" {
  description = "Point platform_host, content_domain and *.content_domain here."
  value       = hcloud_load_balancer.yoal.ipv4
}

output "lb_public_ipv6" {
  description = "The balancer's IPv6 address, for AAAA records."
  value       = hcloud_load_balancer.yoal.ipv6
}

output "lb_private_ip" {
  description = "The only entry ingress.trustedProxies needs (S9 cloud): probes and proxied connections come from it."
  value       = hcloud_load_balancer_network.yoal.ip
}

output "node_private_ips" {
  description = "Private addresses, used as each node's WireGuard endpoint."
  value       = { for name, node in var.nodes : name => node.private_ip }
}

output "node_public_ipv4" {
  description = "Public addresses of the created servers (SSH from admin_cidrs only)."
  value = merge(
    { (var.first_node) = hcloud_server.first.ipv4_address },
    { for name, server in hcloud_server.join : name => server.ipv4_address },
  )
}

output "ingress_settings" {
  description = "PATCH /api/v1/cluster/config body for this balancer, before turning proxy_protocol on."
  value = {
    steering = { driver = "external-lb" }
    ingress = {
      proxyProtocol  = "v2"
      trustedProxies = ["${hcloud_load_balancer_network.yoal.ip}/32"]
      drainSeconds   = 20
    }
  }
}

output "object_store" {
  description = "Not created: the hcloud provider has no Object Storage resource."
  value       = "Create a bucket in Hetzner Object Storage (or any S3 store) by hand; see README.md."
}
