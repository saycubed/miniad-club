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
  )
`);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- Redirect endpoint for dynamic QR codes ---
app.get('/r/:slug', (req, res) => {
  const row = db.prepare('SELECT * FROM dynamic_codes WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).send('QR code not found');
  db.prepare('UPDATE dynamic_codes SET scan_count = scan_count + 1 WHERE slug = ?').run(req.params.slug);
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

// --- Dynamic QR: delete ---
app.delete('/api/dynamic/:slug', (req, res) => {
  const result = db.prepare('DELETE FROM dynamic_codes WHERE slug = ?').run(req.params.slug);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`QR server running at ${BASE_URL}`);
});
