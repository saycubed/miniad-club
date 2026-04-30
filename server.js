require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const { createCanvas, loadImage } = require('canvas');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { Resend } = require('resend');

const app = express();
const db = new Database('qrcodes.db');
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_BASE_URL = process.env.REDIRECT_BASE_URL || `${BASE_URL}/r`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_WEBHOOK_SECRET = process.env.EMAIL_WEBHOOK_SECRET || '';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const FROM_EMAIL = 'MiniAd QR <noreply@miniad.club>';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// =============================================================================
// DB schema
// =============================================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    notif_scan_enabled INTEGER DEFAULT 1,
    notif_scan_threshold INTEGER DEFAULT 100,
    notif_expiry_enabled INTEGER DEFAULT 1,
    notif_expiry_hours INTEGER DEFAULT 24,
    notif_email TEXT DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS dynamic_codes (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    destination TEXT NOT NULL,
    label TEXT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    qr_color TEXT DEFAULT '#000000',
    qr_bg_color TEXT DEFAULT '#FFFFFF',
    qr_body_style TEXT DEFAULT 'square',
    qr_eye_style TEXT DEFAULT 'frame0',
    qr_logo TEXT DEFAULT NULL,
    scan_limit INTEGER DEFAULT NULL,
    expires_at INTEGER DEFAULT NULL,
    scan_alert_sent INTEGER DEFAULT 0,
    expiry_notified INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    scan_count INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_slug TEXT NOT NULL,
    scanned_at INTEGER DEFAULT (unixepoch()),
    ip TEXT,
    user_agent TEXT,
    FOREIGN KEY (code_slug) REFERENCES dynamic_codes(slug) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS routing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_slug TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    match_value TEXT NOT NULL,
    destination TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (code_slug) REFERENCES dynamic_codes(slug) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_addr TEXT NOT NULL,
    to_addr TEXT,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    received_at INTEGER DEFAULT (unixepoch()),
    is_read INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_scans_slug ON scans(code_slug);
  CREATE INDEX IF NOT EXISTS idx_scans_at ON scans(scanned_at);
  CREATE INDEX IF NOT EXISTS idx_routing_slug ON routing_rules(code_slug);
`);

// Migrations
(function migrate() {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  const userAdd = {
    notif_scan_enabled:   'INTEGER DEFAULT 1',
    notif_scan_threshold: 'INTEGER DEFAULT 100',
    notif_expiry_enabled: 'INTEGER DEFAULT 1',
    notif_expiry_hours:   'INTEGER DEFAULT 24',
    notif_email:          'TEXT DEFAULT NULL',
    is_admin:             'INTEGER DEFAULT 0',
  };
  for (const [col, def] of Object.entries(userAdd)) {
    if (!userCols.includes(col)) db.prepare(`ALTER TABLE users ADD COLUMN ${col} ${def}`).run();
  }

  const codeCols = db.prepare('PRAGMA table_info(dynamic_codes)').all().map(c => c.name);
  const codeAdd = {
    user_id:          'TEXT REFERENCES users(id) ON DELETE CASCADE',
    qr_color:         "TEXT DEFAULT '#000000'",
    qr_bg_color:      "TEXT DEFAULT '#FFFFFF'",
    qr_body_style:    "TEXT DEFAULT 'square'",
    qr_eye_style:     "TEXT DEFAULT 'frame0'",
    qr_logo:          'TEXT DEFAULT NULL',
    scan_limit:       'INTEGER DEFAULT NULL',
    expires_at:       'INTEGER DEFAULT NULL',
    scan_alert_sent:  'INTEGER DEFAULT 0',
    expiry_notified:  'INTEGER DEFAULT 0',
  };
  for (const [col, def] of Object.entries(codeAdd)) {
    if (!codeCols.includes(col)) db.prepare(`ALTER TABLE dynamic_codes ADD COLUMN ${col} ${def}`).run();
  }
})();

// Auto-promote ADMIN_EMAIL on every boot
if (ADMIN_EMAIL) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(ADMIN_EMAIL);
}

// =============================================================================
// Email
// =============================================================================

async function sendEmail({ to, subject, html, text }) {
  if (!resend) {
    console.log(`[Email – no key] To: ${to} | Subject: ${subject}`);
    return { id: 'local' };
  }
  try {
    return await resend.emails.send({ from: FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject, html, text });
  } catch (err) {
    console.error('[Email] Send error:', err.message);
  }
}

// --- Templates ---
function emailWrap(content) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f13">
<div style="max-width:580px;margin:0 auto;padding:40px 24px;font-family:'Segoe UI',system-ui,sans-serif;color:#e8e8f0">
  <div style="margin-bottom:28px;font-size:1.3rem;font-weight:800;letter-spacing:-0.5px">
    MiniAd <span style="color:#7c6af7">QR</span>
  </div>
  ${content}
  <div style="margin-top:40px;padding-top:20px;border-top:1px solid #2a2a38;font-size:0.75rem;color:#8888a8">
    MiniAd QR &nbsp;·&nbsp; <a href="${BASE_URL}" style="color:#7c6af7;text-decoration:none">miniad.club</a>
  </div>
</div></body></html>`;
}

