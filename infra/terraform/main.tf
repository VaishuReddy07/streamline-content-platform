locals {
  queue_name    = "${var.name}-partner-exports"
  dlq_name      = "${local.queue_name}-dlq"
  oidc_audience = "${var.eks_oidc_issuer_hostpath}:aud"
  oidc_subject  = "${var.eks_oidc_issuer_hostpath}:sub"
}

resource "aws_sqs_queue" "dead_letter" {
  name                      = local.dlq_name
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "exports" {
  name                       = local.queue_name
  visibility_timeout_seconds = 30
  message_retention_seconds  = 1209600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dead_letter" {
  queue_url = aws_sqs_queue.dead_letter.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.exports.arn]
  })
}

data "aws_iam_policy_document" "api_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.eks_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = local.oidc_audience
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = local.oidc_subject
      values   = ["system:serviceaccount:${var.kubernetes_namespace}:${var.api_service_account}"]
    }
  }
}

data "aws_iam_policy_document" "worker_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.eks_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = local.oidc_audience
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = local.oidc_subject
      values   = ["system:serviceaccount:${var.kubernetes_namespace}:${var.worker_service_account}"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.api_trust.json
}

resource "aws_iam_role" "worker" {
  name               = "${var.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.worker_trust.json
}

data "aws_iam_policy_document" "api_sqs" {
  statement {
    actions   = ["sqs:GetQueueUrl", "sqs:SendMessage"]
    resources = [aws_sqs_queue.exports.arn]
  }
}

data "aws_iam_policy_document" "worker_sqs" {
  statement {
    actions = [
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ReceiveMessage"
    ]
    resources = [aws_sqs_queue.exports.arn]
  }
}

resource "aws_iam_role_policy" "api_sqs" {
  name   = "${var.name}-api-sqs"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api_sqs.json
}

resource "aws_iam_role_policy" "worker_sqs" {
  name   = "${var.name}-worker-sqs"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_sqs.json
}
