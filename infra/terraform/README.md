# AWS queue and EKS workload identity

This Terraform configuration prepares the AWS messaging and IAM layer for an **existing** EKS cluster. It creates:

- An SQS partner-export queue with SQS-managed encryption, long polling, a 30-second visibility timeout, and redrive after five receives.
- An encrypted dead-letter queue restricted to that export queue as its redrive source.
- Separate EKS IAM Roles for Service Accounts (IRSA) roles: the API can look up and send to the queue; the worker can look up, receive, inspect, and delete messages.

It does **not** create an EKS cluster, PostgreSQL/RDS, container registry, DNS/TLS, authentication, or external partner API access. It does not create anything until an operator reviews and runs `terraform apply` with AWS credentials for the intended account.

## Prerequisites

- Terraform 1.6 or later and the HashiCorp AWS provider (constraint in `versions.tf`).
- AWS CLI credentials for the target account and region.
- An existing EKS cluster with its IAM OIDC provider registered.

Get the EKS issuer URL:

```sh
aws eks describe-cluster --name YOUR_CLUSTER --region eu-west-3 --query "cluster.identity.oidc.issuer" --output text
```

Use the URL without `https://` as `eks_oidc_issuer_hostpath`. Set `eks_oidc_provider_arn` to the ARN of that cluster's IAM OIDC provider. Copy `terraform.tfvars.example` to `terraform.tfvars` and replace the placeholders. The real `terraform.tfvars` and Terraform state are git-ignored.

## Review and provision

From this directory:

```sh
terraform init
terraform fmt -check -recursive
terraform validate
terraform plan -out=streamline.tfplan
terraform show streamline.tfplan
```

Review the plan and confirm the AWS account, region, resource names, and expected charges before provisioning:

```sh
terraform apply streamline.tfplan
```

The apply provisions SQS queues and IAM roles/policies. Save Terraform state in an approved encrypted remote backend before using this for a team or production environment; local state can contain infrastructure metadata and must not be committed.

## Connect Kubernetes

Read the role ARNs and queue name from Terraform outputs:

```sh
terraform output api_irsa_role_arn
terraform output worker_irsa_role_arn
terraform output partner_exports_queue_name
```

Set the two role annotations in `k8s/base.yaml` to the output ARNs. Its queue name already matches the default Terraform queue. Keep `PARTNER_EXPORT_MODE` set to `live`; configure only approved, real partner endpoints and credentials in the `streamline-runtime` Kubernetes Secret. If an endpoint is absent, the worker records a failure rather than claiming a mock delivery.

The EKS role trust policies constrain both the OIDC audience and the exact Kubernetes namespace/service-account subject. This follows AWS guidance to scope IRSA trust to the intended service account: <https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html>.
