# Streamline — Live Content Authoring & Partner Distribution

Streamline is a portfolio application for creating and editing localized content, then publishing it to partner destinations through an asynchronous workflow. It demonstrates a React/TypeScript interface, a Node.js/TypeScript API, AWS SQS messaging, Docker, Kubernetes deployment resources, and live status updates over Server-Sent Events.

Partner destinations (Free, Google, and Siri) use a local mock adapter by default. They are examples of integration boundaries; this project does not have official partner access or credentials.

## Features

- Create and edit localized content drafts in a keyboard-accessible, responsive authoring UI with screen-reader status announcements.
- Queue partner publishing requests with a PostgreSQL transactional outbox.
- Dispatch jobs through Amazon SQS and process them in a separate worker.
- Retry partner export failures with bounded attempts, route repeatedly unprocessable queue messages to a local dead-letter queue, and make partner requests with an idempotency key.
- Follow export status in near real time with SSE, including reconnect cursors.
- Retain the most recent export destination and result in the content library after a reload.
- Run the complete local stack with Docker Compose and LocalStack.
- Deploy the web, API, and worker workloads to Kubernetes/EKS using the included manifest.
- Use the responsive web app in desktop browsers and Android/iOS mobile browsers. It is not a native mobile app.

## Technology

React, TypeScript, Node.js, Express, PostgreSQL, AWS SQS, LocalStack, Docker, Docker Compose, Kubernetes, Amazon EKS, Nginx, and SSE.

## Run locally

Requirements: Docker Desktop with its Linux engine running, and Docker Compose v2.

```sh
docker compose up --build
```

Open the app at `http://localhost:5173`. The API is available at `http://localhost:4000`; its health endpoint is `http://localhost:4000/healthz`. PostgreSQL is exposed on port `5433` and LocalStack on port `4566`.

Compose starts PostgreSQL, LocalStack, the API, the SQS worker, and the web UI. The web UI clearly indicates demo mode; the worker uses the local mock adapter. To stop the app, run `docker compose down`; to remove local PostgreSQL data as well, run `docker compose down -v`.

## System flow

1. The author creates or edits a draft in the React UI.
2. The API validates the request and stores it in PostgreSQL.
3. On publish, the API stores an export job and an outbox event in one database transaction.
4. The dispatcher claims committed outbox events and sends them to SQS. Leases allow another API replica to resume work after a crash.
5. The worker delivers to a configured partner endpoint or the local mock adapter, then persists the status.
6. The browser receives status changes through SSE and refreshes the affected content.

Delivery is at least once. Partner endpoints should honor the `Idempotency-Key` header. The worker marks partner failures as terminal after five receives; malformed or unhandled queue messages are routed to the LocalStack dead-letter queue. Production SQS queues must be provisioned with a dead-letter queue and suitable redrive policy.

## Kubernetes / AWS deployment

`k8s/base.yaml` contains namespace, configuration, service accounts, API/worker/web deployments, services, health probes, resource requests/limits, and ingress. `infra/terraform` provisions an encrypted SQS queue and DLQ plus least-privilege EKS IRSA roles for the API and worker. It assumes an existing EKS cluster and registered OIDC provider; it does not create the cluster, database, domain, or partner accounts. Review `infra/terraform/README.md` and `terraform plan` before any apply. After infrastructure exists, replace the placeholder image names, ingress host, and IAM role ARNs in the Kubernetes manifest. Provision PostgreSQL, apply `backend/schema.sql` through a managed migration process, and create the `streamline-runtime` secret with `DATABASE_URL` and approved partner endpoint credentials. The Kubernetes config uses live mode so a missing partner endpoint fails visibly instead of reporting a mock delivery. Build the web image with an empty `VITE_API_URL` and `VITE_PARTNER_EXPORT_MODE=live` so the browser uses the same-origin `/api` ingress route and indicates live mode. The API's schema setup is disabled so the runtime identity does not need DDL permissions. Once the prerequisites are configured, render the manifest with `kubectl kustomize k8s` and apply it with `kubectl apply -k k8s`.

These files are a deployment starting point, not evidence that this app has been deployed to AWS. The Terraform provisions SQS and IAM only. Real partner API contracts and credentials, authentication/authorization, an existing EKS cluster, a managed database with backups, TLS/domain configuration, monitoring, formal schema migrations, and operational runbooks are required before production use. No AWS resources are created by this repository's local workflow.

## Project status and honest CV wording

The frontend and backend production builds pass. The local Docker Compose services were started and the PostgreSQL and LocalStack health checks passed. The complete local flow was verified: a demo story was saved, queued through LocalStack SQS, delivered by the worker to the local mock partner adapter, persisted as `published` / `delivered`, and returned by the SSE event stream. The demo story remains in the local database so the workflow is visible when the app is reopened. This has not been deployed to AWS or production, partner destinations are mocked, and the app is not a native Android/iOS application.

Suggested project title: **Live Content Authoring & Partner Distribution Platform**.
