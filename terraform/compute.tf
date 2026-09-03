# Latest Ubuntu 24.04 AMI from Canonical's public SSM parameter. Architecture
# follows the instance type: Graviton families (t4g, m7g, c7g, …) end in "g"
# after the family prefix -> arm64; everything else -> amd64.
locals {
  ubuntu_arch = endswith(split(".", var.instance_type)[0], "g") ? "arm64" : "amd64"
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/${local.ubuntu_arch}/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.name
  key_name               = var.key_name != "" ? var.key_name : null

  # Installs Docker + the compose plugin on first boot; the app bring-up
  # (deploy/box-setup.sh) is a separate step you run over SSM/SSH.
  user_data = file("${path.module}/../deploy/user-data.sh")

  # IMDSv2 required, hop limit 2 so Docker containers can reach the metadata
  # endpoint for the instance role's Bedrock credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  tags = { Name = var.project }

  # This instance holds the ONLY copy of the Postgres data (docker volumes on the
  # root EBS volume, which is delete_on_termination). Two guards:
  #
  # 1. ignore_changes = [ami] — Canonical ships new Ubuntu AMIs regularly, and a
  #    changed `ami` FORCES REPLACEMENT. Without this, an unrelated `apply` (e.g.
  #    adding SES) silently destroys the box and the database. New AMIs are picked
  #    up by deliberately rebuilding, not as a side effect.
  # 2. prevent_destroy — turns any plan that would destroy this instance into an
  #    error instead of data loss. To intentionally rebuild: remove this line (or
  #    run `terraform apply -replace=aws_instance.app`) AFTER backing up Postgres.
  lifecycle {
    ignore_changes  = [ami]
    prevent_destroy = true
  }
}

# Stable public IP so DNS (once you have a domain) doesn't chase the instance.
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"
  tags     = { Name = var.project }
}
