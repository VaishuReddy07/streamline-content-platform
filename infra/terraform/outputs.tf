output "partner_exports_queue_name" {
  description = "Set as SQS_QUEUE_NAME in the API and worker runtime configuration."
  value       = aws_sqs_queue.exports.name
}

output "partner_exports_queue_url" {
  description = "URL of the encrypted partner export queue."
  value       = aws_sqs_queue.exports.url
}

output "partner_exports_dlq_url" {
  description = "URL of the export dead-letter queue."
  value       = aws_sqs_queue.dead_letter.url
}

output "api_irsa_role_arn" {
  description = "Set as the streamline-api service account role annotation in Kubernetes."
  value       = aws_iam_role.api.arn
}

output "worker_irsa_role_arn" {
  description = "Set as the streamline-worker service account role annotation in Kubernetes."
  value       = aws_iam_role.worker.arn
}
