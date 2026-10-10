# Architecture and operating notes

## Request and export flow

The React client creates and edits drafts through the Node.js REST API. Content, export-job state, and outbox events are stored in PostgreSQL. Publishing creates the export job and outbox event in one transaction. A dispatcher leases pending rows, commits the lease, and sends messages to SQS; if it stops, another API instance can reclaim an expired lease. A separate worker consumes messages and passes the content to a partner adapter. Local development uses a mock adapter; an actual partner endpoint can be configured with `PARTNER_FREE_URL`, `PARTNER_GOOGLE_URL`, or `PARTNER_SIRI_URL`. Requests include an idempotency key because queue delivery and partner calls are at least once. The web client follows status changes through an SSE stream backed by PostgreSQL polling and a `Last-Event-ID` cursor.

## Runtime configuration

Required at runtime: `DATABASE_URL`, AWS region/credentials (or an EKS IAM role), and `SQS_QUEUE_NAME`. `AWS_ENDPOINT_URL` is for local AWS emulation only. `RUN_SCHEMA_SETUP` defaults to enabled for local setup; it serializes the idempotent schema initialization with a PostgreSQL advisory lock. In Kubernetes it is disabled: apply `schema.sql` through a migration process before deploying and keep DDL permissions out of the API identity. The Kubernetes manifest expects a pre-created secret named `streamline-runtime` containing `DATABASE_URL`; use EKS IAM Roles for Service Accounts for AWS access rather than static AWS keys.

The local mock mode is for demonstration. It does not represent a real partner integration. LocalStack creates an SQS dead-letter queue and configures a redrive policy for messages the worker cannot process. Production use still requires official partner credentials, authentication and authorization, monitoring/alerting, security review, managed database migrations/backups, and validating least-privilege IAM and SQS redrive settings in the target AWS account.

## Accessibility and device support

The interface is a responsive web app intended to work in mobile browsers, including iOS Safari and Android Chrome. Forms use associated labels and native controls; status updates are announced through semantic status regions. This is not a native iOS or Android application.
