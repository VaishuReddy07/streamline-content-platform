import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { resolveQueueUrl, sqs } from "./aws.js";

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const allowedPartners = new Set(["free", "google", "siri"]);

app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:5173" }));
app.use(express.json({ limit: "100kb" }));

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

app.get("/api/content", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT content_items.*,
            latest.partner AS latest_export_partner,
            latest.status AS latest_export_status,
            latest.detail AS latest_export_detail
     FROM content_items
     LEFT JOIN LATERAL (
       SELECT partner, status, detail
       FROM export_jobs
       WHERE content_id = content_items.id
       ORDER BY created_at DESC
       LIMIT 1
     ) AS latest ON TRUE
     ORDER BY content_items.updated_at DESC
     LIMIT 100`
  );
  res.json(rows);
});

app.post("/api/content", async (req, res) => {
  const { title, locale, body } = req.body ?? {};
  if (typeof title !== "string" || !title.trim() || title.length > 160 ||
      typeof locale !== "string" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(locale) ||
      typeof body !== "string" || !body.trim() || body.length > 30000) {
    res.status(400).json({ error: "Provide a title, a locale such as en or fr-FR, and content (up to 30,000 characters)." });
    return;
  }
  const { rows } = await pool.query(
    "INSERT INTO content_items(title, locale, body) VALUES ($1, $2, $3) RETURNING *",
    [title.trim(), locale, body.trim()]
  );
  res.status(201).json(rows[0]);
});

app.put("/api/content/:id", async (req, res) => {
  const { title, locale, body } = req.body ?? {};
  if (typeof title !== "string" || !title.trim() || title.length > 160 ||
      typeof locale !== "string" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(locale) ||
      typeof body !== "string" || !body.trim() || body.length > 30000) {
    res.status(400).json({ error: "Provide a title, a locale such as en or fr-FR, and content (up to 30,000 characters)." });
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    res.status(404).json({ error: "Content item not found." });
    return;
  }
  const { rows } = await pool.query(
    `UPDATE content_items SET title = $2, locale = $3, body = $4,
       status = 'draft', updated_at = NOW()
     WHERE id = $1 AND status <> 'queued' RETURNING *`,
    [req.params.id, title.trim(), locale, body.trim()]
  );
  if (!rows[0]) {
    const existing = await pool.query("SELECT status FROM content_items WHERE id = $1", [req.params.id]);
    if (existing.rows[0]?.status === "queued") {
      res.status(409).json({ error: "This item is being published. Wait for the export to finish before editing it." });
      return;
    }
    res.status(404).json({ error: "Content item not found." });
    return;
  }
  res.json(rows[0]);
});

app.post("/api/content/:id/publish", async (req, res) => {
  const partner = req.body?.partner;
  if (typeof partner !== "string" || !allowedPartners.has(partner)) {
    res.status(400).json({ error: "Choose a supported destination: Free, Google, or Siri." });
    return;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    res.status(404).json({ error: "Content item not found." });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const item = await client.query("SELECT id, title, locale, body, status FROM content_items WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!item.rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Content item not found." });
      return;
    }
    if (item.rows[0].status === "queued") {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This item is already being published." });
      return;
    }
    const job = await client.query(
      "INSERT INTO export_jobs(content_id, partner) VALUES ($1, $2) RETURNING *",
      [req.params.id, partner]
    );
    await client.query("UPDATE content_items SET status = 'queued', updated_at = NOW() WHERE id = $1", [req.params.id]);
    await client.query(
      "INSERT INTO event_outbox(event_type, payload) VALUES ($1, $2::jsonb)",
      ["partner.export.requested", JSON.stringify({ exportJobId: job.rows[0].id, partner, content: item.rows[0] })]
    );
    await client.query("COMMIT");
    res.status(202).json(job.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Unable to enqueue content export", error);
    res.status(503).json({ error: "The export could not be queued. Please try again." });
  } finally {
    client.release();
  }
});

// Publish committed outbox events to SQS. Row locks let multiple API replicas
// dispatch concurrently while preserving a single owner for each pending row.
let dispatching = false;
async function dispatchOutbox() {
  if (dispatching) return;
  dispatching = true;
  try {
    const client = await pool.connect();
    let pending: Array<{ id: string; payload: unknown; attempts: number }> = [];
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        `WITH candidates AS (
           SELECT id FROM event_outbox
           WHERE sent_at IS NULL AND available_at <= NOW()
             AND (locked_until IS NULL OR locked_until < NOW())
           ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED
         )
         UPDATE event_outbox AS event SET locked_until = NOW() + INTERVAL '1 minute'
         FROM candidates WHERE event.id = candidates.id
         RETURNING event.id, event.payload, event.attempts`
      );
      pending = claimed.rows;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (pending.length === 0) return;
    const queueUrl = await resolveQueueUrl();
    for (const event of pending) {
      try {
        await sqs.send(new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(event.payload),
          MessageAttributes: { eventId: { DataType: "String", StringValue: event.id } }
        }));
        await pool.query("UPDATE event_outbox SET sent_at = NOW(), locked_until = NULL, last_error = NULL WHERE id = $1", [event.id]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Queue dispatch failed";
        await pool.query(
          `UPDATE event_outbox SET attempts = attempts + 1, locked_until = NULL, last_error = $2,
           available_at = NOW() + LEAST(INTERVAL '5 minutes', INTERVAL '2 seconds' * POWER(2, LEAST(attempts, 7)))
           WHERE id = $1`,
          [event.id, detail]
        );
      }
    }
  } finally {
    dispatching = false;
  }
}

app.get("/api/events", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const cursor = req.get("Last-Event-ID")?.split("|") ?? [];
  const candidateTime = cursor[0] ?? "";
  const validCursorTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(candidateTime) &&
    !Number.isNaN(new Date(candidateTime).getTime());
  const cursorTime = cursor.length === 2 && validCursorTime
    ? candidateTime : new Date(Date.now() - 30_000).toISOString();
  const cursorId = cursor.length === 2 ? cursor[1] : "00000000-0000-0000-0000-000000000000";
  let since = cursorTime;
  let lastId = /^[0-9a-f-]{36}$/i.test(cursorId) ? cursorId : "00000000-0000-0000-0000-000000000000";
  let sending = false;
  const sendUpdates = async () => {
    if (sending || res.destroyed) return;
    sending = true;
    try {
    const { rows } = await pool.query(
      `SELECT id, content_id, partner, status, detail, updated_at,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
       FROM export_jobs
       WHERE updated_at > $1 OR (updated_at = $1 AND id > $2)
       ORDER BY updated_at ASC, id ASC`,
      [since, lastId]
    );
    for (const job of rows) {
      if (res.destroyed) break;
      since = job.cursor_time;
      lastId = job.id;
      res.write(`id: ${since}|${lastId}\nevent: export-status\ndata: ${JSON.stringify(job)}\n\n`);
    }
    if (rows.length === 0 && !res.destroyed) res.write(": keep-alive\n\n");
    } finally {
      sending = false;
    }
  };
  const timer = setInterval(() => { void sendUpdates().catch(() => { if (!res.destroyed) res.write(": keep-alive\n\n"); }); }, 1500);
  res.on("close", () => clearInterval(timer));
  await sendUpdates();
});

async function start() {
  if (process.env.RUN_SCHEMA_SETUP !== "false") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('streamline-schema'))");
      await client.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  setInterval(() => { void dispatchOutbox().catch((error) => console.error("Outbox dispatch cycle failed", error)); }, 1000);
  void dispatchOutbox().catch((error) => console.error("Initial outbox dispatch failed", error));
  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => console.log(`Streamline API listening on ${port}`));
}

void start().catch((error) => {
  console.error("API startup failed", error);
  process.exit(1);
});
