const express = require('express');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const cors = require('cors');
const path = require('path');

const app = express();
const db = new Database('qrcodes.db');
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Init DB
db.exec(`
  CREATE TABLE IF NOT EXISTS dynamic_codes (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    destination TEXT NOT NULL,
    label TEXT,
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

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const recordScan = db.transaction((slug, ip, ua) => {
  db.prepare('UPDATE dynamic_codes SET scan_count = scan_count + 1 WHERE slug = ?').run(slug);
  db.prepare('INSERT INTO scans (code_slug, ip, user_agent) VALUES (?, ?, ?)').run(slug, ip, ua);
});

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null;
}

// --- Redirect endpoint for dynamic QR codes ---
app.get('/r/:slug', (req, res) => {
  const row = db.prepare('SELECT * FROM dynamic_codes WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).send('QR code not found');
  recordScan(req.params.slug, clientIp(req), req.headers['user-agent'] || null);
  res.redirect(302, row.destination);
});

// --- Static QR: generate and return image ---
app.post('/api/static', async (req, res) => {
  const { url, format = 'png', size = 300 } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const opts = { width: size, margin: 2 };
    if (format === 'svg') {
      const svg = await QRCode.toString(url, { type: 'svg', ...opts });
      res.set('Content-Type', 'image/svg+xml');
      return res.send(svg);
    }
    const buffer = await QRCode.toBuffer(url, { type: 'png', ...opts });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Dynamic QR: create ---
app.post('/api/dynamic', async (req, res) => {
  const { destination, label, slug: customSlug } = req.body;
  if (!destination) return res.status(400).json({ error: 'destination is required' });

  const slug = customSlug || nanoid(8);
  const redirectUrl = `${BASE_URL}/r/${slug}`;

  try {
    db.prepare(
      'INSERT INTO dynamic_codes (id, slug, destination, label) VALUES (?, ?, ?, ?)'
    ).run(nanoid(), slug, destination, label || null);

    const qrDataUrl = await QRCode.toDataURL(redirectUrl, { width: 300, margin: 2 });
    res.json({ slug, redirectUrl, destination, label, qrDataUrl });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Slug already taken' });
    res.status(500).json({ error: err.message });
  }
});

// --- Dynamic QR: list all ---
app.get('/api/dynamic', (req, res) => {
  const rows = db.prepare('SELECT * FROM dynamic_codes ORDER BY created_at DESC').all();
  res.json(rows);
});

// --- Dynamic QR: get one ---
app.get('/api/dynamic/:slug', async (req, res) => {
  const row = db.prepare('SELECT * FROM dynamic_codes WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const redirectUrl = `${BASE_URL}/r/${row.slug}`;
  const qrDataUrl = await QRCode.toDataURL(redirectUrl, { width: 300, margin: 2 });
  res.json({ ...row, redirectUrl, qrDataUrl });
});

// --- Dynamic QR: update destination ---
app.patch('/api/dynamic/:slug', (req, res) => {
  const { destination, label } = req.body;
  const row = db.prepare('SELECT * FROM dynamic_codes WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Not found' });

  db.prepare(
    'UPDATE dynamic_codes SET destination = COALESCE(?, destination), label = COALESCE(?, label), updated_at = unixepoch() WHERE slug = ?'
  ).run(destination || null, label || null, req.params.slug);

  res.json({ success: true });
});

// --- Dynamic QR: scan stats ---
app.get('/api/dynamic/:slug/scans', (req, res) => {
  const row = db.prepare('SELECT slug, label, scan_count FROM dynamic_codes WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Not found' });

  // Daily counts for last 30 days
  const daily = db.prepare(`
    SELECT date(scanned_at, 'unixepoch') AS day, COUNT(*) AS count
    FROM scans
    WHERE code_slug = ? AND scanned_at >= unixepoch() - 86400 * 30
    GROUP BY day ORDER BY day ASC
  `).all(req.params.slug);

  // 20 most recent scans
  const recent = db.prepare(`
    SELECT scanned_at, ip, user_agent
    FROM scans WHERE code_slug = ?
    ORDER BY scanned_at DESC LIMIT 20
  `).all(req.params.slug);

  res.json({ slug: row.slug, label: row.label, total: row.scan_count, daily, recent });
});

// --- Dynamic QR: delete ---
app.delete('/api/dynamic/:slug', (req, res) => {
  const result = db.prepare('DELETE FROM dynamic_codes WHERE slug = ?').run(req.params.slug);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`QR server running at ${BASE_URL}`);
});
