// clips.halvixiepie.online — community clip submissions + admin downloader
// Single-file server: Express + better-sqlite3 + multer
// Env: ADMIN_PASSWORD (required), DB_PATH (default /data/clips.db),
//      UPLOAD_DIR (default /data/uploads), PORT (Railway sets this)

const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB_PATH = process.env.DB_PATH || '/data/clips.db';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const PAY_PER_CLIP = Number(process.env.PAY_PER_CLIP || 20); // PHP per chosen clip
const STREAMERS = (process.env.STREAMERS || 'xjabee,itshoneypie__,halcyon_aurora,elovixie,idlecai')
  .split(',').map(s => s.trim()).filter(Boolean); // the stream circle; everything else files under "others"

if (!ADMIN_PASSWORD) console.warn('[warn] ADMIN_PASSWORD is not set — /admin will refuse all logins.');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- DB ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  slug TEXT NOT NULL,
  username TEXT NOT NULL,
  qr_file TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
)`);
// migrations for older DBs
const cols = db.prepare('PRAGMA table_info(clips)').all().map(c => c.name);
if (!cols.includes('qr_hash')) db.exec('ALTER TABLE clips ADD COLUMN qr_hash TEXT');
if (!cols.includes('paid_at')) db.exec('ALTER TABLE clips ADD COLUMN paid_at INTEGER');
if (!cols.includes('streamer')) {
  db.exec("ALTER TABLE clips ADD COLUMN streamer TEXT");
  db.exec("UPDATE clips SET streamer='others' WHERE streamer IS NULL");
}

// ---------- helpers ----------
function clipSlug(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.hostname === 'clips.twitch.tv') {
      const s = u.pathname.split('/').filter(Boolean)[0];
      return s || null;
    }
    if (u.hostname === 'www.twitch.tv' || u.hostname === 'twitch.tv' || u.hostname === 'm.twitch.tv') {
      const parts = u.pathname.split('/').filter(Boolean);
      const i = parts.indexOf('clip');
      if (i >= 0 && parts[i + 1]) return parts[i + 1];
    }
  } catch (e) {}
  return null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeFilename(s) {
  return String(s).replace(/[^a-z0-9 _.-]/gi, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'clip';
}

// Resolve a Twitch clip slug to a downloadable mp4 URL via Twitch's public GQL.
// Uses the public web Client-ID (same one every clip downloader uses). If Twitch
// rotates the persisted-query hash this will start failing — see README note.
const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
async function resolveClipMp4(slug) {
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': TWITCH_GQL_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      operationName: 'VideoAccessToken_Clip',
      variables: { slug },
      extensions: { persistedQuery: { version: 1, sha256Hash: '36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11' } }
    }])
  });
  if (!res.ok) throw new Error('Twitch GQL returned ' + res.status);
  const data = await res.json();
  const clip = data?.[0]?.data?.clip;
  const qualities = clip?.videoQualities;
  const token = clip?.playbackAccessToken;
  if (!qualities?.length || !token?.signature || !token?.value) throw new Error('Clip not found or token missing');
  // qualities come highest-first; [0] is source quality
  return `${qualities[0].sourceURL}?sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
}

// ---------- admin auth (cookie) ----------
// Session token is derived from ADMIN_PASSWORD, so logins survive redeploys.
// Changing the password (or setting a new SESSION_SECRET) logs every device out.
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update('halvixiepie-clips::' + ADMIN_PASSWORD).digest('hex');
function adminToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('admin').digest('hex');
}
function isAdmin(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(p => {
    const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }).filter(([k]) => k));
  return ADMIN_PASSWORD && cookies.adm === adminToken();
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.redirect('/admin/login');
}

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[file.mimetype] || '.png';
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype));
  }
});

// simple per-IP cooldown so the form can't be spammed
const lastSubmit = new Map();
function cooldownOk(ip) {
  const now = Date.now();
  const prev = lastSubmit.get(ip) || 0;
  if (now - prev < 30_000) return false;
  lastSubmit.set(ip, now);
  return true;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));

