# Alarms that recover the box without a human in the loop.
#
# On 2026-09-09 the backend leaked to 1.45 GB on a 2 GB box, the OOM killer took
# uvicorn, and memory pressure wedged the kernel — the instance stopped answering
# its reachability check and stayed down for 2h20m, because the only monitoring
# was somebody visiting the site. These alarms cut that to minutes.

variable "alert_email" {
  description = "Address for infrastructure alarms. Empty disables email (the automatic reboot/recover still happens)."
  type        = string
  default     = "maciej@flagstaff.ai"
}

resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

# NOTE: AWS emails a confirmation link; the subscription stays "pending" (and
# silent) until it is clicked.
resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# The guest OS stopped responding (what happened in the OOM incident). A reboot
# is the correct remedy: the disk is fine, the kernel is not.
resource "aws_cloudwatch_metric_alarm" "instance_wedged" {
  alarm_name          = "${var.project}-instance-status-failed"
  alarm_description   = "Instance reachability failing for 3 minutes — reboot it and tell someone."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"

  # "missing" (not "breaching"): a deliberately stopped instance reports no data,
  # and treating that as a breach would fight anyone trying to keep it stopped.
  treat_missing_data = "missing"

  alarm_actions = concat(
    ["arn:aws:automate:${var.aws_region}:ec2:reboot"],
    aws_sns_topic.alerts[*].arn,
  )
  ok_actions = aws_sns_topic.alerts[*].arn
}

# Underlying AWS hardware failed — reboot can't help; recover migrates the
# instance to a healthy host, keeping the EBS root volume and the Elastic IP.
resource "aws_cloudwatch_metric_alarm" "host_failed" {
  alarm_name          = "${var.project}-system-status-failed"
  alarm_description   = "AWS host-level failure — recover the instance onto new hardware."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"

  alarm_actions = concat(
    ["arn:aws:automate:${var.aws_region}:ec2:recover"],
    aws_sns_topic.alerts[*].arn,
  )
  ok_actions = aws_sns_topic.alerts[*].arn
}

# Early warning. In the OOM incident CPU sat at ~70% for an hour before the
# kernel gave up; a sustained burn is worth a look. Email only — a busy box is
# not necessarily a broken one, so nothing automatic fires here.
resource "aws_cloudwatch_metric_alarm" "cpu_pegged" {
  alarm_name          = "${var.project}-cpu-sustained"
  alarm_description   = "CPU above 80% for 15 minutes — runaway process or a traffic spike."
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = aws_sns_topic.alerts[*].arn
}

output "alerts_topic" {
  description = "SNS topic for infrastructure alarms (confirm the email subscription once)."
  value       = aws_sns_topic.alerts.arn
}
