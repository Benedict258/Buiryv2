# Off-site logical backups (docs/OPERATIONS.md): a daily scheduled ECS task runs scripts/backup/backup.sh from the
# backup image and writes encrypted pg_dump archives to S3. For real off-site protection put the bucket in a
# separate AWS account or region (set backup_bucket_region, or move this file to that account's configuration).
# Prepared offline; nothing applied.

variable "backup_image" {
  type        = string
  default     = ""
  description = "Backup image (Dockerfile.backup) pinned by digest; empty disables the scheduled backup task."
}

variable "backup_retention_days" {
  type        = number
  default     = 35
  description = "Days logical dumps are kept (S3 lifecycle), chosen by the owner."
}

variable "backup_schedule" {
  type        = string
  default     = "cron(15 2 * * ? *)"
  description = "EventBridge Scheduler expression for the daily dump (UTC)."
}

resource "aws_kms_key" "backups" {
  description         = "${local.name} logical backups"
  enable_key_rotation = true
  tags                = local.tags
}

resource "aws_s3_bucket" "backups" {
  bucket_prefix = "${local.name}-backups-"
  tags          = local.tags
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backups.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "retention"
    status = "Enabled"
    filter {
      prefix = "db/"
    }
    expiration {
      days = var.backup_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

resource "aws_cloudwatch_log_group" "backup" {
  name              = "/buiry/${var.environment}/backup"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_iam_role" "backup_task" {
  name               = "${local.name}-backup-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "backup_task" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.backups.arn}/db/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]
    resources = [aws_kms_key.backups.arn]
  }
}

resource "aws_iam_role_policy" "backup_task" {
  name   = "write-backups"
  role   = aws_iam_role.backup_task.id
  policy = data.aws_iam_policy_document.backup_task.json
}

resource "aws_ecs_task_definition" "backup" {
  count                    = var.backup_image == "" ? 0 : 1
  family                   = "${local.name}-backup"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.backup_task.arn
  container_definitions = jsonencode([{
    name      = "backup"
    image     = var.backup_image
    essential = true
    environment = [
      { name = "BACKUP_S3_URI", value = "s3://${aws_s3_bucket.backups.bucket}/db" },
      { name = "BACKUP_KMS_KEY_ID", value = aws_kms_key.backups.arn },
    ]
    secrets = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.app["DATABASE_URL"].arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.backup.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "backup"
      }
    }
  }])
  tags = local.tags
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  count              = var.backup_image == "" ? 0 : 1
  name               = "${local.name}-backup-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "scheduler_run" {
  count = var.backup_image == "" ? 0 : 1
  statement {
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.backup[0].arn]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.backup_task.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_run" {
  count  = var.backup_image == "" ? 0 : 1
  name   = "run-backup"
  role   = aws_iam_role.scheduler[0].id
  policy = data.aws_iam_policy_document.scheduler_run[0].json
}

resource "aws_scheduler_schedule" "backup" {
  count                        = var.backup_image == "" ? 0 : 1
  name                         = "${local.name}-backup"
  schedule_expression          = var.backup_schedule
  schedule_expression_timezone = "UTC"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler[0].arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.backup[0].arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.app.id]
        assign_public_ip = false
      }
    }
  }
}

# A failed backup run logs "[backup]" lines without "done"; the task exit code is visible in ECS. Alert on errors.
resource "aws_cloudwatch_log_metric_filter" "backup_failed" {
  name           = "${local.name}-backup-failed"
  log_group_name = aws_cloudwatch_log_group.backup.name
  pattern        = "?ERROR ?error ?refusing ?\"must\""
  metric_transformation {
    name      = "BackupFailures"
    namespace = "Buiry/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "backup_failed" {
  alarm_name          = "${local.name}-backup-failures"
  namespace           = "Buiry/${var.environment}"
  metric_name         = "BackupFailures"
  statistic           = "Sum"
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  period              = 86400
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = local.tags
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.bucket
}
