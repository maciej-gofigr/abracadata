# Use the account's default VPC + a public subnet unless one is passed in.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

locals {
  subnet_id = var.subnet_id != "" ? var.subnet_id : sort(data.aws_subnets.default.ids)[0]
}

resource "aws_security_group" "app" {
  name        = "${var.project}-app"
  description = "Prestidata: HTTP/HTTPS in, everything out. SSH optional."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP (Caddy serves + redirects to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.http_ingress_cidr]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.http_ingress_cidr]
  }

  # SSH only when a CIDR is provided; otherwise reach the box via SSM.
  dynamic "ingress" {
    for_each = var.ssh_ingress_cidr != "" ? [var.ssh_ingress_cidr] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    description = "All outbound (GHCR pulls, Bedrock, ACME/TLS, apt)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-app" }
}
