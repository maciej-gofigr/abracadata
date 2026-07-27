variable "project" {
  description = "Name prefix for all resources."
  type        = string
  default     = "prestidata"
}

variable "aws_region" {
  description = "Region to deploy into. Must be a region where your Bedrock models are enabled."
  type        = string
  default     = "us-east-2"
}

variable "instance_type" {
  description = "EC2 instance type. The Ubuntu AMI architecture auto-follows this (Graviton 't*g*' families -> arm64, else amd64). t3.small = 2 GB amd64; t4g.small = 2 GB ARM."
  type        = string
  default     = "t3.small"
}

variable "root_volume_gb" {
  description = "Root EBS volume size (GB, gp3)."
  type        = number
  default     = 20
}

variable "http_ingress_cidr" {
  description = "CIDR allowed to reach ports 80/443. Public by design (it's a website)."
  type        = string
  default     = "0.0.0.0/0"
}

variable "ssh_ingress_cidr" {
  description = "CIDR allowed to reach port 22. Leave empty to keep SSH closed (use SSM instead)."
  type        = string
  default     = ""
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH. Leave empty for SSM-only (keyless) access."
  type        = string
  default     = ""
}

variable "subnet_id" {
  description = "Public subnet to launch in. Leave empty to auto-pick the first subnet in the default VPC."
  type        = string
  default     = ""
}