// ---------- shared style ----------
const STYLE = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=Outfit:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#140e05; --panel:#1e1608; --panel2:#261c0b; --line:#3a2c12;
  --honey:#ffb62e; --honey-dim:#c98d1e; --text:#f3e9d4; --muted:#a08c66;
  --ok:#8fd158; --bad:#e0685c;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 Outfit,system-ui,sans-serif;
  background-image:radial-gradient(circle at 20% -10%, #2a1d07 0%, transparent 50%),
  url("data:image/svg+xml,%3Csvg width='56' height='100' viewBox='0 0 56 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M28 66L0 50L0 16L28 0L56 16L56 50L28 66L28 100' fill='none' stroke='%23241a0a' stroke-width='2'/%3E%3Cpath d='M28 0L28 34L0 50M28 34L56 50' fill='none' stroke='%23241a0a' stroke-width='2'/%3E%3C/svg%3E");
}
.wrap{max-width:640px;margin:0 auto;padding:32px 16px 64px}
.wrap.wide{max-width:960px}
h1{font-family:Silkscreen,monospace;font-size:22px;letter-spacing:1px;color:var(--honey);margin:0}
h1 .sub{display:block;font-family:Outfit;font-size:13px;font-weight:400;letter-spacing:0;color:var(--muted);margin-top:6px}
.hex{width:44px;height:50px;background:var(--honey);clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);
  display:grid;place-items:center;color:#140e05;font-family:Silkscreen;font-weight:700;font-size:18px;flex:0 0 auto}
header{display:flex;align-items:center;gap:14px;margin-bottom:28px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px}
label{display:block;font-family:Silkscreen,monospace;font-size:11px;color:var(--honey-dim);letter-spacing:1px;margin:18px 0 6px;text-transform:uppercase}
label:first-child{margin-top:0}
input[type=text],input[type=url],input[type=password]{width:100%;background:var(--bg);border:1px solid var(--line);
  border-radius:8px;color:var(--text);padding:11px 12px;font:inherit}
input:focus{outline:2px solid var(--honey);outline-offset:1px;border-color:transparent}
input[type=file]{width:100%;color:var(--muted);font-size:14px;padding:10px;background:var(--bg);
  border:1px dashed var(--line);border-radius:8px}
.hint{font-size:13px;color:var(--muted);margin-top:6px}
button,.btn{display:inline-block;background:var(--honey);color:#140e05;border:0;border-radius:8px;
  font-family:Silkscreen,monospace;font-size:13px;letter-spacing:1px;padding:12px 20px;cursor:pointer;text-decoration:none}
