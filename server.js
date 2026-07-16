/* شكراً معالي الوزير — campaign backend
 * Serves the static site plus:
 *   GET  /api/wall               approved restaurants (public columns only)
 *   GET  /api/logo/:id           logo image (approved only, unless admin session)
 *   POST /api/join               new submission -> status 'pending'
 *   GET  /<ADMIN_PATH>           hidden moderation page (password login -> httpOnly cookie)
 *   POST /api/admin/:id/:action  approve / reject (admin session required)
 */
"use strict";

const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8737;
/* Admin access: secret URL path + bcrypt password hash, both from env.
   Nothing on the public site links or refers to the admin page. */
const ADMIN_PATH = (process.env.ADMIN_PATH || "").replace(/^\/+/, "");
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const SESSION_TTL_MS = 12 * 3600_000;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/svg+xml"];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /sslmode=require/.test(process.env.DATABASE_URL || "")
    ? { rejectUnauthorized: false }
    : undefined,
});

/* tables added after launch are created on boot (idempotent) */
pool.query(`create table if not exists requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_name text not null,
  contact_name text not null,
  contact_info text not null,
  message text not null check (char_length(message) <= 500),
  status text not null default 'new' check (status in ('new','done')),
  created_at timestamptz default now()
)`).catch((e) => console.error("migrate requests:", e.message));

const app = express();
app.disable("x-powered-by");

/* ---------- static site ---------- */
const PRIVATE_PATHS = [/^\/server\.js/, /^\/package(-lock)?\.json/, /^\/db\//, /^\/node_modules\//, /^\/\.git/, /^\/khitab_taeed\.docx/];
app.use((req, res, next) => {
  if (PRIVATE_PATHS.some((re) => re.test(req.path))) return res.status(404).end();
  next();
});
app.use(express.static(__dirname, { extensions: ["html"] }));

/* ---------- helpers ---------- */
/* Admin sessions live in memory: token -> expiry. A restart just logs the admin out. */
const sessions = new Map();

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function isAdmin(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(sid); return false; }
  return true;
}

