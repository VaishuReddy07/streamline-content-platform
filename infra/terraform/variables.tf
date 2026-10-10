variable "name" {
  description = "Prefix for Streamline AWS resources."
  type        = string
  default     = "streamline"
}

variable "aws_region" {
  description = "AWS region for the SQS queues and IAM roles."
  type        = string
  default     = "eu-west-3"
}

variable "eks_oidc_provider_arn" {
  description = "ARN of the IAM OIDC provider registered for the existing EKS cluster."
  type        = string
}

variable "eks_oidc_issuer_hostpath" {
  description = "EKS OIDC issuer host and path without https://, used in IRSA trust conditions."
  type        = string

  validation {
    condition     = !startswith(var.eks_oidc_issuer_hostpath, "https://") && length(trimspace(var.eks_oidc_issuer_hostpath)) > 0
    error_message = "Provide the EKS OIDC issuer host/path without the https:// prefix."
  }
}

variable "kubernetes_namespace" {
  description = "Namespace containing the Streamline workloads."
  type        = string
  default     = "streamline"
}

variable "api_service_account" {
  description = "Service account used by the API deployment."
  type        = string
  default     = "streamline-api"
}

variable "worker_service_account" {
  description = "Service account used by the export worker deployment."
  type        = string
  default     = "streamline-worker"
}
