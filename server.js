require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');

const app = express();
const db = new Database('qrcodes.db');
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';

// --- DB schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_scans_slug ON scans(code_slug);
  CREATE INDEX IF NOT EXISTS idx_scans_at ON scans(scanned_at);
`);

// Migrations for existing DBs
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(dynamic_codes)').all().map(c => c.name);
  const toAdd = {
    user_id: 'TEXT REFERENCES users(id) ON DELETE CASCADE',
    qr_color: "TEXT DEFAULT '#000000'",
    qr_bg_color: "TEXT DEFAULT '#FFFFFF'",
    qr_body_style: "TEXT DEFAULT 'square'",
    qr_eye_style: "TEXT DEFAULT 'frame0'",
    qr_logo: 'TEXT DEFAULT NULL',
  };
  for (const [col, def] of Object.entries(toAdd)) {
    if (!cols.includes(col)) {
      db.prepare(`ALTER TABLE dynamic_codes ADD COLUMN ${col} ${def}`).run();
    }
  }
})();

// =============================================================================
// QR generation — uses QR Code Monkey API when RAPIDAPI_KEY is set,
// falls back to local qrcode package
// =============================================================================

const QR_API = 'https://qrcode-monkey.p.rapidapi.com/qr/custom';

async function generateQRBuffer(data, opts = {}) {
  const {
    color = '#000000',
    bgColor = '#FFFFFF',
    bodyStyle = 'square',
    eyeStyle = 'frame0',
    logo = '',
    size = 400,
  } = opts;

  if (!RAPIDAPI_KEY) {
    // local fallback (no color/logo support)
    return QRCode.toBuffer(data, { type: 'png', width: size, margin: 2 });
  }

  const config = {
    body: bodyStyle,
    eye: eyeStyle,
    eyeBall: 'ball0',
    bodyColor: color,
    bgColor: bgColor,
    eye1Color: color,
    eye2Color: color,
    eye3Color: color,
    gradientColor1: '',
    gradientColor2: '',
    gradientType: 'linear',
    gradientOnEyes: 'true',
    logo: logo || '',
    logoMode: logo ? 'default' : undefined,
  };

  const res = await fetch(QR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RapidAPI-Key': RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'qrcode-monkey.p.rapidapi.com',
    },
    body: JSON.stringify({ data, config, size, download: false, file: 'png' }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QR API ${res.status}: ${text}`);
  }

  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

async function generateQRDataUrl(data, opts = {}) {
  const buf = await generateQRBuffer(data, opts);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// --- Auth & scan helpers ---
function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const recordScan = db.transaction((slug, ip, ua) => {
  db.prepare('UPDATE dynamic_codes SET scan_count = scan_count + 1 WHERE slug = ?').run(slug);
  db.prepare('INSERT INTO scans (code_slug, ip, user_agent) VALUES (?, ?, ?)').run(slug, ip, ua);
});

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null;
}

