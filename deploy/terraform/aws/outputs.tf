output "nlb_dns_name" {
  description = "Point platform_host, content_domain and *.content_domain here (alias or CNAME)."
  value       = aws_lb.yoal.dns_name
}

output "node_private_ips" {
  description = "Private addresses, used as each node's WireGuard endpoint."
  value       = { for name, node in var.nodes : name => node.private_ip }
}

output "node_public_ips" {
  description = "Public addresses of the created instances (SSH from admin_cidrs only)."
  value = merge(
    { (var.first_node) = aws_instance.first.public_ip },
    { for name, instance in aws_instance.join : name => instance.public_ip },
  )
}

# With instance targets and client IP preservation the NLB passes the client's address through,
# so Yoal trusts no proxy. With proxy_protocol on, the NLB's addresses are in these subnets.
output "trusted_proxies" {
  description = "Value for ingress.trustedProxies: empty unless proxy_protocol is on, then the subnet ranges."
  value       = var.proxy_protocol ? aws_subnet.zone[*].cidr_block : []
}

output "ingress_settings" {
  description = "PATCH /api/v1/cluster/config body for this balancer."
  value = {
    steering = { driver = "external-lb" }
    ingress = {
      proxyProtocol  = var.proxy_protocol ? "v2" : "off"
      trustedProxies = var.proxy_protocol ? aws_subnet.zone[*].cidr_block : []
      drainSeconds   = 20
    }
  }
}

output "bucket" {
  description = "Platform object store and arbiter bucket. The arbiter writes under yoal/ha/."
  value       = aws_s3_bucket.platform.bucket
}
