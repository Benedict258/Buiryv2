# Buiry on AWS: ECS Fargate (api + worker services, migration task), ALB with ACM TLS, RDS Postgres, Secrets
# Manager, CloudWatch logs and alarms. Prepared offline: `terraform init -backend=false && terraform validate`
# runs without credentials. Nothing here has been applied. See docs/DEPLOYMENT.md before using it.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "buiry-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
  tags = { Project = "buiry", Environment = var.environment }
}

# ---------------- network ----------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = local.name })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = local.tags
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${local.name}-public-${count.index}" })
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = local.azs[count.index]
  tags              = merge(local.tags, { Name = "${local.name}-private-${count.index}" })
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = local.tags
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = local.tags
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = local.tags
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
  tags = local.tags
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------------- security groups ----------------

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_security_group" "app" {
  name   = "${local.name}-app"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_security_group" "db" {
  name   = "${local.name}-db"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
  tags = local.tags
}

# ---------------- database ----------------

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
  tags       = local.tags
}

resource "aws_db_parameter_group" "main" {
  name   = local.name
  family = "postgres${var.db_engine_major}"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  tags = local.tags
}

resource "aws_db_instance" "main" {
  identifier                   = local.name
  engine                       = "postgres"
  engine_version               = var.db_engine_major
  instance_class               = var.db_instance_class
  allocated_storage            = var.db_allocated_storage_gb
  max_allocated_storage        = var.db_max_allocated_storage_gb
  storage_encrypted            = true
  db_name                      = "buiry"
  username                     = "buiry"
  manage_master_user_password  = true
  db_subnet_group_name         = aws_db_subnet_group.main.name
  parameter_group_name         = aws_db_parameter_group.main.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  multi_az                     = var.db_multi_az
  backup_retention_period      = var.db_backup_retention_days
  backup_window                = "03:00-04:00"
  maintenance_window           = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot        = true
  deletion_protection          = true
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${local.name}-final"
  performance_insights_enabled = true
  auto_minor_version_upgrade   = true
  publicly_accessible          = false
  tags                         = local.tags
}

# ---------------- secrets (values are set out of band, never in Terraform) ----------------

resource "aws_secretsmanager_secret" "app" {
  for_each = toset(var.secret_names)
  name     = "${local.name}/${each.value}"
  tags     = local.tags
}

# ---------------- TLS and load balancer ----------------

resource "aws_acm_certificate" "main" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
  tags = local.tags
}

resource "aws_lb" "main" {
  name                       = local.name
  load_balancer_type         = "application"
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 60
  drop_invalid_header_fields = true
  tags                       = local.tags
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path                = "/v1/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 30
  tags                 = local.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.main.arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ---------------- ECS ----------------

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "worker", "migrate"])
  name              = "/buiry/${var.environment}/${each.value}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [for s in aws_secretsmanager_secret.app : s.arn],
      [aws_db_instance.main.master_user_secret[0].secret_arn],
    )
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

locals {
  # Plain settings; everything secret comes from Secrets Manager below.
  environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = tostring(var.container_port) },
    { name = "BUIRY_BASE_URL", value = "https://${var.domain_name}" },
    { name = "BUIRY_ALLOWED_ORIGINS", value = "https://${var.domain_name}" },
    { name = "BUIRY_MAILER", value = "smtp" },
    # One ALB in front: it appends the client address to X-Forwarded-For (SECURITY_REVIEW M1).
    { name = "BUIRY_TRUSTED_PROXY_HOPS", value = "1" },
    { name = "WALRUS_NETWORK", value = var.sui_network },
    { name = "TATUM_NETWORK", value = var.sui_network },
    # Managed-account tenancy (BD42): one named workspace, or managed storage off on the first deploy.
    var.managed_workspace_id == ""
    ? { name = "BUIRY_MANAGED", value = "off" }
    : { name = "BUIRY_MANAGED_WORKSPACE_ID", value = var.managed_workspace_id },
  ]
  secrets = [for n in var.secret_names : { name = n, valueFrom = aws_secretsmanager_secret.app[n].arn }]
  container = {
    image        = var.image
    essential    = true
    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    secrets      = local.secrets
  }
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = { api = "api", worker = "worker", migrate = "migrate" }
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.key == "migrate" ? 256 : var.task_cpu
  memory                   = each.key == "migrate" ? 512 : var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([merge(local.container, {
    name        = "buiry"
    command     = each.key == "migrate" ? ["node", "dist-server/migrate.js"] : null
    environment = concat(local.environment, each.key == "migrate" ? [] : [{ name = "BUIRY_ROLE", value = each.key }])
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  })])
  tags = local.tags
}

resource "aws_ecs_service" "api" {
  name                              = "api"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.app["api"].arn
  desired_count                     = var.api_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "buiry"
    container_port   = var.container_port
  }
  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app["worker"].arn
  desired_count   = var.worker_count
  launch_type     = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }
  tags = local.tags
}

# ---------------- alarms ----------------

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarms = {
    alb-5xx = {
      namespace = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", stat = "Sum", threshold = 10,
      dims      = { LoadBalancer = aws_lb.main.arn_suffix }
    }
    unhealthy-targets = {
      namespace = "AWS/ApplicationELB", metric = "UnHealthyHostCount", stat = "Maximum", threshold = 0,
      dims      = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
    }
    db-cpu = {
      namespace = "AWS/RDS", metric = "CPUUtilization", stat = "Average", threshold = 80,
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }
    }
    db-free-storage = {
      namespace = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", threshold = 2147483648,
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, lower = true
    }
    worker-running = {
      namespace = "ECS/ContainerInsights", metric = "RunningTaskCount", stat = "Minimum", threshold = 1,
      dims      = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.worker.name }, lower = true
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.stat
  threshold           = each.value.threshold
  comparison_operator = try(each.value.lower, false) ? "LessThanThreshold" : "GreaterThanThreshold"
  period              = 300
  evaluation_periods  = 2
  dimensions          = each.value.dims
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = local.tags
}

# Log-based alarm: the server logs "[buiry] job ... failed" when a background job fails.
resource "aws_cloudwatch_log_metric_filter" "job_failed" {
  name           = "${local.name}-job-failed"
  log_group_name = aws_cloudwatch_log_group.app["worker"].name
  pattern        = "\"job\" \"failed\""
  metric_transformation {
    name      = "JobFailures"
    namespace = "Buiry/${var.environment}"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "job_failed" {
  alarm_name          = "${local.name}-job-failures"
  namespace           = "Buiry/${var.environment}"
  metric_name         = "JobFailures"
  statistic           = "Sum"
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  period              = 900
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  tags                = local.tags
}