function clientIp(req) {
  return (req.get("x-forwarded-for") || req.socket.remoteAddress || "?").split(",")[0].trim();
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
/* Word letter: force a real download (Content-Disposition: attachment) so
   browsers save the file instead of opening it in an online Office viewer. */
app.get("/api/letter-docx", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.download(path.join(__dirname, "khitab_taeed.docx"), "خطاب_التأييد.docx");
});


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
      if (rateLimited(clientIp(req))) return res.status(429).json({ error: "rate_limited" });

      const b = req.body || {};
      const nameAr = (b.name_ar || "").trim();
      const contact = (b.contact_name || "").trim();
      const message = (b.message || "").trim();
      if (!nameAr || !contact || !req.file) return res.status(400).json({ error: "missing_fields" });
      if (message.length > 280) return res.status(400).json({ error: "message_too_long" });
      if (!ALLOWED_MIME.includes(req.file.mimetype)) return res.status(400).json({ error: "logo_invalid" });

      await pool.query(
        `insert into restaurants
           (name_ar, name_en, logo_bytes, logo_mime, contact_name, message)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          nameAr,
          (b.name_en || "").trim() || null,
          req.file.buffer,
          req.file.mimetype,
          contact,
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

/* contact / removal requests from the footer form: 3 per hour per IP */
const contactLog = new Map();
function contactLimited(ip) {
  const now = Date.now();
  const hits = (contactLog.get(ip) || []).filter((t) => t > now - 3600_000);
  if (hits.length >= 3) return true;
  hits.push(now);
  contactLog.set(ip, hits);
  return false;
}

app.post("/api/contact", express.json({ limit: "20kb" }), async (req, res) => {
  try {
    if (contactLimited(clientIp(req))) return res.status(429).json({ error: "rate_limited" });
    const b = req.body || {};
    const restaurant = (b.restaurant_name || "").trim();
    const contact = (b.contact_name || "").trim();
    const info = (b.contact_info || "").trim();
    const message = (b.message || "").trim();
    if (!restaurant || !contact || !info || !message) return res.status(400).json({ error: "missing_fields" });
    if (restaurant.length > 120 || contact.length > 120 || info.length > 160 || message.length > 500)
      return res.status(400).json({ error: "too_long" });
    await pool.query(
      `insert into requests (restaurant_name, contact_name, contact_info, message) values ($1,$2,$3,$4)`,
      [restaurant, contact, info, message]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("contact:", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

/* ---------- moderation ---------- */
app.get("/api/admin/data", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
  try {
    const subs = await pool.query(
      `select id, name_ar, name_en, contact_name, message, status, created_at
         from restaurants order by (status = 'pending') desc, created_at desc limit 200`
    );
    const reqs = await pool.query(
      `select id, restaurant_name, contact_name, contact_info, message, status, created_at
         from requests order by (status = 'new') desc, created_at desc limit 200`
    );
    const counts = await pool.query(`select status, count(*) n from restaurants group by status`);
    res.set("Cache-Control", "no-store");
    res.json({
      submissions: subs.rows,
      requests: reqs.rows,
      stats: Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)])),
    });
  } catch (e) {
    console.error("admin data:", e.message);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/admin/request/:id/done", async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
  try {
    const r = await pool.query(`update requests set status = 'done' where id = $1`, [req.params.id]);
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    res.status(400).json({ error: "bad_id" });
  }
});

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

/* ---------- hidden admin page (secret path from env) ---------- */
if (ADMIN_PATH && ADMIN_PASSWORD_HASH) {
  /* login attempts: 5 per 15 minutes per IP */
  const loginLog = new Map();
  function loginLimited(ip) {
    const now = Date.now();
    const hits = (loginLog.get(ip) || []).filter((t) => t > now - 900_000);
    if (hits.length >= 5) return true;
    hits.push(now);
    loginLog.set(ip, hits);
    return false;
  }

  const loginPage = (msg) => `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow"><title>تسجيل الدخول</title>
<style>
 body{font-family:system-ui,sans-serif;background:#fafaf7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
 form{background:#fff;padding:2rem;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:320px}
 h1{font-size:1.1rem;color:#00512F;margin:0 0 1rem}
 input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:1rem;margin-bottom:12px}
 button{width:100%;padding:10px;border:none;border-radius:6px;background:#00693E;color:#fff;font-size:1rem;cursor:pointer}
 .err{color:#CE1126;font-size:.9rem;margin-bottom:10px}
</style></head><body>
<form method="post" action="/${ADMIN_PATH}/login">
<h1>لوحة الإشراف</h1>
${msg ? `<p class="err">${esc(msg)}</p>` : ""}
<input type="password" name="password" placeholder="كلمة المرور" required autofocus autocomplete="current-password">
<button type="submit">دخول</button>
</form></body></html>`;

  app.post("/" + ADMIN_PATH + "/login", express.urlencoded({ extended: false }), async (req, res) => {
    if (loginLimited(clientIp(req))) return res.status(429).send(loginPage("محاولات كثيرة — انتظر 15 دقيقة."));
    const ok = await bcrypt.compare((req.body && req.body.password) || "", ADMIN_PASSWORD_HASH);
    if (!ok) return res.status(403).send(loginPage("كلمة المرور غير صحيحة."));
    const sid = crypto.randomBytes(32).toString("hex");
    sessions.set(sid, Date.now() + SESSION_TTL_MS);
    res.set("Set-Cookie", `sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.redirect("/" + ADMIN_PATH);
  });

  app.post("/" + ADMIN_PATH + "/logout", (req, res) => {
    sessions.delete(parseCookies(req).sid);
    res.set("Set-Cookie", "sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    res.redirect("/" + ADMIN_PATH);
  });

  /* The dashboard renders client-side and polls /api/admin/data every 5s,
     so new submissions and contact requests appear without a page refresh. */
  app.get("/" + ADMIN_PATH, (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!isAdmin(req)) return res.send(loginPage(""));
    res.send(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow"><title>الإشراف — جدار التأييد</title>
<style>
 body{font-family:system-ui,sans-serif;margin:2rem;background:#fafaf7;color:#1a1a1a}
 h1{color:#00512F} h2{color:#00512F;margin:1.6rem 0 .5rem;font-size:1.1rem}
 .stats{margin-bottom:1rem;color:#555}
 .top{display:flex;justify-content:space-between;align-items:center}
 table{border-collapse:collapse;width:100%;background:#fff}
 td,th{border:1px solid #ddd;padding:8px;vertical-align:top;text-align:right}
 img{max-width:70px;max-height:70px;object-fit:contain}
 tr.approved{background:#f0f7f3} tr.rejected{opacity:.45}
 tr.newreq{background:#fff7e6}
 tr.done{opacity:.5}
 .empty{color:#888;padding:14px;text-align:center}
 button{cursor:pointer;padding:4px 12px;border-radius:6px;border:1px solid #00693E;background:#00693E;color:#fff}
 button.rej{background:#fff;color:#CE1126;border-color:#CE1126}
 .logout button{background:#fff;color:#555;border-color:#aaa}
 .badge{display:inline-block;min-width:22px;text-align:center;background:#CE1126;color:#fff;border-radius:12px;font-size:.8rem;padding:1px 7px;vertical-align:middle;margin-inline-start:6px}
 .live{color:#00693E;font-size:.8rem}
</style></head><body>
<div class="top"><h1>الإشراف على الطلبات <span class="live">● تحديث تلقائي</span></h1>
<form class="logout" method="post" action="/${ADMIN_PATH}/logout"><button type="submit">تسجيل الخروج</button></form></div>
<p class="stats" id="stats">جارٍ التحميل…</p>

<h2>طلبات الانضمام</h2>
<table id="subs"><thead><tr><th>الشعار</th><th>المطعم</th><th>بيانات التواصل (خاصة)</th><th>الرسالة</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody></tbody></table>

<h2>طلبات التواصل والحذف <span class="badge" id="reqBadge" hidden></span></h2>
<table id="reqs"><thead><tr><th>المطعم</th><th>صاحب الطلب</th><th>وسيلة التواصل</th><th>الرسالة</th><th>التاريخ</th><th>إجراء</th></tr></thead><tbody></tbody></table>

<script>
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function fmtDate(d){try{return new Date(d).toLocaleString("ar-KW",{dateStyle:"short",timeStyle:"short"});}catch(e){return "";}}

function render(d){
  var stat = d.stats || {};
  document.getElementById("stats").textContent =
    "قيد المراجعة: " + (stat.pending||0) + " · معتمد: " + (stat.approved||0) + " · مرفوض: " + (stat.rejected||0);

  document.querySelector("#subs tbody").innerHTML = (d.submissions||[]).map(function(r){
    return '<tr class="'+esc(r.status)+'">'
      +'<td><img src="/api/logo/'+r.id+'" alt="" loading="lazy"></td>'
      +'<td>'+esc(r.name_ar)+'<br><small>'+esc(r.name_en||"")+'</small></td>'
      +'<td>'+esc(r.contact_name)+'</td>'
      +'<td>'+esc(r.message||"")+'</td>'
      +'<td>'+esc(r.status)+'</td>'
      +'<td><button onclick="act(\\''+r.id+'\\',\\'approve\\')">✓ اعتماد</button> '
      +'<button class="rej" onclick="act(\\''+r.id+'\\',\\'reject\\')">✗ رفض</button></td></tr>';
  }).join("") || '<tr><td colspan="6" class="empty">لا توجد طلبات انضمام</td></tr>';

  var reqs = d.requests || [];
  var newCount = reqs.filter(function(r){return r.status==="new";}).length;
  var badge = document.getElementById("reqBadge");
  badge.hidden = newCount === 0;
  badge.textContent = newCount;
  var pendingTotal = (stat.pending||0) + newCount;
  document.title = (pendingTotal ? "("+pendingTotal+") " : "") + "الإشراف — جدار التأييد";

  document.querySelector("#reqs tbody").innerHTML = reqs.map(function(r){
    return '<tr class="'+(r.status==="new"?"newreq":"done")+'">'
      +'<td>'+esc(r.restaurant_name)+'</td>'
      +'<td>'+esc(r.contact_name)+'</td>'
      +'<td dir="ltr">'+esc(r.contact_info)+'</td>'
      +'<td>'+esc(r.message)+'</td>'
      +'<td><small>'+fmtDate(r.created_at)+'</small></td>'
      +'<td>'+(r.status==="new"
        ? '<button onclick="doneReq(\\''+r.id+'\\')">✓ تم التعامل</button>'
        : 'تم')+'</td></tr>';
  }).join("") || '<tr><td colspan="6" class="empty">لا توجد طلبات تواصل</td></tr>';
}

async function load(){
  try{
    var r = await fetch("/api/admin/data", {cache:"no-store"});
    if(r.status===403){ location.reload(); return; }
    if(!r.ok) return;
    render(await r.json());
  }catch(e){}
}

async function act(id, action){
  var r = await fetch("/api/admin/"+id+"/"+action, {method:"POST"});
  if(r.ok) load(); else alert("فشل الإجراء");
}
async function doneReq(id){
  var r = await fetch("/api/admin/request/"+id+"/done", {method:"POST"});
  if(r.ok) load(); else alert("فشل الإجراء");
}

load();
setInterval(load, 5000);
document.addEventListener("visibilitychange", function(){ if(!document.hidden) load(); });
</script></body></html>`);
  });
}

app.listen(PORT, () => console.log("shukran-campaign listening on :" + PORT));
