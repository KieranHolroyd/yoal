# Yoal on AWS (HA-PLAN H27, W14): four instances across three availability zones behind a Network
# Load Balancer, an S3 bucket for the platform store and the arbiter, optional Route 53 records.
# Yoal is installed by cloud-init (deploy/cloud-init) running the public installer and
# /install/node.sh, as an operator would. Two applies: the first machine, then the others.
# Not run against an AWS account: see README.md for what is untested.

provider "aws" {
  region = var.region
  default_tags {
    tags = var.tags
  }
}

locals {
  first       = var.nodes[var.first_node]
  joiners     = { for name, node in var.nodes : name => node if name != var.first_node }
  created     = merge({ (var.first_node) = local.first }, var.create_join_nodes ? local.joiners : {})
  ingress     = { for name, node in local.created : name => node if contains(node.roles, "ingress") }
  health_path = "/.well-known/yoal/health"
}

# --- Network -----------------------------------------------------------------------------------

resource "aws_vpc" "yoal" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "yoal" {
  vpc_id = aws_vpc.yoal.id
}

resource "aws_subnet" "zone" {
  count                   = length(var.availability_zones)
  vpc_id                  = aws_vpc.yoal.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 1)
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-${var.availability_zones[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.yoal.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.yoal.id
  }
}

resource "aws_route_table_association" "zone" {
  count          = length(aws_subnet.zone)
  subnet_id      = aws_subnet.zone[count.index].id
  route_table_id = aws_route_table.public.id
}

