const API = '';
let currentUser = null;

// --- Token helpers ---
const getToken = () => localStorage.getItem('qr_token');
const setToken = t => localStorage.setItem('qr_token', t);
const clearToken = () => localStorage.removeItem('qr_token');
const authHeaders = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` });

// =============================================================================
// Init
// =============================================================================

async function init() {
  const token = getToken();
  if (!token) return showAuth();
  try {
    const res = await fetch(`${API}/api/auth/me`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) { clearToken(); return showAuth(); }
    currentUser = await res.json();
    showApp();
  } catch {
    showAuth();
  }
}

function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
}

function showApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');
  document.getElementById('user-email').textContent = currentUser.name || currentUser.email;
}

// =============================================================================
// Auth forms
// =============================================================================

document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isLogin = btn.dataset.auth === 'login';
    document.getElementById('login-form').classList.toggle('hidden', !isLogin);
    document.getElementById('signup-form').classList.toggle('hidden', isLogin);
    document.getElementById('auth-error').classList.add('hidden');
  });
});

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error);
  setToken(data.token);
  currentUser = data.user;
  showApp();
});

document.getElementById('signup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const res = await fetch(`${API}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password })
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error);
  setToken(data.token);
  currentUser = data.user;
  showApp();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  clearToken();
  currentUser = null;
  showAuth();
});

// =============================================================================
// Tab switching
// =============================================================================

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => { t.classList.add('hidden'); t.classList.remove('active'); });
    btn.classList.add('active');
    const tab = document.getElementById(`tab-${btn.dataset.tab}`);
    tab.classList.remove('hidden');
    tab.classList.add('active');
    if (btn.dataset.tab === 'manage') loadManage();
  });
});

// =============================================================================
// Static QR
// =============================================================================

document.getElementById('static-generate').addEventListener('click', async () => {
  const url = document.getElementById('static-url').value.trim();
  const format = document.getElementById('static-format').value;
  const size = document.getElementById('static-size').value;
  if (!url) return alert('Please enter a URL or text.');

  const res = await fetch(`${API}/api/static`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, format, size: parseInt(size) })
  });
  if (!res.ok) { alert('Error generating QR code'); return; }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const img = document.getElementById('static-qr-img');
  const dl = document.getElementById('static-download');
  img.src = objectUrl;
  dl.href = objectUrl;
  dl.download = `qrcode.${format}`;
  document.getElementById('static-result').classList.remove('hidden');
});

// =============================================================================
// Dynamic QR (create)
// =============================================================================

document.getElementById('dyn-create').addEventListener('click', async () => {
  const destination = document.getElementById('dyn-url').value.trim();
  const label = document.getElementById('dyn-label').value.trim();
  const slug = document.getElementById('dyn-slug').value.trim();
  if (!destination) return alert('Please enter a destination URL.');

  const res = await fetch(`${API}/api/dynamic`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ destination, label, slug: slug || undefined })
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Error creating QR code'); return; }

  document.getElementById('dyn-qr-img').src = data.qrDataUrl;
  document.getElementById('dyn-short-url').href = data.redirectUrl;
  document.getElementById('dyn-short-url').textContent = data.redirectUrl;
  document.getElementById('dyn-dest').textContent = data.destination;
  const dl = document.getElementById('dyn-download');
  dl.href = data.qrDataUrl;
  dl.download = `qr-${data.slug}.png`;
  document.getElementById('dyn-result').classList.remove('hidden');
});

// =============================================================================
// Manage tab
// =============================================================================

async function loadManage() {
  await Promise.all([loadDashboardSummary(), loadCodes()]);
}

async function loadDashboardSummary() {
  const res = await fetch(`${API}/api/dashboard`, { headers: authHeaders() });
  if (!res.ok) return;
  const { totalCodes, totalScans, daily } = await res.json();

  const maxDay = daily.length ? Math.max(...daily.map(d => d.count)) : 1;
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const dailyMap = Object.fromEntries(daily.map(d => [d.day, d.count]));
  const bars = days.map(day => {
    const count = dailyMap[day] || 0;
    const pct = maxDay ? Math.round((count / maxDay) * 100) : 0;
    return `<div class="mini-bar-col"><div class="mini-bar" style="height:${pct}%" title="${count} on ${day}"></div></div>`;
  }).join('');

  document.getElementById('dashboard-summary').innerHTML = `
    <div class="summary-card">
      <div class="summary-num">${totalCodes}</div>
      <div class="summary-label">QR Codes</div>
    </div>
    <div class="summary-card">
      <div class="summary-num">${totalScans}</div>
      <div class="summary-label">Total Scans</div>
    </div>
    <div class="summary-card summary-chart">
      <div class="summary-label" style="margin-bottom:0.4rem">Scans — last 30 days</div>
      <div class="mini-bar-chart">${bars}</div>
    </div>
  `;
}

