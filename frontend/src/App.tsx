import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

type ContentItem = {
  id: string; title: string; locale: string; body: string; status: "draft" | "queued" | "published";
  updated_at: string; latest_export_partner?: string | null; latest_export_status?: string | null; latest_export_detail?: string | null;
};
type ExportJob = { id: string; content_id: string; partner: string; status: string; detail?: string; updated_at: string };

const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const demoMode = import.meta.env.VITE_PARTNER_EXPORT_MODE !== "live";
const partners = ["free", "google", "siri"] as const;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export default function App() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [jobs, setJobs] = useState<Record<string, ExportJob>>({});
  const [title, setTitle] = useState("");
  const [locale, setLocale] = useState("en-GB");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [partner, setPartner] = useState<(typeof partners)[number]>("free");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");

  const loadItems = async () => {
    try { setItems(await request<ContentItem[]>("/api/content")); setError(""); }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to load content."); }
  };

  useEffect(() => {
    void loadItems();
    const stream = new EventSource(`${API}/api/events`);
    stream.addEventListener("export-status", (event) => {
      const job = JSON.parse((event as MessageEvent).data) as ExportJob;
      setJobs((current) => ({ ...current, [job.content_id]: job }));
      setAnnouncement(`Export to ${job.partner} is ${job.status}${job.detail ? `: ${job.detail}` : "."}`);
      void loadItems();
    });
    stream.onerror = () => setError("Live status is reconnecting. Your saved content remains available.");
    return () => stream.close();
  }, []);

  const publishedCount = useMemo(() => items.filter((item) => item.status === "published").length, [items]);

  async function createContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const saved = await request<ContentItem>(editingId ? `/api/content/${editingId}` : "/api/content", {
        method: editingId ? "PUT" : "POST", body: JSON.stringify({ title, locale, body })
      });
      setTitle(""); setBody(""); setEditingId(null); setAnnouncement(`${saved.title} draft saved.`); await loadItems();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to save content."); }
    finally { setBusy(false); }
  }

  async function publish(item: ContentItem) {
    setBusy(true); setError("");
    try {
      const job = await request<ExportJob>(`/api/content/${item.id}/publish`, { method: "POST", body: JSON.stringify({ partner }) });
      setJobs((current) => ({ ...current, [item.id]: job })); await loadItems();
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to queue export."); }
    finally { setBusy(false); }
  }

  function edit(item: ContentItem) {
    setEditingId(item.id); setTitle(item.title); setLocale(item.locale); setBody(item.body); setError("");
    setJobs((current) => { const next = { ...current }; delete next[item.id]; return next; });
    document.getElementById("content-title")?.focus();
  }

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="#home" aria-label="Streamline home"><span className="brand-mark">S</span><span>streamline<span className="brand-dot">.</span></span></a>
      <span className="environment"><i /> Editorial workspace</span>
      <div className="avatar" aria-label="Workspace user">VP</div>
    </header>

    <section className="hero" id="home">
      <div className="hero-copy"><p className="eyebrow">CONTENT DISTRIBUTION · LIVE WORKSPACE</p>
        <h1>One story.<br /><em>Every destination.</em></h1>
        <p className="intro">Create localized content and follow each partner delivery as it happens.</p>
      </div>
      <div className="hero-stats"><div><strong>{items.length.toString().padStart(2, "0")}</strong><span>Content items</span></div><div><strong>{publishedCount.toString().padStart(2, "0")}</strong><span>Published</span></div><div><strong>LIVE</strong><span>Export updates</span></div></div>
      <div className="orb orb-one"/><div className="orb orb-two"/>
    </section>
    <div className={`mode-banner ${demoMode ? "demo" : "live-mode"}`} role="note">
      {demoMode
        ? "DEMO MODE — partner exports are simulated locally. Nothing is sent to Free, Google, or Siri."
        : "LIVE MODE — exports go only to partner endpoints configured for this deployment."}
    </div>

    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {error && <div className="notice" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error message">×</button></div>}

    <div className="workspace">
      <section className="panel editor-panel">
        <div className="section-heading"><div><p className="eyebrow">{editingId ? "EDIT EDITORIAL" : "NEW EDITORIAL"}</p><h2>{editingId ? "Edit content" : "Create content"}</h2></div><span className="step">01 / 02</span></div>
        <form onSubmit={createContent}>
          <label>Content title<input id="content-title" required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekend highlights" /></label>
          <div className="form-row"><label>Language<select value={locale} onChange={(e) => setLocale(e.target.value)}><option value="en-GB">English (UK)</option><option value="fr-FR">French</option><option value="es-ES">Spanish</option></select></label><label>Partner destination<select value={partner} onChange={(e) => setPartner(e.target.value as typeof partner)}><option value="free">Free</option><option value="google">Google</option><option value="siri">Siri</option></select></label></div>
          <label>Story<textarea required maxLength={30000} rows={7} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write the content that will be sent to your selected destination…" /></label>
          <div className="form-footer"><span>{body.length.toLocaleString()} / 30,000 characters</span><div className="form-actions">{editingId && <button className="secondary" type="button" onClick={() => { setEditingId(null); setTitle(""); setBody(""); }}>Cancel</button>}<button className="primary" disabled={busy}>{busy ? "Saving…" : editingId ? "Save changes" : "Save draft"}<span aria-hidden="true">↗</span></button></div></div>
        </form>
      </section>

      <section className="panel feed-panel">
        <div className="section-heading"><div><p className="eyebrow">CONTENT LIBRARY</p><h2>Recent stories</h2></div><span className="live-pill"><i/> Live</span></div>
        {items.length === 0 ? <div className="empty"><div className="empty-icon">✳</div><h3>Your workspace is ready</h3><p>Create a draft to start a partner distribution workflow.</p></div> : <div className="story-list">{items.map((item) => {
          const job = jobs[item.id];
          const exportStatus = job?.status ?? item.latest_export_status;
          const exportPartner = job?.partner ?? item.latest_export_partner;
          const exportDetail = job?.detail ?? item.latest_export_detail;
          return <article className="story" key={item.id}>
            <div className="story-top"><span className="locale-tag">{item.locale}</span><span className={`status status-${exportStatus ?? item.status}`}>{exportStatus ?? item.status}</span></div>
            <h3>{item.title}</h3><p className="story-excerpt">{item.body}</p>
            <div className="story-bottom"><span>{new Date(item.updated_at).toLocaleString()}</span>{exportPartner && <span className="job-detail">{exportPartner} · {exportDetail ?? exportStatus}</span>}
              <button className="secondary" disabled={item.status === "queued"} onClick={() => edit(item)}>Edit</button>
              <button className="publish-button" disabled={busy || item.status === "queued"} aria-label={`${item.status === "queued" ? "Publishing" : item.status === "published" ? "Publish again" : "Publish"}: ${item.title} to ${partner}`} onClick={() => void publish(item)}>{item.status === "queued" ? "Publishing…" : item.status === "published" ? "Publish again" : "Publish"}<span aria-hidden="true">→</span></button>
            </div>
          </article>;
        })}</div>}
      </section>
    </div>
    <footer><span>Streamline Content Studio</span><span>Editorial workflow · Partner exports · Live status</span></footer>
  </main>;
}