# Instance targets keep the client's address, so the web ports must be open to clients. The health
# port only to the VPC (the balancer's nodes probe from it); the overlay only between nodes.
resource "aws_security_group" "nodes" {
  name   = "${var.name}-nodes"
  vpc_id = aws_vpc.yoal.id

  ingress {
    description = "web"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "web (ACME, redirects)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "yoal health"
    from_port   = var.health_port
    to_port     = var.health_port
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  ingress {
    description = "between nodes (WireGuard overlay)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }
  dynamic "ingress" {
    for_each = length(var.admin_cidrs) > 0 ? [1] : []
    content {
      description = "ssh"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.admin_cidrs
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- Machines ----------------------------------------------------------------------------------

data "aws_ami" "debian" {
  most_recent = true
  owners      = ["136693071363"] # Debian
  filter {
    name   = "name"
    values = ["debian-13-amd64-*"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "aws_key_pair" "admin" {
  key_name   = "${var.name}-admin"
  public_key = var.ssh_public_key
}

resource "aws_instance" "first" {
  ami                    = data.aws_ami.debian.id
  instance_type          = coalesce(local.first.instance_type, var.instance_type)
  subnet_id              = aws_subnet.zone[local.first.zone].id
  private_ip             = local.first.private_ip
  key_name               = aws_key_pair.admin.key_name
  vpc_security_group_ids = [aws_security_group.nodes.id]
  iam_instance_profile   = aws_iam_instance_profile.control.name
  tags                   = { Name = "${var.name}-${var.first_node}", yoal-node = var.first_node }

  root_block_device {
    volume_size = 64
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
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
    zone                 = var.availability_zones[local.first.zone]
    roles                = join(",", local.first.roles)
  })

  lifecycle {
    # Cloud-init runs once. A later change to its inputs must not replace a running node.
    ignore_changes = [user_data, ami]
    precondition {
      condition     = contains(keys(var.nodes), var.first_node)
      error_message = "first_node must be a key of nodes."
    }
  }
}

resource "aws_instance" "join" {
  for_each               = var.create_join_nodes ? local.joiners : {}
  ami                    = data.aws_ami.debian.id
  instance_type          = coalesce(each.value.instance_type, var.instance_type)
  subnet_id              = aws_subnet.zone[each.value.zone].id
  private_ip             = each.value.private_ip
  key_name               = aws_key_pair.admin.key_name
  vpc_security_group_ids = [aws_security_group.nodes.id]
  iam_instance_profile   = aws_iam_instance_profile.arbiter.name
  tags                   = { Name = "${var.name}-${each.key}", yoal-node = each.key }

  root_block_device {
    volume_size = 128
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
  }

  user_data = templatefile("${path.module}/../../cloud-init/join-machine.yaml.tftpl", {
    control_origin  = "https://${var.platform_host}"
    control_address = local.first.private_ip
    node_name       = each.key
    join_token      = lookup(var.join_tokens, each.key, "")
    endpoint        = each.value.private_ip
    wait_minutes    = tostring(var.join_wait_minutes)
    zone            = var.availability_zones[each.value.zone]
    roles           = join(",", each.value.roles)
  })

  lifecycle {
    # The token is single-use: dropping it from join_tokens later must not replace the node.
    ignore_changes = [user_data, ami]
  }

  depends_on = [aws_instance.first]
}

locals {
  instance_ids = merge(
    { (var.first_node) = aws_instance.first.id },
    { for name, instance in aws_instance.join : name => instance.id },
  )
}

# --- Network Load Balancer ---------------------------------------------------------------------

resource "aws_lb" "yoal" {
  name                             = "${var.name}-nlb"
  load_balancer_type               = "network"
  internal                         = false
  subnets                          = aws_subnet.zone[*].id
  enable_cross_zone_load_balancing = true
}

# TCP pass-through: TLS ends on the ingress. The check is HTTP on the plain health port, which
# answers 503 while a node drains, so the NLB stops new connections before Caddy stops.
resource "aws_lb_target_group" "web" {
  for_each             = { https = 443, http = 80 }
  name                 = "${var.name}-${each.key}"
  port                 = each.value
  protocol             = "TCP"
  vpc_id               = aws_vpc.yoal.id
  target_type          = "instance"
  preserve_client_ip   = true
  proxy_protocol_v2    = var.proxy_protocol
  deregistration_delay = 20

  health_check {
    protocol            = "HTTP"
    port                = tostring(var.health_port)
    path                = local.health_path
    matcher             = "200"
    interval            = var.health_interval_seconds
    timeout             = var.health_timeout_seconds
    healthy_threshold   = 2
    unhealthy_threshold = var.unhealthy_threshold
  }
}

resource "aws_lb_listener" "web" {
  for_each          = { https = 443, http = 80 }
  load_balancer_arn = aws_lb.yoal.arn
  port              = each.value
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web[each.key].arn
  }
}

resource "aws_lb_target_group_attachment" "ingress" {
  for_each = {
    for pair in setproduct(keys(local.ingress), ["https", "http"]) : "${pair[0]}-${pair[1]}" => {
      node     = pair[0]
      listener = pair[1]
    }
  }
  target_group_arn = aws_lb_target_group.web[each.value.listener].arn
  target_id        = local.instance_ids[each.value.node]
}

# --- Platform object store and arbiter ---------------------------------------------------------

resource "aws_s3_bucket" "platform" {
  bucket_prefix = "${var.name}-platform-"
}

resource "aws_s3_bucket_versioning" "platform" {
  bucket = aws_s3_bucket.platform.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "platform" {
  bucket                  = aws_s3_bucket.platform.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "platform" {
  bucket = aws_s3_bucket.platform.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "platform" {
  bucket = aws_s3_bucket.platform.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# The first machine: the whole bucket.
data "aws_iam_policy_document" "control" {
  statement {
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.platform.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.platform.arn}/*"]
  }
}

# HA-PLAN section 10, "Arbiter credentials": every data node holds them, so they grant nothing but
# reads and writes under yoal/ha/.
data "aws_iam_policy_document" "arbiter" {
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.platform.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["yoal/ha/*"]
    }
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.platform.arn}/yoal/ha/*"]
  }
}

resource "aws_iam_role" "control" {
  name               = "${var.name}-control"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy" "control" {
  role   = aws_iam_role.control.id
  policy = data.aws_iam_policy_document.control.json
}

resource "aws_iam_instance_profile" "control" {
  name = "${var.name}-control"
  role = aws_iam_role.control.name
}

resource "aws_iam_role" "arbiter" {
  name               = "${var.name}-arbiter"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy" "arbiter" {
  role   = aws_iam_role.arbiter.id
  policy = data.aws_iam_policy_document.arbiter.json
}

resource "aws_iam_instance_profile" "arbiter" {
  name = "${var.name}-arbiter"
  role = aws_iam_role.arbiter.name
}

# --- Optional DNS ------------------------------------------------------------------------------

resource "aws_route53_record" "yoal" {
  for_each = var.route53_zone_id == "" ? {} : {
    platform = var.platform_host
    content  = var.content_domain
    wildcard = "*.${var.content_domain}"
  }
  zone_id = var.route53_zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_lb.yoal.dns_name
    zone_id                = aws_lb.yoal.zone_id
    evaluate_target_health = true
  }
}
