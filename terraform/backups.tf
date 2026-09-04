# Nightly Postgres backups to S3.
#
# The database lives on the instance's root EBS volume, which is
# delete_on_termination — so without this there is exactly one copy of every
# account, saved recipe and admin setting, and losing the box loses all of it.

data "aws_caller_identity" "current" {}

locals {
  # Bucket names are globally unique; the account id keeps this collision-free.
  backup_bucket = "${var.project}-backups-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "backups" {
  bucket = local.backup_bucket

  # Backups are the last line of defence: refuse to destroy them by accident.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioning protects against a corrupted dump overwriting a good one, and
# against an accidental delete.
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    filter {}

    # A month of dailies is plenty to recover from a bad deploy or a mistake
    # that took a few days to notice, and costs pennies at this data size.
    expiration {
      days = 30
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }
}

# Let the box write backups (and read them back for a restore).
resource "aws_iam_role_policy" "backups" {
  name = "s3-backups"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]
      },
    ]
  })
}

output "backup_bucket" {
  description = "S3 bucket holding nightly Postgres dumps."
  value       = aws_s3_bucket.backups.bucket
}
