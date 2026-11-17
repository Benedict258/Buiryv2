variable "region" {
  type        = string
  description = "AWS region, chosen by the owner."
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "domain_name" {
  type        = string
  description = "Public host name of the dashboard and API, e.g. buiry.example.com (DNS validation for ACM)."
}

variable "image" {
  type        = string
  description = "Container image reference, pinned by digest (repository@sha256:...)."
}

variable "sui_network" {
  type        = string
  description = "testnet or mainnet; must match the Walrus account and the Tatum key."
  validation {
    condition     = contains(["testnet", "mainnet"], var.sui_network)
    error_message = "sui_network must be testnet or mainnet."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "container_port" {
  type    = number
  default = 8787
}

variable "task_cpu" {
  type    = number
  default = 512
}

variable "task_memory" {
  type    = number
  default = 1024
}

variable "api_count" {
  type    = number
  default = 2
}

variable "worker_count" {
  type    = number
  default = 1
}

variable "db_engine_major" {
  type        = string
  default     = "16"
  description = "Postgres major version; check what RDS offers in the region before applying."
}

variable "db_instance_class" {
  type        = string
  description = "RDS instance class, chosen by the owner (cost)."
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_max_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_backup_retention_days" {
  type        = number
  default     = 14
  description = "Automated backup retention (point-in-time recovery window), chosen by the owner."
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "alarm_email" {
  type    = string
  default = ""
}

variable "secret_names" {
  type        = list(string)
  description = "Secrets Manager entries injected as environment variables; values are set out of band."
  default = [
    "DATABASE_URL",
    "BUIRY_SECRET_KEY",
    "WALRUS_RELAYER_URL",
    "WALRUS_ACCOUNT_ID",
    "WALRUS_DELEGATE_KEY",
    "TATUM_API_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
  ]
}