function welcomeEmail(name) {
  return emailWrap(`
    <h1 style="font-size:1.4rem;color:#7c6af7;margin:0 0 12px">Welcome${name ? ', ' + name : ''}!</h1>
    <p style="color:#8888a8;line-height:1.6;margin:0 0 24px">
      Your MiniAd QR account is ready. Create dynamic QR codes, track every scan, and update destinations without reprinting.
    </p>
    <a href="${BASE_URL}" style="display:inline-block;background:#7c6af7;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600">Open Dashboard</a>
  `);
}

function scanAlertEmail(code, threshold) {
  return emailWrap(`
    <h1 style="font-size:1.4rem;color:#7c6af7;margin:0 0 12px">Scan milestone reached!</h1>
    <p style="color:#8888a8;line-height:1.6;margin:0 0 8px">
      Your QR code <strong style="color:#e8e8f0">${code.label || code.slug}</strong> just hit
      <strong style="color:#5af7a0">${threshold} scans</strong>.
    </p>
    <p style="color:#8888a8;line-height:1.6;margin:0 0 24px">Short link: ${BASE_URL}/r/${code.slug}</p>
    <a href="${BASE_URL}" style="display:inline-block;background:#7c6af7;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600">View Stats</a>
  `);
}

function expiryWarningEmail(code) {
  const exp = new Date(code.expires_at * 1000);
  return emailWrap(`
    <h1 style="font-size:1.4rem;color:#f5c842;margin:0 0 12px">QR code expiring soon</h1>
    <p style="color:#8888a8;line-height:1.6;margin:0 0 8px">
      <strong style="color:#e8e8f0">${code.label || code.slug}</strong> will stop working on
      <strong style="color:#e8e8f0">${exp.toLocaleString()}</strong>.
    </p>
    <p style="color:#8888a8;line-height:1.6;margin:0 0 24px">
      Open the dashboard to extend the expiry or update the destination.
    </p>
    <a href="${BASE_URL}" style="display:inline-block;background:#7c6af7;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600">Manage QR Codes</a>
  `);
}

// --- Scan alert (called non-blocking after each scan) ---
async function checkScanAlert(slug) {
  const code = db.prepare('SELECT * FROM dynamic_codes WHERE slug = ?').get(slug);
  if (!code || !code.user_id || code.scan_alert_sent) return;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(code.user_id);
  if (!user || !user.notif_scan_enabled || !user.notif_scan_threshold) return;
  if (code.scan_count < user.notif_scan_threshold) return;
  db.prepare('UPDATE dynamic_codes SET scan_alert_sent = 1 WHERE slug = ?').run(slug);
  await sendEmail({
    to: user.notif_email || user.email,
    subject: `🎉 "${code.label || code.slug}" reached ${user.notif_scan_threshold} scans`,
    html: scanAlertEmail(code, user.notif_scan_threshold),
  });
}

// --- Expiry warnings (run hourly) ---
function checkExpiryWarnings() {
  const nowUnix = Math.floor(Date.now() / 1000);
  const codes = db.prepare(`
    SELECT d.*, u.email AS user_email, u.notif_email, u.notif_expiry_enabled, u.notif_expiry_hours
    FROM dynamic_codes d JOIN users u ON d.user_id = u.id
    WHERE d.expires_at IS NOT NULL
      AND d.expires_at > ?
      AND d.expiry_notified = 0
      AND u.notif_expiry_enabled = 1
      AND d.expires_at <= (? + (u.notif_expiry_hours * 3600))
  `).all(nowUnix, nowUnix);

  for (const code of codes) {
    db.prepare('UPDATE dynamic_codes SET expiry_notified = 1 WHERE slug = ?').run(code.slug);
    sendEmail({
      to: code.notif_email || code.user_email,
      subject: `⚠️ QR code "${code.label || code.slug}" expires soon`,
      html: expiryWarningEmail(code),
    }).catch(() => {});
  }
}
checkExpiryWarnings();
setInterval(checkExpiryWarnings, 3_600_000);

