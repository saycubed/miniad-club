const API = '';
let currentUser = null;

// --- Token helpers ---
const getToken = () => localStorage.getItem('qr_token');
const setToken = t => localStorage.setItem('qr_token', t);
const clearToken = () => localStorage.removeItem('qr_token');
const authHeaders = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` });

// =============================================================================
// Color picker sync (color swatch <-> hex text field)
// =============================================================================

function bindColorPair(colorId, hexId) {
  const picker = document.getElementById(colorId);
  const hex = document.getElementById(hexId);
  picker.addEventListener('input', () => { hex.value = picker.value.toUpperCase(); });
  hex.addEventListener('input', () => {
    if (/^#[0-9A-Fa-f]{6}$/.test(hex.value)) picker.value = hex.value;
  });
}

bindColorPair('static-color', 'static-color-hex');
bindColorPair('static-bg-color', 'static-bg-color-hex');
bindColorPair('dyn-color', 'dyn-color-hex');
bindColorPair('dyn-bg-color', 'dyn-bg-color-hex');
bindColorPair('edit-color', 'edit-color-hex');
bindColorPair('edit-bg-color', 'edit-bg-color-hex');

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
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: document.getElementById('login-email').value.trim(),
      password: document.getElementById('login-password').value,
    })
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error);
  setToken(data.token); currentUser = data.user; showApp();
});

document.getElementById('signup-form').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await fetch(`${API}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('signup-name').value.trim(),
      email: document.getElementById('signup-email').value.trim(),
      password: document.getElementById('signup-password').value,
    })
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error);
  setToken(data.token); currentUser = data.user; showApp();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  clearToken(); currentUser = null; showAuth();
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
    tab.classList.remove('hidden'); tab.classList.add('active');
    if (btn.dataset.tab === 'manage') loadManage();
  });
});

// =============================================================================
// Static QR
// =============================================================================

document.getElementById('static-generate').addEventListener('click', async () => {
  const url = document.getElementById('static-url').value.trim();
  if (!url) return alert('Please enter a URL or text.');

  const btn = document.getElementById('static-generate');
  btn.textContent = 'Generating…'; btn.disabled = true;

  try {
    const res = await fetch(`${API}/api/static`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        size: parseInt(document.getElementById('static-size').value),
        color: document.getElementById('static-color').value,
        bgColor: document.getElementById('static-bg-color').value,
        bodyStyle: document.getElementById('static-body-style').value,
        eyeStyle: document.getElementById('static-eye-style').value,
        logo: document.getElementById('static-logo').value.trim(),
      })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    document.getElementById('static-qr-img').src = objectUrl;
    document.getElementById('static-download').href = objectUrl;
    document.getElementById('static-result').classList.remove('hidden');
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.textContent = 'Generate QR'; btn.disabled = false;
  }
});

// =============================================================================
// Dynamic QR (create)
// =============================================================================