async function loadCodes() {
  const res = await fetch(`${API}/api/dynamic`, { headers: authHeaders() });
  const codes = await res.json();
  const container = document.getElementById('codes-list');

  if (!codes.length) {
    container.innerHTML = '<div class="empty">No dynamic QR codes yet. Create one from the Dynamic QR tab.</div>';
    return;
  }

  container.innerHTML = codes.map(c => `
    <div class="code-item" data-slug="${c.slug}">
      <div class="code-info">
        <div class="code-label">${escHtml(c.label || 'Untitled')}</div>
        <div class="code-slug">/r/${c.slug}</div>
        <div class="code-dest">${escHtml(c.destination)}</div>
        <div class="code-scans">${c.scan_count} scan${c.scan_count !== 1 ? 's' : ''}</div>
      </div>
      <div class="code-actions">
        <button class="btn secondary small" onclick="viewCode('${c.slug}')">QR</button>
        <button class="btn secondary small" onclick="openStats('${c.slug}')">Stats</button>
        <button class="btn secondary small" onclick="openEdit('${c.slug}', '${encodeURIComponent(c.destination)}', '${encodeURIComponent(c.label || '')}')">Edit</button>
        <button class="btn danger small" onclick="deleteCode('${c.slug}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function viewCode(slug) {
  const res = await fetch(`${API}/api/dynamic/${slug}`, { headers: authHeaders() });
  const data = await res.json();
  const win = window.open('', '_blank', 'width=420,height=520');
  win.document.write(`<html><body style="background:#0f0f13;color:#e8e8f0;font-family:sans-serif;text-align:center;padding:2rem">
    <h2 style="color:#7c6af7">/r/${slug}</h2>
    <img src="${data.qrDataUrl}" style="background:#fff;padding:8px;border-radius:8px;max-width:280px" />
    <p style="margin-top:1rem;font-size:0.85rem;color:#8888a8;word-break:break-all">${escHtml(data.destination)}</p>
    <p style="font-size:0.8rem;color:#5af7a0;margin-top:0.5rem">${data.scan_count} scans</p>
    <a href="${data.qrDataUrl}" download="qr-${slug}.png" style="display:inline-block;margin-top:1rem;padding:0.5rem 1rem;background:#7c6af7;color:#fff;border-radius:8px;text-decoration:none">Download PNG</a>
  </body></html>`);
}

function openEdit(slug, dest, label) {
  document.getElementById('edit-slug').value = slug;
  document.getElementById('edit-dest').value = decodeURIComponent(dest);
  document.getElementById('edit-label').value = decodeURIComponent(label);
  document.getElementById('edit-modal').classList.remove('hidden');
}

document.getElementById('edit-cancel').addEventListener('click', () => {
  document.getElementById('edit-modal').classList.add('hidden');
});

document.getElementById('edit-save').addEventListener('click', async () => {
  const slug = document.getElementById('edit-slug').value;
  const destination = document.getElementById('edit-dest').value.trim();
  const label = document.getElementById('edit-label').value.trim();
  const res = await fetch(`${API}/api/dynamic/${slug}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ destination, label })
  });
  if (res.ok) { document.getElementById('edit-modal').classList.add('hidden'); loadCodes(); }
  else alert('Failed to update');
});

async function deleteCode(slug) {
  if (!confirm(`Delete /r/${slug}? This cannot be undone.`)) return;
  await fetch(`${API}/api/dynamic/${slug}`, { method: 'DELETE', headers: authHeaders() });
  loadManage();
}

document.getElementById('refresh-list').addEventListener('click', loadManage);

// =============================================================================
// Stats modal
// =============================================================================

document.getElementById('stats-close').addEventListener('click', () => {
  document.getElementById('stats-modal').classList.add('hidden');
});

function deviceType(ua) {
  if (!ua) return 'Unknown';
  if (/mobile|android|iphone/i.test(ua)) return 'Mobile';
  if (/ipad|tablet/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

async function openStats(slug) {
  const res = await fetch(`${API}/api/dynamic/${slug}/scans`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed to load stats'); return; }

  document.getElementById('stats-title').textContent =
    `Analytics — ${data.label || slug}`;

  const maxCount = data.daily.length ? Math.max(...data.daily.map(d => d.count)) : 1;
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const dailyMap = Object.fromEntries(data.daily.map(d => [d.day, d.count]));

  const bars = days.map(day => {
    const count = dailyMap[day] || 0;
    const pct = maxCount ? Math.round((count / maxCount) * 100) : 0;
    const label = day.slice(5);
    return `<div class="bar-col">
      <div class="bar-wrap"><div class="bar" style="height:${pct}%" title="${count} scan${count !== 1 ? 's' : ''} on ${day}"></div></div>
      <div class="bar-label">${label}</div>
    </div>`;
  }).join('');

  const recentRows = data.recent.length
    ? data.recent.map(s => {
        const dt = new Date(s.scanned_at * 1000).toLocaleString();
        const device = deviceType(s.user_agent);
        return `<tr><td>${dt}</td><td>${device}</td><td class="ip-cell">${s.ip || '—'}</td></tr>`;
      }).join('')
    : '<tr><td colspan="3" class="empty">No scans yet</td></tr>';

  const last30 = data.daily.reduce((a, d) => a + d.count, 0);
  const lastScan = data.recent[0] ? new Date(data.recent[0].scanned_at * 1000).toLocaleDateString() : '—';

  document.getElementById('stats-content').innerHTML = `
    <div class="stats-summary">
      <div class="stat-box"><div class="stat-num">${data.total}</div><div class="stat-label">Total Scans</div></div>
      <div class="stat-box"><div class="stat-num">${last30}</div><div class="stat-label">Last 30 Days</div></div>
      <div class="stat-box"><div class="stat-num">${lastScan}</div><div class="stat-label">Last Scan</div></div>
    </div>
    <h4 class="chart-title">Daily scans (last 30 days)</h4>
    <div class="bar-chart">${bars}</div>
    <h4 class="chart-title" style="margin-top:1.5rem">Recent scans</h4>
    <div class="scan-table-wrap">
      <table class="scan-table">
        <thead><tr><th>Time</th><th>Device</th><th>IP</th></tr></thead>
        <tbody>${recentRows}</tbody>
      </table>
    </div>
  `;

  document.getElementById('stats-modal').classList.remove('hidden');
}

// =============================================================================
// Start
// =============================================================================

init();