// =============================================================================
// Routing & limits helpers
// =============================================================================

const geoCache = new Map();
async function lookupCountry(ip) {
  if (!ip || ip === '::1' || /^(127\.|::ffff:127\.)/.test(ip)) return null;
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.ts < 3_600_000) return cached.country;
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode`, { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    const country = data.countryCode || null;
    geoCache.set(ip, { country, ts: Date.now() });
    return country;
  } catch { return null; }
}

function matchesDevice(matchValue, ua) {
  const ios = /iphone|ipad|ipod/i.test(ua);
  const android = /android/i.test(ua);
  const mobile = ios || android || /mobile/i.test(ua);
  switch (matchValue) {
    case 'ios':     return ios;
    case 'android': return android;
    case 'mobile':  return mobile;
    case 'desktop': return !mobile;
    default:        return false;
  }
}

function inactivePage(heading, detail) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title><style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f13;color:#e8e8f0;font-family:'Segoe UI',system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:2rem}
.box{text-align:center;max-width:360px}h1{color:#7c6af7;font-size:1.4rem;margin-bottom:.75rem}
p{color:#8888a8;font-size:.9rem;line-height:1.6}</style>
</head><body><div class="box"><h1>${heading}</h1><p>${detail}</p></div></body></html>`;
}

// =============================================================================
// Auth & scan helpers
// =============================================================================

function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(header.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.user.userId);
    if (!user?.is_admin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

const recordScan = db.transaction((slug, ip, ua) => {
  db.prepare('UPDATE dynamic_codes SET scan_count = scan_count + 1 WHERE slug = ?').run(slug);
  db.prepare('INSERT INTO scans (code_slug, ip, user_agent) VALUES (?, ?, ?)').run(slug, ip, ua);
});

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null;
}