document.getElementById('dyn-create').addEventListener('click', async () => {
  const destination = document.getElementById('dyn-url').value.trim();
  if (!destination) return alert('Please enter a destination URL.');

  const btn = document.getElementById('dyn-create');
  btn.textContent = 'Creating…'; btn.disabled = true;

  try {
    const res = await fetch(`${API}/api/dynamic`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        destination,
        label: document.getElementById('dyn-label').value.trim(),
        slug: document.getElementById('dyn-slug').value.trim() || undefined,
        color: document.getElementById('dyn-color').value,
        bgColor: document.getElementById('dyn-bg-color').value,
        bodyStyle: document.getElementById('dyn-body-style').value,
        eyeStyle: document.getElementById('dyn-eye-style').value,
        logo: document.getElementById('dyn-logo').value.trim(),
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error creating QR code');
    document.getElementById('dyn-qr-img').src = data.qrDataUrl;
    document.getElementById('dyn-short-url').href = data.redirectUrl;
    document.getElementById('dyn-short-url').textContent = data.redirectUrl;
    document.getElementById('dyn-dest').textContent = data.destination;
    document.getElementById('dyn-download').href = data.qrDataUrl;
    document.getElementById('dyn-download').download = `qr-${data.slug}.png`;
    document.getElementById('dyn-result').classList.remove('hidden');
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.textContent = 'Create Dynamic QR'; btn.disabled = false;
  }
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
    <div class="summary-card"><div class="summary-num">${totalCodes}</div><div class="summary-label">QR Codes</div></div>
    <div class="summary-card"><div class="summary-num">${totalScans}</div><div class="summary-label">Total Scans</div></div>
    <div class="summary-card summary-chart">
      <div class="summary-label" style="margin-bottom:.4rem">Scans — last 30 days</div>
      <div class="mini-bar-chart">${bars}</div>
    </div>`;
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
        <div class="code-meta">
          <span class="code-scans">${c.scan_count} scan${c.scan_count !== 1 ? 's' : ''}</span>
          <span class="code-swatch" style="background:${c.qr_color || '#000'}" title="QR color"></span>
          <span class="code-swatch" style="background:${c.qr_bg_color || '#fff'};border:1px solid var(--border)" title="Background color"></span>
        </div>
      </div>
      <div class="code-actions">
        <button class="btn secondary small" onclick="viewCode('${c.slug}')">QR</button>
        <button class="btn secondary small" onclick="openStats('${c.slug}')">Stats</button>
        <button class="btn secondary small" onclick="openEdit('${c.slug}')">Edit</button>
        <button class="btn danger small" onclick="deleteCode('${c.slug}')">Delete</button>
      </div>
    </div>`).join('');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function viewCode(slug) {
  const res = await fetch(`${API}/api/dynamic/${slug}`, { headers: authHeaders() });
  const data = await res.json();
  const win = window.open('', '_blank', 'width=420,height=560');
  win.document.write(`<html><body style="background:#0f0f13;color:#e8e8f0;font-family:sans-serif;text-align:center;padding:2rem">
    <h2 style="color:#7c6af7">/r/${slug}</h2>
    <img src="${data.qrDataUrl}" style="background:#fff;padding:8px;border-radius:8px;max-width:300px" />
    <p style="margin-top:1rem;font-size:0.85rem;color:#8888a8;word-break:break-all">${escHtml(data.destination)}</p>
    <p style="font-size:0.8rem;color:#5af7a0;margin-top:0.5rem">${data.scan_count} scans</p>
    <a href="${data.qrDataUrl}" download="qr-${slug}.png" style="display:inline-block;margin-top:1rem;padding:.5rem 1rem;background:#7c6af7;color:#fff;border-radius:8px;text-decoration:none">Download PNG</a>
  </body></html>`);
}

async function openEdit(slug) {
  const res = await fetch(`${API}/api/dynamic/${slug}`, { headers: authHeaders() });
  const data = await res.json();

  document.getElementById('edit-slug').value = slug;
  document.getElementById('edit-dest').value = data.destination;
  document.getElementById('edit-label').value = data.label || '';
  document.getElementById('edit-logo').value = data.qr_logo || '';
  setColorPair('edit-color', 'edit-color-hex', data.qr_color || '#000000');
  setColorPair('edit-bg-color', 'edit-bg-color-hex', data.qr_bg_color || '#FFFFFF');
  setSelect('edit-body-style', data.qr_body_style || 'square');
  setSelect('edit-eye-style', data.qr_eye_style || 'frame0');
  document.getElementById('edit-modal').classList.remove('hidden');
}

function setColorPair(colorId, hexId, value) {
  document.getElementById(colorId).value = value;
  document.getElementById(hexId).value = value.toUpperCase();
}
function setSelect(id, value) {
  const el = document.getElementById(id);
  [...el.options].forEach(o => { o.selected = o.value === value; });
}

document.getElementById('edit-cancel').addEventListener('click', () => {
  document.getElementById('edit-modal').classList.add('hidden');
});

document.getElementById('edit-save').addEventListener('click', async () => {
  const slug = document.getElementById('edit-slug').value;
  const res = await fetch(`${API}/api/dynamic/${slug}`, {
    method: 'PATCH', headers: authHeaders(),
    body: JSON.stringify({
      destination: document.getElementById('edit-dest').value.trim(),
      label: document.getElementById('edit-label').value.trim(),
      color: document.getElementById('edit-color').value,
      bgColor: document.getElementById('edit-bg-color').value,
      bodyStyle: document.getElementById('edit-body-style').value,
      eyeStyle: document.getElementById('edit-eye-style').value,
      logo: document.getElementById('edit-logo').value.trim(),
    })
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

  document.getElementById('stats-title').textContent = `Analytics — ${data.label || slug}`;
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
    return `<div class="bar-col">
      <div class="bar-wrap"><div class="bar" style="height:${pct}%" title="${count} on ${day}"></div></div>
      <div class="bar-label">${day.slice(5)}</div>
    </div>`;
  }).join('');
  const recentRows = data.recent.length
    ? data.recent.map(s => `<tr>
        <td>${new Date(s.scanned_at * 1000).toLocaleString()}</td>
        <td>${deviceType(s.user_agent)}</td>
        <td class="ip-cell">${s.ip || '—'}</td>
      </tr>`).join('')
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
    </div>`;
  document.getElementById('stats-modal').classList.remove('hidden');
}

// =============================================================================
// Start
// =============================================================================

init();
