import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { Pool } from "pg";
import { resolveQueueUrl, sqs } from "./aws.js";

type ExportMessage = {
  exportJobId: string;
  partner: "free" | "google" | "siri";
  content: { id: string; title: string; locale: string; body: string };
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function deliverToPartner(message: ExportMessage): Promise<string> {
  const endpoint = process.env[`PARTNER_${message.partner.toUpperCase()}_URL`];
  if (!endpoint) {
    if (process.env.PARTNER_EXPORT_MODE !== "mock") {
      throw new Error(`No endpoint configured for ${message.partner}`);
    }
    console.log(`Mock export ${message.exportJobId} -> ${message.partner}: ${message.content.title}`);
    return "Accepted by the local mock partner adapter.";
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Partner adapters should treat retries of the same export as one request.
      "idempotency-key": message.exportJobId
    },
    body: JSON.stringify(message.content),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Partner returned HTTP ${response.status}`);
  return `Partner accepted the export (HTTP ${response.status}).`;
}

async function processMessage(body: string, receiptHandle: string, queueUrl: string, receiveCount: number) {
  let message: ExportMessage | undefined;
  try {
    message = JSON.parse(body) as ExportMessage;
    if (!message.exportJobId || !message.content?.id || !["free", "google", "siri"].includes(message.partner)) {
      throw new Error("Invalid partner export message");
    }
    const previous = await pool.query("SELECT status FROM export_jobs WHERE id = $1", [message.exportJobId]);
    if (previous.rows[0]?.status === "delivered") {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
      return;
    }
    // Keep terminal failures unacknowledged so SQS can redrive them to the DLQ.
    if (previous.rows[0]?.status === "failed") return;
    if (!previous.rowCount) throw new Error("Export job does not exist");
    const claim = await pool.query(
      `UPDATE export_jobs SET status = 'processing', detail = NULL, updated_at = NOW()
       WHERE id = $1 AND (status = 'queued' OR (status = 'processing' AND updated_at < NOW() - INTERVAL '30 seconds'))
       RETURNING id`,
      [message.exportJobId]
    );
    if (!claim.rowCount) return;
    const detail = await deliverToPartner(message);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE export_jobs SET status = 'delivered', detail = $2, updated_at = NOW() WHERE id = $1", [message.exportJobId, detail]);
      await client.query("UPDATE content_items SET status = 'published', updated_at = NOW() WHERE id = $1", [message.content.id]);
      await client.query("COMMIT");
    } catch (stateError) {
      await client.query("ROLLBACK");
      throw stateError;
    } finally {
      client.release();
    }
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown partner export error";
    if (message?.exportJobId) {
      const current = await pool.query("SELECT status FROM export_jobs WHERE id = $1", [message.exportJobId]);
      if (current.rows[0]?.status === "delivered") {
        // Delivery succeeded and only SQS acknowledgement failed; leave the
        // duplicate for redelivery so it can be acknowledged without re-sending.
        console.error(`Export ${message.exportJobId} was delivered but its SQS acknowledgement failed`, detail);
        return;
      }
      const terminal = receiveCount >= 5;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE export_jobs SET status = $2, detail = $3, updated_at = NOW() WHERE id = $1", [message.exportJobId, terminal ? "failed" : "queued", detail]);
        if (terminal) await client.query("UPDATE content_items SET status = 'draft', updated_at = NOW() WHERE id = $1 AND status = 'queued'", [message.content.id]);
        await client.query("COMMIT");
      } catch (stateError) {
        await client.query("ROLLBACK");
        throw stateError;
      } finally {
        client.release();
      }
      // Do not acknowledge terminal failures; SQS redrive moves them to the DLQ.
    }
    // Leave non-terminal failures for the configured SQS retry/redrive policy.
    console.error(`Export ${message?.exportJobId ?? "<invalid message>"} failed`, detail);
  }
}

async function run() {
  const queueUrl = await resolveQueueUrl();
  console.log("Streamline export worker is polling SQS");
  for (;;) {
    try {
      const result = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 10,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"]
      }));
      for (const message of result.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) continue;
        try {
          await processMessage(message.Body, message.ReceiptHandle, queueUrl, Number(message.Attributes?.ApproximateReceiveCount ?? "1"));
        } catch (error) {
          // Leave the message unacknowledged so SQS can retry it or redrive it.
          console.error("Export message handling failed; leaving it for SQS retry", error);
        }
      }
    } catch (error) {
      console.error("SQS polling failed; retrying in five seconds", error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

void run().catch((error) => {
  console.error("Worker stopped", error);
  process.exit(1);
});