// =============================================================================
// Logo upload
// =============================================================================

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: 'public/uploads/',
    filename: (req, file, cb) => cb(null, `${nanoid(12)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(path.extname(file.originalname).toLowerCase());
    ok ? cb(null, true) : cb(new Error('Only image files are allowed'));
  },
});

// =============================================================================
// QR generation
// =============================================================================

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawDot(ctx, x, y, cell, style) {
  const pad = cell * 0.1;
  const s = cell - pad * 2;
  const cx = x + cell / 2, cy = y + cell / 2;
  switch (style) {
    case 'dot':
      ctx.beginPath(); ctx.arc(cx, cy, s / 2, 0, Math.PI * 2); ctx.fill(); break;
    case 'round':
      roundRect(ctx, x + pad, y + pad, s, s, s * 0.3); ctx.fill(); break;
    case 'rounded-in':
      roundRect(ctx, x + pad, y + pad, s, s, s * 0.5); ctx.fill(); break;
    case 'diamond':
      ctx.beginPath();
      ctx.moveTo(cx, y + pad); ctx.lineTo(x + cell - pad, cy);
      ctx.lineTo(cx, y + cell - pad); ctx.lineTo(x + pad, cy);
      ctx.closePath(); ctx.fill(); break;
    case 'leaf':
      roundRect(ctx, x + pad, y + pad, s, s, s * 0.4); ctx.fill(); break;
    default:
      ctx.fillRect(x + pad, y + pad, s, s);
  }
}

function drawFinder(ctx, x, y, cell, style, color, bgColor) {
  const total = cell * 7;
  ctx.fillStyle = color;
  if (style === 'frame1' || style === 'frame2') {
    roundRect(ctx, x, y, total, total, total * 0.2); ctx.fill();
  } else {
    ctx.fillRect(x, y, total, total);
  }
  ctx.fillStyle = bgColor;
  ctx.fillRect(x + cell, y + cell, total - cell * 2, total - cell * 2);
  ctx.fillStyle = color;
  const inner = cell * 2, innerSize = total - cell * 4;
  if (style === 'frame6') {
    ctx.beginPath();
    ctx.arc(x + total / 2, y + total / 2, innerSize / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (style === 'frame1' || style === 'frame2') {
    roundRect(ctx, x + inner, y + inner, innerSize, innerSize, innerSize * 0.2); ctx.fill();
  } else {
    ctx.fillRect(x + inner, y + inner, innerSize, innerSize);
  }
}

async function generateQRBuffer(data, opts = {}) {
  const { color = '#000000', bgColor = '#FFFFFF', bodyStyle = 'square', eyeStyle = 'frame0', logo = '', size = 400 } = opts;
  const qr = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const { data: bits, size: count } = qr.modules;

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const margin = Math.round(size * 0.04);
  const cell = (size - margin * 2) / count;

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);

  const isFinderZone = (r, c) =>
    (r < 8 && c < 8) || (r < 8 && c >= count - 8) || (r >= count - 8 && c < 8);

  ctx.fillStyle = color;
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (!bits[r * count + c] || isFinderZone(r, c)) continue;
      drawDot(ctx, margin + c * cell, margin + r * cell, cell, bodyStyle);
    }
  }

  drawFinder(ctx, margin, margin, cell, eyeStyle, color, bgColor);
  drawFinder(ctx, margin + (count - 7) * cell, margin, cell, eyeStyle, color, bgColor);
  drawFinder(ctx, margin, margin + (count - 7) * cell, cell, eyeStyle, color, bgColor);

  if (logo) {
    try {
      const img = await loadImage(logo);
      const ls = size * 0.2;
      const lx = (size - ls) / 2, ly = (size - ls) / 2;
      ctx.fillStyle = bgColor;
      ctx.fillRect(lx - 4, ly - 4, ls + 8, ls + 8);
      ctx.drawImage(img, lx, ly, ls, ls);
    } catch { /* skip bad logo */ }
  }

  return canvas.toBuffer('image/png');
}

async function generateQRDataUrl(data, opts = {}) {
  return `data:image/png;base64,${(await generateQRBuffer(data, opts)).toString('base64')}`;
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static('public'));

// =============================================================================
// Auth routes
// =============================================================================

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const hash = await bcrypt.hash(password, 10);
  const id = nanoid();
  try {
    db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
      .run(id, email.toLowerCase().trim(), hash, name?.trim() || null);
    const token = jwt.sign({ userId: id, email: email.toLowerCase().trim() }, JWT_SECRET, { expiresIn: '30d' });
    // Welcome email (non-blocking)
    sendEmail({ to: email.toLowerCase().trim(), subject: 'Welcome to MiniAd QR', html: welcomeEmail(name?.trim()) }).catch(() => {});
    res.json({ token, user: { id, email: email.toLowerCase().trim(), name: name?.trim() || null } });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// =============================================================================
// Logo upload
// =============================================================================

app.post('/api/logo/upload', auth, logoUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message.includes('Only image'))
    return res.status(400).json({ error: err.message });
  next(err);
});

// =============================================================================
// Email — inbound webhook (called by Cloudflare Worker)
// =============================================================================

app.post('/api/email/inbound', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (EMAIL_WEBHOOK_SECRET && secret !== EMAIL_WEBHOOK_SECRET)
    return res.status(401).json({ error: 'Forbidden' });

  const { from, to, subject, text, html } = req.body;
  if (!from) return res.status(400).json({ error: 'Missing from' });

  db.prepare('INSERT INTO inbox (from_addr, to_addr, subject, body_text, body_html) VALUES (?, ?, ?, ?, ?)')
    .run(from, to || null, subject || '(no subject)', text || null, html || null);

  res.json({ ok: true });
});

// =============================================================================
// Email — inbox API
// =============================================================================

app.get('/api/email/inbox', auth, (req, res) => {
  const emails = db.prepare('SELECT id, from_addr, to_addr, subject, received_at, is_read FROM inbox ORDER BY received_at DESC LIMIT 100').all();
  const unread = db.prepare('SELECT COUNT(*) as count FROM inbox WHERE is_read = 0').get().count;
  res.json({ emails, unread });
});

app.get('/api/email/inbox/:id', auth, (req, res) => {
  const email = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  if (!email.is_read) db.prepare('UPDATE inbox SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json(email);
});

app.patch('/api/email/inbox/:id/read', auth, (req, res) => {
  db.prepare('UPDATE inbox SET is_read = ? WHERE id = ?').run(req.body.read ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/email/inbox/:id', auth, (req, res) => {
  db.prepare('DELETE FROM inbox WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Send a test email to verify Resend is working
app.post('/api/email/test', auth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const result = await sendEmail({
    to: user.notif_email || user.email,
    subject: 'MiniAd QR — test email',
    html: emailWrap(`<h1 style="color:#7c6af7;font-size:1.3rem;margin:0 0 12px">Test email</h1>
      <p style="color:#8888a8;line-height:1.6">Your Resend integration is working correctly.</p>`),
  });
  if (result) res.json({ ok: true });
  else res.status(500).json({ error: 'Email send failed — check RESEND_API_KEY' });
});

// =============================================================================
// Notification settings
// =============================================================================

app.get('/api/settings/notifications', auth, (req, res) => {
  const user = db.prepare(
    'SELECT notif_scan_enabled, notif_scan_threshold, notif_expiry_enabled, notif_expiry_hours, notif_email FROM users WHERE id = ?'
  ).get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(user);
});

app.patch('/api/settings/notifications', auth, (req, res) => {
  const { notif_scan_enabled, notif_scan_threshold, notif_expiry_enabled, notif_expiry_hours, notif_email } = req.body;
  db.prepare(`UPDATE users SET
    notif_scan_enabled   = COALESCE(?, notif_scan_enabled),
    notif_scan_threshold = COALESCE(?, notif_scan_threshold),
    notif_expiry_enabled = COALESCE(?, notif_expiry_enabled),
    notif_expiry_hours   = COALESCE(?, notif_expiry_hours),
    notif_email          = COALESCE(?, notif_email)
    WHERE id = ?`)
    .run(
      notif_scan_enabled  != null ? (notif_scan_enabled ? 1 : 0) : null,
      notif_scan_threshold ?? null,
      notif_expiry_enabled != null ? (notif_expiry_enabled ? 1 : 0) : null,
      notif_expiry_hours ?? null,
      notif_email ?? null,
      req.user.userId
    );
  res.json({ ok: true });
});

// =============================================================================
// Admin API
// =============================================================================

// Verify the caller is an admin (used by admin.html on load)
app.get('/api/admin/me', adminAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.user.userId);
  res.json(user);
});

// Platform overview
app.get('/api/admin/overview', adminAuth, (req, res) => {
  const totalUsers  = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const totalCodes  = db.prepare('SELECT COUNT(*) AS n FROM dynamic_codes').get().n;
  const totalScans  = db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;
  const unreadEmail = db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE is_read = 0').get().n;
  const daily = db.prepare(`
    SELECT date(scanned_at,'unixepoch') AS day, COUNT(*) AS count
    FROM scans
    WHERE scanned_at >= unixepoch() - 86400*30
    GROUP BY day ORDER BY day ASC
  `).all();
  res.json({ totalUsers, totalCodes, totalScans, unreadEmail, daily });
});

// All users with their stats
app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.is_admin, u.created_at,
      COUNT(DISTINCT d.slug) AS code_count,
      COALESCE(SUM(d.scan_count), 0) AS total_scans
    FROM users u
    LEFT JOIN dynamic_codes d ON d.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// Toggle admin status
app.patch('/api/admin/users/:id/admin', adminAuth, (req, res) => {
  const target = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.userId) return res.status(400).json({ error: 'Cannot change your own admin status' });
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.is_admin ? 1 : 0, target.id);
  res.json({ ok: true });
});

// All QR codes with owner info, ordered by scan_count desc
app.get('/api/admin/codes', adminAuth, (req, res) => {
  const codes = db.prepare(`
    SELECT d.slug, d.label, d.destination, d.scan_count, d.scan_limit,
           d.expires_at, d.created_at, u.email AS owner_email, u.name AS owner_name
    FROM dynamic_codes d
    LEFT JOIN users u ON u.id = d.user_id
    ORDER BY d.scan_count DESC
    LIMIT 200
  `).all();
  res.json(codes);
});

// Recent scans across the platform
app.get('/api/admin/scans/recent', adminAuth, (req, res) => {
  const scans = db.prepare(`
    SELECT s.scanned_at, s.ip, s.user_agent,
           d.slug, d.label, u.email AS owner_email
    FROM scans s
    JOIN dynamic_codes d ON d.slug = s.code_slug
    LEFT JOIN users u ON u.id = d.user_id
    ORDER BY s.scanned_at DESC
    LIMIT 50
  `).all();
  res.json(scans);
});

// Admin inbox (same data, admin-gated)
app.get('/api/admin/inbox', adminAuth, (req, res) => {
  const emails = db.prepare('SELECT id, from_addr, to_addr, subject, received_at, is_read FROM inbox ORDER BY received_at DESC LIMIT 200').all();
  const unread = db.prepare('SELECT COUNT(*) AS count FROM inbox WHERE is_read = 0').get().count;
  res.json({ emails, unread });
});

app.get('/api/admin/inbox/:id', adminAuth, (req, res) => {
  const email = db.prepare('SELECT * FROM inbox WHERE id = ?').get(req.params.id);
  if (!email) return res.status(404).json({ error: 'Not found' });
  if (!email.is_read) db.prepare('UPDATE inbox SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json(email);
});

app.delete('/api/admin/inbox/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM inbox WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// =============================================================================
// Public redirect — expiry, scan limits, smart routing
// =============================================================================

app.get('/r/:slug', async (req, res) => {
  const row = db.prepare('SELECT * FROM dynamic_codes WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).send(inactivePage('Not Found', 'This QR code does not exist.'));

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at && row.expires_at < now)
    return res.status(410).send(inactivePage('QR Code Expired', `This QR code expired on ${new Date(row.expires_at * 1000).toLocaleDateString()}.`));
  if (row.scan_limit && row.scan_count >= row.scan_limit)
    return res.status(410).send(inactivePage('Scan Limit Reached', `This QR code reached its limit of ${row.scan_limit} scan${row.scan_limit !== 1 ? 's' : ''}.`));

  recordScan(row.slug, clientIp(req), req.headers['user-agent'] || null);

  // Non-blocking scan alert check
  checkScanAlert(row.slug).catch(() => {});

  // Smart routing
  const rules = db.prepare('SELECT * FROM routing_rules WHERE code_slug = ? ORDER BY sort_order ASC').all(row.slug);
  if (rules.length) {
    const ua = req.headers['user-agent'] || '';
    for (const rule of rules) {
      if (rule.rule_type === 'device' && matchesDevice(rule.match_value, ua))
        return res.redirect(302, rule.destination);
    }
    const countryRules = rules.filter(r => r.rule_type === 'country');
    if (countryRules.length) {
      const country = await lookupCountry(clientIp(req));
      for (const rule of countryRules) {
        if (country && rule.match_value.toUpperCase() === country.toUpperCase())
          return res.redirect(302, rule.destination);
      }
    }
  }

  res.redirect(302, row.destination);
});

// =============================================================================
// Static QR
// =============================================================================

app.post('/api/static', async (req, res) => {
  const { url, size = 400, color = '#000000', bgColor = '#FFFFFF', bodyStyle = 'square', eyeStyle = 'frame0', logo = '' } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    res.set('Content-Type', 'image/png').send(await generateQRBuffer(url, { color, bgColor, bodyStyle, eyeStyle, logo, size }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================================================
// Dynamic QR (auth required)
// =============================================================================

const saveRules = db.transaction((slug, rules) => {
  db.prepare('DELETE FROM routing_rules WHERE code_slug = ?').run(slug);
  for (let i = 0; i < rules.length; i++) {
    const { rule_type, match_value, destination } = rules[i];
    if (!rule_type || !match_value || !destination) continue;
    db.prepare('INSERT INTO routing_rules (code_slug, rule_type, match_value, destination, sort_order) VALUES (?, ?, ?, ?, ?)').run(slug, rule_type, match_value, destination, i);
  }
});

app.post('/api/dynamic', auth, async (req, res) => {
  const { destination, label, slug: customSlug, color = '#000000', bgColor = '#FFFFFF', bodyStyle = 'square', eyeStyle = 'frame0', logo = '', scan_limit = null, expires_at = null, rules = [] } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination is required' });
  const slug = customSlug || nanoid(8);
  const redirectUrl = `${REDIRECT_BASE_URL}/${slug}`;
  try {
    db.prepare(`INSERT INTO dynamic_codes (id,slug,destination,label,user_id,qr_color,qr_bg_color,qr_body_style,qr_eye_style,qr_logo,scan_limit,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nanoid(), slug, destination, label || null, req.user.userId, color, bgColor, bodyStyle, eyeStyle, logo || null, scan_limit || null, expires_at || null);
    if (rules.length) saveRules(slug, rules);
    const qrDataUrl = await generateQRDataUrl(redirectUrl, { color, bgColor, bodyStyle, eyeStyle, logo });
    res.json({ slug, redirectUrl, destination, label, qrDataUrl });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Slug already taken' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dynamic', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, (SELECT COUNT(*) FROM routing_rules r WHERE r.code_slug = d.slug) AS rule_count
    FROM dynamic_codes d WHERE d.user_id = ? ORDER BY d.created_at DESC
  `).all(req.user.userId);
  res.json(rows);
});

app.get('/api/dynamic/:slug', auth, async (req, res) => {
  const row = db.prepare('SELECT * FROM dynamic_codes WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const redirectUrl = `${REDIRECT_BASE_URL}/${row.slug}`;
  const [qrDataUrl, rules] = await Promise.all([
    generateQRDataUrl(redirectUrl, { color: row.qr_color, bgColor: row.qr_bg_color, bodyStyle: row.qr_body_style, eyeStyle: row.qr_eye_style, logo: row.qr_logo || '' }),
    db.prepare('SELECT * FROM routing_rules WHERE code_slug = ? ORDER BY sort_order ASC').all(row.slug),
  ]);
  res.json({ ...row, redirectUrl, qrDataUrl, rules });
});

app.patch('/api/dynamic/:slug', auth, (req, res) => {
  const { destination, label, color, bgColor, bodyStyle, eyeStyle, logo, scan_limit, expires_at } = req.body;
  const row = db.prepare('SELECT id FROM dynamic_codes WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE dynamic_codes SET destination=COALESCE(?,destination), label=COALESCE(?,label), qr_color=COALESCE(?,qr_color), qr_bg_color=COALESCE(?,qr_bg_color), qr_body_style=COALESCE(?,qr_body_style), qr_eye_style=COALESCE(?,qr_eye_style), qr_logo=COALESCE(?,qr_logo), scan_limit=?, expires_at=?, updated_at=unixepoch() WHERE slug=? AND user_id=?`)
    .run(destination||null, label||null, color||null, bgColor||null, bodyStyle||null, eyeStyle||null, logo||null, scan_limit??null, expires_at??null, req.params.slug, req.user.userId);
  res.json({ success: true });
});

