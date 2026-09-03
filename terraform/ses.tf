# Email sending for passwordless sign-in codes.
#
# Verifying the DOMAIN (rather than a single address) lets us send from any
# address at it and sets up DKIM signing, which materially improves deliverability.
# After `terraform apply`, publish the `ses_dns_records` output at your DNS host;
# verification completes automatically once those records resolve.
#
# NOTE: new SES accounts start in the sandbox (you can only send to verified
# addresses). Request production access in the SES console — see docs/DEPLOY.md.

variable "mail_domain" {
  description = "Domain to send sign-in emails from. Empty disables SES setup."
  type        = string
  default     = "abracadata.me"
}

resource "aws_sesv2_email_identity" "mail" {
  count                  = var.mail_domain == "" ? 0 : 1
  email_identity         = var.mail_domain
  configuration_set_name = aws_sesv2_configuration_set.mail[0].configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Tracks bounces/complaints — SES requires keeping these low to stay in good standing.
resource "aws_sesv2_configuration_set" "mail" {
  count                  = var.mail_domain == "" ? 0 : 1
  configuration_set_name = "${var.project}-mail"

  reputation_options {
    reputation_metrics_enabled = true
  }
  sending_options {
    sending_enabled = true
  }
}

# Let the EC2 instance role send mail (no static credentials on the box).
resource "aws_iam_role_policy" "ses_send" {
  count = var.mail_domain == "" ? 0 : 1
  name  = "ses-send"
  role  = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendEmail", "ses:SendRawEmail"]
      Resource = "*"
    }]
  })
}


# Read-only Cost Explorer access so the admin page can show month-to-date spend.
# NOTE: ce:GetCostAndUsage is billed per request (~$0.01), so the app caches the
# result rather than calling it on every page load.
resource "aws_iam_role_policy" "cost_explorer" {
  name = "cost-explorer-read"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ce:GetCostAndUsage"]
      Resource = "*"
    }]
  })
}
