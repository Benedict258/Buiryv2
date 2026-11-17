output "alb_dns_name" {
  value       = aws_lb.main.dns_name
  description = "Point the domain (CNAME or alias) here."
}

output "acm_validation_records" {
  value       = aws_acm_certificate.main.domain_validation_options
  description = "DNS records to create so ACM can issue the certificate."
}

output "db_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "db_master_secret_arn" {
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
  description = "RDS-managed master password; build DATABASE_URL from it (sslmode=require)."
}

output "migrate_task_definition" {
  value = aws_ecs_task_definition.app["migrate"].arn
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