button:hover,.btn:hover{background:#ffc95e}
.btn.ghost{background:transparent;color:var(--honey);border:1px solid var(--line)}
.btn.ghost:hover{background:var(--panel2)}
.submitrow{margin-top:26px}
.flash{border-radius:10px;padding:14px 16px;margin-bottom:20px;font-weight:600}
.flash.ok{background:#1d2a12;border:1px solid #3c5a24;color:var(--ok)}
.flash.bad{background:#2a1512;border:1px solid #5a2c24;color:var(--bad)}
.flash.pay{background:#241a06;border:1px solid #54400f;color:var(--text);font-weight:400}
.flash.pay b{color:var(--honey)}
.payrow{display:flex;gap:16px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px;flex-wrap:wrap}
.payrow img{width:120px;height:120px;object-fit:contain;background:#fff;border-radius:8px;flex:0 0 auto}
.payrow .who{flex:1;min-width:180px}
.payrow .amt{font-family:Silkscreen,monospace;font-size:20px;color:var(--honey)}
.warn{color:var(--bad);font-size:13px;margin-top:4px}
select{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--text);
  padding:11px 12px;font:inherit;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23c98d1e' stroke-width='2'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 14px center}
select:focus{outline:2px solid var(--honey);outline-offset:1px;border-color:transparent}
.modal{position:fixed;inset:0;background:rgba(10,7,2,.75);display:grid;place-items:center;padding:20px;z-index:50}
.modalbox{background:var(--panel2);border:2px solid var(--honey);border-radius:14px;max-width:420px;padding:26px;text-align:center;
  box-shadow:0 20px 60px rgba(0,0,0,.6)}
.modalbox .hex{margin:0 auto 14px}
.modalbox h2{font-family:Silkscreen,monospace;font-size:14px;color:var(--honey);letter-spacing:1px;margin:0 0 10px}
.modalbox p{margin:0 0 20px;color:var(--text);line-height:1.6}
.filterbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.filterbar a{font-family:Silkscreen,monospace;font-size:11px;letter-spacing:1px;padding:7px 12px;border-radius:8px;
  border:1px solid var(--line);color:var(--muted);text-decoration:none}
.filterbar a.on{background:var(--honey);color:#140e05;border-color:var(--honey)}
.filterbar a:not(.on):hover{background:var(--panel2);color:var(--honey)}
.clip{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:18px}
.clip.done{opacity:.55}
.cliphead{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap}
.cliphead b{font-size:17px}
.meta{font-size:13px;color:var(--muted)}
.meta a{color:var(--honey-dim)}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;align-items:center}
.embed{margin-top:14px;aspect-ratio:16/9;width:100%;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.embed iframe{width:100%;height:100%;border:0}
.qrthumb{max-width:160px;border:1px solid var(--line);border-radius:8px;display:block;margin-top:10px}
.tag{font-family:Silkscreen,monospace;font-size:10px;letter-spacing:1px;padding:4px 8px;border-radius:6px;
  background:var(--panel2);border:1px solid var(--line);color:var(--honey-dim)}
@media(prefers-reduced-motion:no-preference){.card,.clip{transition:border-color .15s}.clip:hover{border-color:#54400f}}
</style>`;

// ---------- public: submission form ----------
app.get('/', (req, res) => {
  const ok = 'ok' in req.query, err = req.query.err;
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>halvixiepie clips</title>
<meta property="og:title" content="halvixiepie clips 🎬">
<meta property="og:description" content="Clip funny, amazing moments of your favorite streamers and get ₱${PAY_PER_CLIP} per clip!">
<meta property="og:type" content="website">
<meta property="og:url" content="https://clips.halvixiepie.online/">
<meta property="og:site_name" content="halvixiepie">
<meta name="description" content="Clip funny, amazing moments of your favorite streamers and get ₱${PAY_PER_CLIP} per clip!">
<meta name="theme-color" content="#ffb62e">
${STYLE}</head><body><div class="wrap">
<header><div class="hex">▶</div>
<h1>SEND A CLIP<span class="sub">Submit your favorite moments for the weekly halvixiepie recap</span></h1></header>
<div class="flash pay">💸 <b>₱${PAY_PER_CLIP} per clip</b> — if your clip is chosen for the weekly recap video, you get ₱${PAY_PER_CLIP} sent to the QRPH/GCash QR you upload. Multiple chosen clips stack. Payouts go out after the recap is posted.</div>
${ok ? `<div class="flash ok">Clip received! If it makes the weekly recap, you get paid ₱${PAY_PER_CLIP}.</div>` : ''}
${err ? `<div class="flash bad">${esc(err)}</div>` : ''}
<form class="card" method="post" action="/submit" enctype="multipart/form-data">
  <label for="title">Clip title</label>
  <input type="text" id="title" name="title" maxlength="120" required placeholder="halcyon's 1v5 clutch">
  <label for="url">Twitch clip link</label>
  <input type="url" id="url" name="url" required placeholder="https://clips.twitch.tv/...">
  <div class="hint">Paste the link from the clip's Share button — clips.twitch.tv/... or twitch.tv/channel/clip/...</div>
  <label for="streamer">Whose stream is it from?</label>
  <select id="streamer" name="streamer" required>
    <option value="" disabled selected>Pick a streamer</option>
    ${STREAMERS.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
    <option value="others">Someone else (others)</option>
  </select>
  <label for="username">Twitch username</label>
  <input type="text" id="username" name="username" maxlength="40" required placeholder="your twitch name">
  <label for="qr">QRPH / GCash QR code</label>
  <input type="file" id="qr" name="qr" accept="image/png,image/jpeg,image/webp" required>
  <div class="hint">PNG, JPG, or WebP, up to 5 MB. Only the recap crew can see it.</div>
  <div class="submitrow"><button type="submit">Drop it in the hive</button></div>
  <div class="hint" style="margin-top:16px">⚠ Clips from outside the stream circle: I appreciate the clip and will check it out, but the chances of it making it into the video are slim!</div>
</form>
<div class="modal" id="othersModal" hidden>
  <div class="modalbox">
    <div class="hex">!</div>
    <h2>HEADS UP</h2>
    <p>This clip doesn't belong to the stream circle — I appreciate the clip and will check it out, but the chances of it making it into the video are slim!</p>
    <button type="button" onclick="document.getElementById('othersModal').hidden=true">Got it, submitting anyway</button>
  </div>
</div>
<script>
document.getElementById('streamer').addEventListener('change', function () {
  if (this.value === 'others') document.getElementById('othersModal').hidden = false;
});
document.getElementById('othersModal').addEventListener('click', function (e) {
  if (e.target === this) this.hidden = true;
});
</script>
</div></body></html>`);
});

app.post('/submit', (req, res) => {
  upload.single('qr')(req, res, err => {
    if (err) return res.redirect('/?err=' + encodeURIComponent('Image too large (5 MB max).'));
    const { title, url, username, streamer } = req.body || {};
    const slug = clipSlug(url);
    const fail = m => {
      if (req.file) fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
      res.redirect('/?err=' + encodeURIComponent(m));
    };
    if (!title?.trim() || !username?.trim()) return fail('Title and username are required.');
    if (!streamer || (!STREAMERS.includes(streamer) && streamer !== 'others')) return fail('Pick whose stream the clip is from.');
    if (!slug) return fail("That doesn't look like a Twitch clip link. Use the clip's Share button.");
    if (!req.file) return fail('QR code image is required (PNG, JPG, or WebP).');
    if (!cooldownOk(req.ip)) return fail('Easy there — wait 30 seconds between submissions.');
    const qrHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(UPLOAD_DIR, req.file.filename))).digest('hex');
    db.prepare('INSERT INTO clips (title,url,slug,username,qr_file,qr_hash,streamer,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(title.trim().slice(0, 120), String(url).trim(), slug, username.trim().slice(0, 40), req.file.filename, qrHash, streamer, Date.now());
    res.redirect('/?ok');
  });
});

// ---------- admin ----------
app.get('/admin/login', (req, res) => {
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>clips admin</title>${STYLE}</head>
<body><div class="wrap"><header><div class="hex">🔑</div><h1>RECAP CREW ONLY</h1></header>
${'err' in req.query ? '<div class="flash bad">Wrong password.</div>' : ''}
<form class="card" method="post" action="/admin/login">
<label for="pw">Password</label><input type="password" id="pw" name="pw" required autofocus>
<div class="submitrow"><button type="submit">Log in</button></div></form></div></body></html>`);
});

app.post('/admin/login', (req, res) => {
  if (ADMIN_PASSWORD && req.body.pw === ADMIN_PASSWORD) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `adm=${adminToken()}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${secure}`);
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?err');
});

app.get('/admin', requireAdmin, (req, res) => {
  const showDone = 'all' in req.query;
  const sFilter = req.query.s && (STREAMERS.includes(req.query.s) || req.query.s === 'others') ? req.query.s : null;
  const where = [showDone ? '1=1' : "status='new'", sFilter ? 'streamer=?' : '1=1'].join(' AND ');
  const rows = db.prepare(`SELECT * FROM clips WHERE ${where} ORDER BY id DESC`).all(...(sFilter ? [sFilter] : []));
  const owed = db.prepare("SELECT COUNT(*) n FROM clips WHERE status='chosen'").get().n * PAY_PER_CLIP;
  const qs = s => '/admin?' + [showDone ? 'all' : '', s ? 's=' + encodeURIComponent(s) : ''].filter(Boolean).join('&');
  const filterbar = `<div class="filterbar">
    <a class="${!sFilter ? 'on' : ''}" href="${qs(null)}">ALL</a>
    ${STREAMERS.map(s => `<a class="${sFilter === s ? 'on' : ''}" href="${qs(s)}">${esc(s.toUpperCase())}</a>`).join('')}
    <a class="${sFilter === 'others' ? 'on' : ''}" href="${qs('others')}">OTHERS</a>
  </div>`;
  const host = req.hostname; // parent param for the Twitch embed
  const cards = rows.map(r => `
<div class="clip${r.status === 'passed' || r.status === 'paid' ? ' done' : ''}">
  <div class="cliphead"><b>${esc(r.title)}</b>
    <span class="meta">from <b>${esc(r.username)}</b> · <span class="tag">📺 ${esc(r.streamer || 'others')}</span> · ${new Date(r.created_at).toLocaleString()} · <span class="tag">${r.status.toUpperCase()}</span></span></div>
  <div class="meta"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></div>
  <details><summary class="meta" style="cursor:pointer;margin-top:10px">Preview clip</summary>
    <div class="embed"><iframe loading="lazy" src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(r.slug)}&parent=${encodeURIComponent(host)}&autoplay=false" allowfullscreen></iframe></div>
  </details>
  <details><summary class="meta" style="cursor:pointer;margin-top:6px">View QR code</summary>
    ${r.qr_file ? `<img class="qrthumb" src="/admin/qr/${r.id}" alt="QR code from ${esc(r.username)}">` : '<div class="meta">No QR uploaded.</div>'}
  </details>
  <div class="actions">
    <a class="btn" href="/admin/download/${r.id}">⬇ Download MP4</a>
    ${r.status !== 'chosen' && r.status !== 'paid' ? `<form method="post" action="/admin/status/${r.id}" style="display:inline">
      <input type="hidden" name="to" value="chosen">
      <button class="btn" type="submit">⭐ Choose clip (+₱${PAY_PER_CLIP})</button>
    </form>` : ''}
    ${r.status !== 'paid' ? `<form method="post" action="/admin/status/${r.id}" style="display:inline">
      <input type="hidden" name="to" value="${r.status === 'passed' ? 'new' : 'passed'}">
      <button class="btn ghost" type="submit">${r.status === 'passed' ? 'Back to new' : 'Pass'}</button>
    </form>` : ''}
    <form method="post" action="/admin/delete/${r.id}" style="display:inline" onsubmit="return confirm('Delete this submission and its QR image?')">
      <button class="btn ghost" type="submit">Delete</button>
    </form>
  </div>
</div>`).join('');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>clips admin</title>${STYLE}</head>
<body><div class="wrap wide"><header><div class="hex">▶</div>
<h1>CLIP INBOX<span class="sub">${rows.length} ${showDone ? 'total' : 'new'}${sFilter ? ` · ${esc(sFilter)}` : ''} · downloads land in your browser's download folder</span></h1></header>
${filterbar}
<div class="actions" style="margin-bottom:20px">
  <a class="btn" href="/admin/payout">💸 Payouts${owed ? ` — ₱${owed} owed` : ''}</a>
  <a class="btn ghost" href="/admin?${[showDone ? '' : 'all', sFilter ? 's=' + encodeURIComponent(sFilter) : ''].filter(Boolean).join('&')}">${showDone ? 'Show new only' : 'Show all statuses'}</a>
  <a class="btn ghost" href="/">View public form</a>
</div>
${cards || '<div class="card">No clips in the hive yet. Share the form link with the community.</div>'}
</div></body></html>`);
});

app.get('/admin/qr/:id', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT qr_file FROM clips WHERE id=?').get(req.params.id);
  if (!r?.qr_file) return res.status(404).send('Not found');
  res.sendFile(path.join(UPLOAD_DIR, path.basename(r.qr_file)));
});

app.get('/admin/download/:id', requireAdmin, async (req, res) => {
  const r = db.prepare('SELECT * FROM clips WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).send('Not found');
  try {
    const mp4 = await resolveClipMp4(r.slug);
    const upstream = await fetch(mp4);
    if (!upstream.ok || !upstream.body) throw new Error('CDN returned ' + upstream.status);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(r.username + '_' + r.title)}.mp4"`);
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    console.error('download failed:', e.message);
    res.status(502).send(`Download failed (${esc(e.message)}). Open the clip on Twitch and grab it manually, or check the README note about the GQL hash.`);
  }
});

app.get('/admin/payout', requireAdmin, (req, res) => {
  // outstanding: chosen-but-unpaid clips grouped by twitch name (case-insensitive)
  const owed = db.prepare(`SELECT lower(username) u, COUNT(*) n, MAX(id) latest
    FROM clips WHERE status='chosen' GROUP BY lower(username) ORDER BY n DESC`).all();
  const rows = owed.map(g => {
    const latest = db.prepare('SELECT username, qr_file FROM clips WHERE id=?').get(g.latest);
    const hashes = db.prepare(`SELECT COUNT(DISTINCT qr_hash) c FROM clips
      WHERE lower(username)=? AND status='chosen' AND qr_hash IS NOT NULL`).get(g.u).c;
    const titles = db.prepare(`SELECT title FROM clips WHERE lower(username)=? AND status='chosen' ORDER BY id`).all(g.u)
      .map(t => esc(t.title)).join(', ');
    return `<div class="payrow">
      ${latest.qr_file ? `<img src="/admin/qr/${g.latest}" alt="QR for ${esc(latest.username)}">` : ''}
      <div class="who"><b>${esc(latest.username)}</b> — ${g.n} clip${g.n > 1 ? 's' : ''} chosen
        <div class="meta">${titles}</div>
        ${hashes > 1 ? `<div class="warn">⚠ This user's chosen clips have ${hashes} different QR codes — open each clip in the inbox and check before paying.</div>` : ''}
      </div>
      <div class="amt">₱${g.n * PAY_PER_CLIP}</div>
      <form method="post" action="/admin/payout/pay" onsubmit="return confirm('Mark ₱${g.n * PAY_PER_CLIP} to ${esc(latest.username)} as paid? Do this AFTER you\\'ve actually sent it.')">
        <input type="hidden" name="u" value="${esc(g.u)}">
        <button class="btn" type="submit">Mark paid</button>
      </form>
    </div>`;
  }).join('');
  const totalOwed = owed.reduce((s, g) => s + g.n, 0) * PAY_PER_CLIP;
  const history = db.prepare(`SELECT lower(username) u, MAX(username) name, COUNT(*) n, MAX(paid_at) last
    FROM clips WHERE status='paid' GROUP BY lower(username) ORDER BY last DESC`).all()
    .map(h => `<div class="meta" style="margin-bottom:6px"><b style="color:var(--text)">${esc(h.name)}</b> — ₱${h.n * PAY_PER_CLIP} total (${h.n} clip${h.n > 1 ? 's' : ''}), last paid ${h.last ? new Date(h.last).toLocaleDateString() : '—'}</div>`).join('');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>payouts</title>${STYLE}</head>
<body><div class="wrap wide"><header><div class="hex">₱</div>
<h1>PAYOUTS<span class="sub">₱${PAY_PER_CLIP} per chosen clip · scan the QR, send the payment, then hit Mark paid</span></h1></header>
<div class="actions" style="margin-bottom:20px"><a class="btn ghost" href="/admin">← Back to inbox</a></div>
${rows || `<div class="card">Nobody is owed anything right now. Choose clips in the inbox and the tally shows up here.</div>`}
${rows ? `<div class="card" style="margin-top:6px;text-align:right"><span class="amt" style="font-family:Silkscreen;color:var(--honey)">Total owed: ₱${totalOwed}</span></div>` : ''}
${history ? `<h1 style="font-size:16px;margin:32px 0 14px">PAID HISTORY</h1><div class="card">${history}</div>` : ''}
</div></body></html>`);
});

app.post('/admin/payout/pay', requireAdmin, (req, res) => {
  db.prepare(`UPDATE clips SET status='paid', paid_at=? WHERE lower(username)=? AND status='chosen'`)
    .run(Date.now(), String(req.body.u || '').toLowerCase());
  res.redirect('/admin/payout');
});

app.post('/admin/status/:id', requireAdmin, (req, res) => {
  const to = ['chosen', 'passed', 'new'].includes(req.body.to) ? req.body.to : 'new';
  db.prepare('UPDATE clips SET status=? WHERE id=?').run(to, req.params.id);
  res.redirect('/admin' + (req.get('referer')?.includes('all') ? '?all' : ''));
});

app.post('/admin/delete/:id', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT qr_file FROM clips WHERE id=?').get(req.params.id);
  if (r?.qr_file) fs.unlink(path.join(UPLOAD_DIR, path.basename(r.qr_file)), () => {});
  db.prepare('DELETE FROM clips WHERE id=?').run(req.params.id);
  res.redirect('/admin');
});

app.listen(PORT, () => console.log('clips server on :' + PORT));
