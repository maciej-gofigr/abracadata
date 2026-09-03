output "public_ip" {
  description = "Elastic IP — point your domain's A record here."
  value       = aws_eip.app.public_ip
}

output "instance_id" {
  description = "EC2 instance id."
  value       = aws_instance.app.id
}

output "app_url_http" {
  description = "Smoke-test URL before DNS/TLS (Caddy serves plain HTTP when DOMAIN is blank)."
  value       = "http://${aws_eip.app.public_ip}/"
}

output "ssm_command" {
  description = "Open a keyless shell on the box."
  value       = "aws ssm start-session --target ${aws_instance.app.id} --region ${var.aws_region}"
}

output "ssh_command" {
  description = "SSH in (only if key_name + ssh_ingress_cidr were set)."
  value       = var.key_name != "" ? "ssh ubuntu@${aws_eip.app.public_ip}" : "(SSH disabled — use ssm_command)"
}

output "bring_up" {
  description = "Run this on the box (via ssm_command) to deploy the app."
  value       = "sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/maciej-gofigr/abracadata/main/deploy/box-setup.sh | bash'"
}

output "ses_dns_records" {
  description = "Publish these at your DNS host to verify the domain for sending (3 DKIM CNAMEs)."
  value = var.mail_domain == "" ? [] : [
    for t in aws_sesv2_email_identity.mail[0].dkim_signing_attributes[0].tokens : {
      type  = "CNAME"
      host  = "${t}._domainkey.${var.mail_domain}"
      value = "${t}.dkim.amazonses.com"
    }
  ]
}

output "ses_mail_from" {
  description = "Set this as MAIL_FROM in the box's .env once the domain is verified."
  value       = var.mail_domain == "" ? "" : "Abracadata <login@${var.mail_domain}>"
}
