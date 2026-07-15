/* شكراً معالي الوزير — campaign backend
 * Serves the static site plus:
 *   GET  /api/wall               approved restaurants (public columns only)
 *   GET  /api/logo/:id           logo image (approved only, unless admin token)
 *   POST /api/join               new submission -> status 'pending'
 *   GET  /admin?token=...        moderation page (ADMIN_TOKEN env)
 *   POST /api/admin/:id/:action  approve / reject (token required)
 */
"use strict";

const express = require("express");
const multer = require("multer");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8737;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/svg+xml"];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /sslmode=require/.test(process.env.DATABASE_URL || "")
    ? { rejectUnauthorized: false }
    : undefined,
});

const app = express();
app.disable("x-powered-by");

/* ---------- static site ---------- */
const PRIVATE_PATHS = [/^\/server\.js/, /^\/package(-lock)?\.json/, /^\/db\//, /^\/node_modules\//, /^\/\.git/];
app.use((req, res, next) => {
  if (PRIVATE_PATHS.some((re) => re.test(req.path))) return res.status(404).end();
  next();
});
app.use(express.static(__dirname, { extensions: ["html"] }));

/* ---------- helpers ---------- */
function isAdmin(req) {
  return ADMIN_TOKEN && (req.query.token === ADMIN_TOKEN || req.get("x-admin-token") === ADMIN_TOKEN);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* naive per-IP rate limit for submissions: 5 per hour */
const submitLog = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 3600_000;
  const hits = (submitLog.get(ip) || []).filter((t) => t > windowStart);
  if (hits.length >= 5) return true;
  hits.push(now);
  submitLog.set(ip, hits);
  return false;
}

/* ---------- public API ---------- */
app.get("/api/wall", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `select id, name_ar, name_en, message, created_at
         from restaurants where status = 'approved'
        order by created_at asc`
    );
    res.json({
      count: rows.length,
      rows: rows.map((r) => ({
        name_ar: r.name_ar,
        name_en: r.name_en,
        message: r.message,
        logo_url: "/api/logo/" + r.id,
      })),
    });
  } catch (err) {
    console.error("wall:", err.message);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/logo/:id", async (req, res) => {
  try {
    const admin = isAdmin(req);
    const { rows } = await pool.query(
      `select logo_bytes, logo_mime, status from restaurants where id = $1`,
      [req.params.id]
    );
    const r = rows[0];
    if (!r || (r.status !== "approved" && !admin)) return res.status(404).end();
    res.set({
      "Content-Type": r.logo_mime,
      "X-Content-Type-Options": "nosniff",
      // Neutralize scripts if an uploaded SVG is opened directly:
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Cache-Control": r.status === "approved" ? "public, max-age=86400" : "no-store",
    });
    res.send(r.logo_bytes);
  } catch (err) {
    res.status(400).end();
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype)),
});

app.post("/api/join", (req, res) => {
  upload.single("logo")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "logo_invalid" });
    try {
      const ip = req.get("x-forwarded-for") || req.socket.remoteAddress || "?";
      if (rateLimited(ip.split(",")[0].trim())) return res.status(429).json({ error: "rate_limited" });

      const b = req.body || {};
      const nameAr = (b.name_ar || "").trim();
      const contact = (b.contact_name || "").trim();
      const phone = (b.phone || "").trim();
      const message = (b.message || "").trim();
      if (!nameAr || !contact || !phone || !req.file) return res.status(400).json({ error: "missing_fields" });
      if (message.length > 280) return res.status(400).json({ error: "message_too_long" });
      if (!ALLOWED_MIME.includes(req.file.mimetype)) return res.status(400).json({ error: "logo_invalid" });

      await pool.query(
        `insert into restaurants
           (name_ar, name_en, logo_bytes, logo_mime, license_no, contact_name, phone, email, message)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          nameAr,
          (b.name_en || "").trim() || null,
          req.file.buffer,
          req.file.mimetype,
          (b.license_no || "").trim() || null,
          contact,
          phone,
          (b.email || "").trim() || null,
          message || null,
        ]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error("join:", e.message);
      res.status(500).json({ error: "server_error" });
    }
  });
});

/* ---------- moderation ---------- */
app.post("/api/admin/:id/:action", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
  const status = { approve: "approved", reject: "rejected" }[req.params.action];
  if (!status) return res.status(400).json({ error: "bad_action" });
  try {
    const r = await pool.query(`update restaurants set status = $1 where id = $2`, [status, req.params.id]);
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    res.status(400).json({ error: "bad_id" });
  }
});

app.get("/admin", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send("Forbidden — append ?token=ADMIN_TOKEN");
  const { rows } = await pool.query(
    `select id, name_ar, name_en, license_no, contact_name, phone, email, message, status, created_at
       from restaurants order by (status = 'pending') desc, created_at desc limit 200`
  );
  const counts = await pool.query(`select status, count(*) n from restaurants group by status`);
  const stat = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
  const token = esc(req.query.token);
  const rowsHtml = rows.map((r) => `
    <tr class="${esc(r.status)}">
      <td><img src="/api/logo/${r.id}?token=${token}" alt="" loading="lazy"></td>
      <td>${esc(r.name_ar)}<br><small>${esc(r.name_en || "")}</small></td>
      <td>${esc(r.contact_name)}<br><small dir="ltr">${esc(r.phone)} · ${esc(r.email || "")}</small><br><small>ترخيص: ${esc(r.license_no || "—")}</small></td>
      <td>${esc(r.message || "")}</td>
      <td>${esc(r.status)}</td>
      <td>
        <button onclick="act('${r.id}','approve')">✓ اعتماد</button>
        <button class="rej" onclick="act('${r.id}','reject')">✗ رفض</button>
      </td>
    </tr>`).join("");
  res.send(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<title>الإشراف — جدار التأييد</title>
<style>
 body{font-family:system-ui,sans-serif;margin:2rem;background:#fafaf7;color:#1a1a1a}
 h1{color:#00512F} .stats{margin-bottom:1rem;color:#555}
 table{border-collapse:collapse;width:100%;background:#fff}
 td,th{border:1px solid #ddd;padding:8px;vertical-align:top;text-align:right}
 img{max-width:70px;max-height:70px;object-fit:contain}
 tr.approved{background:#f0f7f3} tr.rejected{opacity:.45}
 button{cursor:pointer;padding:4px 12px;border-radius:6px;border:1px solid #00693E;background:#00693E;color:#fff}
 button.rej{background:#fff;color:#CE1126;border-color:#CE1126}
</style></head><body>
<h1>الإشراف على الطلبات</h1>
<p class="stats">قيد المراجعة: ${stat.pending || 0} · معتمد: ${stat.approved || 0} · مرفوض: ${stat.rejected || 0}</p>
<table><tr><th>الشعار</th><th>المطعم</th><th>بيانات التواصل (خاصة)</th><th>الرسالة</th><th>الحالة</th><th>إجراء</th></tr>${rowsHtml}</table>
<script>
async function act(id, action){
  const r = await fetch('/api/admin/'+id+'/'+action+'?token=${token}', {method:'POST'});
  if(r.ok) location.reload(); else alert('فشل الإجراء');
}
</script></body></html>`);
});

app.listen(PORT, () => console.log("shukran-campaign listening on :" + PORT));