// --- Logo upload (multer) ---
const logoStorage = multer.diskStorage({
  destination: 'public/uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${nanoid(12)}${ext}`);
  },
});
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only image files are allowed (png, jpg, gif, svg, webp)'));
  },
});

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// =============================================================================
// Auth
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
  if (err instanceof multer.MulterError || err.message.includes('Only image')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// =============================================================================
// Public redirect
// =============================================================================

app.get('/r/:slug', (req, res) => {
  const row = db.prepare('SELECT destination FROM dynamic_codes WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).send('QR code not found');
  recordScan(req.params.slug, clientIp(req), req.headers['user-agent'] || null);
  res.redirect(302, row.destination);
});

// =============================================================================
// Static QR
// =============================================================================

app.post('/api/static', async (req, res) => {
  const {
    url, size = 400,
    color = '#000000', bgColor = '#FFFFFF',
    bodyStyle = 'square', eyeStyle = 'frame0',
    logo = '',
  } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const buf = await generateQRBuffer(url, { color, bgColor, bodyStyle, eyeStyle, logo, size });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Dynamic QR (auth required)
// =============================================================================

app.post('/api/dynamic', auth, async (req, res) => {
  const {
    destination, label, slug: customSlug,
    color = '#000000', bgColor = '#FFFFFF',
    bodyStyle = 'square', eyeStyle = 'frame0',
    logo = '',
  } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination is required' });
  const slug = customSlug || nanoid(8);
  const redirectUrl = `${BASE_URL}/r/${slug}`;
  try {
    db.prepare(`INSERT INTO dynamic_codes
      (id, slug, destination, label, user_id, qr_color, qr_bg_color, qr_body_style, qr_eye_style, qr_logo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(nanoid(), slug, destination, label || null, req.user.userId, color, bgColor, bodyStyle, eyeStyle, logo || null);
    const qrDataUrl = await generateQRDataUrl(redirectUrl, { color, bgColor, bodyStyle, eyeStyle, logo });
    res.json({ slug, redirectUrl, destination, label, qrDataUrl });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Slug already taken' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dynamic', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM dynamic_codes WHERE user_id = ? ORDER BY created_at DESC').all(req.user.userId);
  res.json(rows);
});

app.get('/api/dynamic/:slug', auth, async (req, res) => {
  const row = db.prepare('SELECT * FROM dynamic_codes WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const redirectUrl = `${BASE_URL}/r/${row.slug}`;
  const qrDataUrl = await generateQRDataUrl(redirectUrl, {
    color: row.qr_color, bgColor: row.qr_bg_color,
    bodyStyle: row.qr_body_style, eyeStyle: row.qr_eye_style,
    logo: row.qr_logo || '',
  });
  res.json({ ...row, redirectUrl, qrDataUrl });
});

app.patch('/api/dynamic/:slug', auth, async (req, res) => {
  const {
    destination, label,
    color, bgColor, bodyStyle, eyeStyle, logo,
  } = req.body;
  const row = db.prepare('SELECT id FROM dynamic_codes WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE dynamic_codes SET
    destination  = COALESCE(?, destination),
    label        = COALESCE(?, label),
    qr_color     = COALESCE(?, qr_color),
    qr_bg_color  = COALESCE(?, qr_bg_color),
    qr_body_style = COALESCE(?, qr_body_style),
    qr_eye_style  = COALESCE(?, qr_eye_style),
    qr_logo      = COALESCE(?, qr_logo),
    updated_at   = unixepoch()
    WHERE slug = ? AND user_id = ?`)
    .run(destination||null, label||null, color||null, bgColor||null, bodyStyle||null, eyeStyle||null, logo||null, req.params.slug, req.user.userId);
  res.json({ success: true });
});

app.delete('/api/dynamic/:slug', auth, (req, res) => {
  const result = db.prepare('DELETE FROM dynamic_codes WHERE slug = ? AND user_id = ?').run(req.params.slug, req.user.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.get('/api/dynamic/:slug/scans', auth, (req, res) => {
  const row = db.prepare('SELECT slug, label, scan_count FROM dynamic_codes WHERE slug = ? AND user_id = ?').get(req.params.slug, req.user.userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const daily = db.prepare(`
    SELECT date(scanned_at, 'unixepoch') AS day, COUNT(*) AS count
    FROM scans WHERE code_slug = ? AND scanned_at >= unixepoch() - 86400 * 30
    GROUP BY day ORDER BY day ASC
  `).all(req.params.slug);
  const recent = db.prepare(`
    SELECT scanned_at, ip, user_agent FROM scans WHERE code_slug = ?
    ORDER BY scanned_at DESC LIMIT 20
  `).all(req.params.slug);
  res.json({ slug: row.slug, label: row.label, total: row.scan_count, daily, recent });
});

app.get('/api/dashboard', auth, (req, res) => {
  const { count: totalCodes } = db.prepare('SELECT COUNT(*) as count FROM dynamic_codes WHERE user_id = ?').get(req.user.userId);
  const { count: totalScans } = db.prepare(`
    SELECT COUNT(*) as count FROM scans s
    JOIN dynamic_codes d ON s.code_slug = d.slug WHERE d.user_id = ?
  `).get(req.user.userId);
  const daily = db.prepare(`
    SELECT date(s.scanned_at, 'unixepoch') AS day, COUNT(*) AS count
    FROM scans s JOIN dynamic_codes d ON s.code_slug = d.slug
    WHERE d.user_id = ? AND s.scanned_at >= unixepoch() - 86400 * 30
    GROUP BY day ORDER BY day ASC
  `).all(req.user.userId);
  res.json({ totalCodes, totalScans, daily });
});

app.listen(PORT, () => console.log(`QR server running at ${BASE_URL}${RAPIDAPI_KEY ? ' [RapidAPI QR enabled]' : ' [local QR fallback]'}`));