app.delete('/api/dynamic/:slug', auth, (req, res) => {
  if (!db.prepare('DELETE FROM dynamic_codes WHERE slug=? AND user_id=?').run(req.params.slug, req.user.userId).changes)
    return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.put('/api/dynamic/:slug/rules', auth, (req, res) => {
  if (!db.prepare('SELECT id FROM dynamic_codes WHERE slug=? AND user_id=?').get(req.params.slug, req.user.userId))
    return res.status(404).json({ error: 'Not found' });
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  saveRules(req.params.slug, req.body);
  res.json({ success: true });
});

app.get('/api/dynamic/:slug/scans', auth, (req, res) => {
  const row = db.prepare('SELECT slug, label, scan_count FROM dynamic_codes WHERE slug=? AND user_id=?').get(req.params.slug, req.user.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const daily = db.prepare(`SELECT date(scanned_at,'unixepoch') AS day, COUNT(*) AS count FROM scans WHERE code_slug=? AND scanned_at>=unixepoch()-86400*30 GROUP BY day ORDER BY day ASC`).all(req.params.slug);
  const recent = db.prepare(`SELECT scanned_at, ip, user_agent FROM scans WHERE code_slug=? ORDER BY scanned_at DESC LIMIT 20`).all(req.params.slug);
  res.json({ slug: row.slug, label: row.label, total: row.scan_count, daily, recent });
});

app.get('/api/dashboard', auth, (req, res) => {
  const { count: totalCodes } = db.prepare('SELECT COUNT(*) as count FROM dynamic_codes WHERE user_id=?').get(req.user.userId);
  const { count: totalScans } = db.prepare(`SELECT COUNT(*) as count FROM scans s JOIN dynamic_codes d ON s.code_slug=d.slug WHERE d.user_id=?`).get(req.user.userId);
  const daily = db.prepare(`SELECT date(s.scanned_at,'unixepoch') AS day, COUNT(*) AS count FROM scans s JOIN dynamic_codes d ON s.code_slug=d.slug WHERE d.user_id=? AND s.scanned_at>=unixepoch()-86400*30 GROUP BY day ORDER BY day ASC`).all(req.user.userId);
  res.json({ totalCodes, totalScans, daily });
});

app.listen(PORT, () => {
  const flags = [
    'styled QR',
    resend ? 'Resend email' : 'no email',
  ];
  console.log(`QR server running at ${BASE_URL} [${flags.join(' · ')}]`);
});
