const API = '';
let currentUser = null;

// --- Token helpers ---
const getToken = () => localStorage.getItem('qr_token');
const setToken = t => localStorage.setItem('qr_token', t);
const clearToken = () => localStorage.removeItem('qr_token');
const authHeaders = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` });

// =============================================================================
// Countries list (ISO 3166-1 alpha-2)
// =============================================================================

const COUNTRIES = [
  ['AF','Afghanistan'],['AL','Albania'],['DZ','Algeria'],['AR','Argentina'],
  ['AU','Australia'],['AT','Austria'],['BE','Belgium'],['BR','Brazil'],
  ['CA','Canada'],['CL','Chile'],['CN','China'],['CO','Colombia'],
  ['HR','Croatia'],['CZ','Czech Republic'],['DK','Denmark'],['EG','Egypt'],
  ['FI','Finland'],['FR','France'],['DE','Germany'],['GH','Ghana'],
  ['GR','Greece'],['HK','Hong Kong'],['HU','Hungary'],['IN','India'],
  ['ID','Indonesia'],['IE','Ireland'],['IL','Israel'],['IT','Italy'],
  ['JP','Japan'],['KE','Kenya'],['KR','South Korea'],['MY','Malaysia'],
  ['MX','Mexico'],['MA','Morocco'],['NL','Netherlands'],['NZ','New Zealand'],
  ['NG','Nigeria'],['NO','Norway'],['PK','Pakistan'],['PE','Peru'],
  ['PH','Philippines'],['PL','Poland'],['PT','Portugal'],['RO','Romania'],
  ['RU','Russia'],['SA','Saudi Arabia'],['SG','Singapore'],['ZA','South Africa'],
  ['ES','Spain'],['SE','Sweden'],['CH','Switzerland'],['TW','Taiwan'],
  ['TH','Thailand'],['TR','Turkey'],['UA','Ukraine'],['AE','UAE'],
  ['GB','United Kingdom'],['US','United States'],['VN','Vietnam'],
].sort((a, b) => a[1].localeCompare(b[1]));

const DEVICE_OPTIONS = [
  ['ios', 'iOS (iPhone / iPad)'],
  ['android', 'Android'],
  ['mobile', 'Any Mobile'],
  ['desktop', 'Desktop'],
];

// =============================================================================
// Routing rules state
// =============================================================================

// Each context ('dyn' | 'edit') has its own rules array
const rulesState = { dyn: [], edit: [] };

function buildMatchOptions(type) {
  if (type === 'device') {
    return DEVICE_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
  return COUNTRIES.map(([code, name]) => `<option value="${code}">${name} (${code})</option>`).join('');
}

function renderRules(context) {
  const container = document.getElementById(`${context}-rules`);
  const rules = rulesState[context];
  if (!rules.length) {
    container.innerHTML = '<p class="rules-empty">No rules — all scans redirect to the destination above.</p>';
    return;
  }
  container.innerHTML = rules.map((rule, i) => `
    <div class="rule-row" data-index="${i}">
      <select class="rule-type-select" onchange="onRuleTypeChange('${context}', ${i}, this.value)">
        <option value="device"${rule.rule_type === 'device' ? ' selected' : ''}>Device</option>
        <option value="country"${rule.rule_type === 'country' ? ' selected' : ''}>Country</option>
      </select>
      <select class="rule-match-select" onchange="onRuleMatchChange('${context}', ${i}, this.value)">
        ${buildMatchOptions(rule.rule_type)}
      </select>
      <span class="rule-arrow">→</span>
      <input class="rule-dest-input" type="text" placeholder="https://destination.com"
        value="${escHtml(rule.destination)}"
        oninput="onRuleDestChange('${context}', ${i}, this.value)" />
      <button class="btn ghost small rule-delete" onclick="removeRule('${context}', ${i})">×</button>
    </div>
  `).join('');

  // Set selected value for match dropdowns (after innerHTML is set)
  rules.forEach((rule, i) => {
    const row = container.querySelectorAll('.rule-row')[i];
    if (!row) return;
    const matchSel = row.querySelector('.rule-match-select');
    if (matchSel) matchSel.value = rule.match_value;
  });
}

function addRule(context) {
  rulesState[context].push({ rule_type: 'device', match_value: 'ios', destination: '' });
  renderRules(context);
}

function removeRule(context, index) {
  rulesState[context].splice(index, 1);
  renderRules(context);
}

function onRuleTypeChange(context, index, value) {
  rulesState[context][index].rule_type = value;
  rulesState[context][index].match_value = value === 'device' ? 'ios' : 'US';
  renderRules(context);
}

function onRuleMatchChange(context, index, value) {
  rulesState[context][index].match_value = value;
}

function onRuleDestChange(context, index, value) {
  rulesState[context][index].destination = value;
}

document.getElementById('dyn-add-rule').addEventListener('click', () => addRule('dyn'));
document.getElementById('edit-add-rule').addEventListener('click', () => addRule('edit'));

// =============================================================================
// Color picker sync
// =============================================================================

function bindColorPair(colorId, hexId) {
  const picker = document.getElementById(colorId);
  const hex = document.getElementById(hexId);
  picker.addEventListener('input', () => { hex.value = picker.value.toUpperCase(); });
  hex.addEventListener('input', () => {
    if (/^#[0-9A-Fa-f]{6}$/.test(hex.value)) picker.value = hex.value;
  });
}

['static','dyn','edit'].forEach(p => {
  bindColorPair(`${p}-color`, `${p}-color-hex`);
  bindColorPair(`${p}-bg-color`, `${p}-bg-color-hex`);
});

// =============================================================================
// Logo upload
// =============================================================================

function initLogoUploadButtons() {
  document.querySelectorAll('.upload-logo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp';
      fileInput.onchange = () => handleLogoFile(fileInput.files[0], btn);
      fileInput.click();
    });
  });

  document.querySelectorAll('[id$="-logo"]').forEach(input => {
    if (input.type !== 'text') return;
    const previewId = input.id + '-preview';
    input.addEventListener('change', () => showLogoPreview(input.value.trim(), previewId));
    input.addEventListener('paste', () => setTimeout(() => showLogoPreview(input.value.trim(), previewId), 50));
  });
}

async function handleLogoFile(file, btn) {
  if (!file) return;
  const urlTargetId = btn.dataset.urlTarget;
  const previewId = btn.dataset.preview;
  const orig = btn.textContent;
  btn.textContent = 'Uploading…'; btn.disabled = true;
  const formData = new FormData();
  formData.append('logo', file);
  try {
    const res = await fetch(`${API}/api/logo/upload`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` }, body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    document.getElementById(urlTargetId).value = data.url;
    showLogoPreview(data.url, previewId);
  } catch (err) {
    alert('Upload failed: ' + err.message);
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}

function showLogoPreview(url, previewId) {
  const preview = document.getElementById(previewId);
  if (!preview) return;
  if (!url) { preview.classList.add('hidden'); preview.innerHTML = ''; return; }
  preview.innerHTML = `
    <img src="${url}" alt="Logo preview" onerror="this.parentElement.classList.add('hidden')" />
    <button type="button" class="logo-clear-btn" onclick="clearLogo('${previewId}')">Remove</button>`;
  preview.classList.remove('hidden');
}

function clearLogo(previewId) {
  const preview = document.getElementById(previewId);
  const urlInput = document.getElementById(previewId.replace('-preview', ''));
  if (urlInput) urlInput.value = '';
  preview.innerHTML = ''; preview.classList.add('hidden');
}

// =============================================================================
// Init
// =============================================================================

async function init() {
  initLogoUploadButtons();
  const token = getToken();
  if (!token) return showAuth();
  try {
    const res = await fetch(`${API}/api/auth/me`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) { clearToken(); return showAuth(); }
    currentUser = await res.json();
    showApp();
  } catch { showAuth(); }
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
  el.textContent = msg; el.classList.remove('hidden');
}

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: document.getElementById('login-email').value.trim(), password: document.getElementById('login-password').value }),
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
    }),
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error);
  setToken(data.token); currentUser = data.user; showApp();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  clearToken(); currentUser = null; showAuth();
});

// =============================================================================
// Tabs
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
      }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    document.getElementById('static-qr-img').src = objectUrl;
    document.getElementById('static-download').href = objectUrl;
    document.getElementById('static-result').classList.remove('hidden');
  } catch (err) { alert('Error: ' + err.message); }
  finally { btn.textContent = 'Generate QR'; btn.disabled = false; }
});

// =============================================================================
// Dynamic QR (create)
// =============================================================================

document.getElementById('dyn-create').addEventListener('click', async () => {
  const destination = document.getElementById('dyn-url').value.trim();
  if (!destination) return alert('Please enter a destination URL.');

  const expiresRaw = document.getElementById('dyn-expires-at').value;
  const scanLimitRaw = document.getElementById('dyn-scan-limit').value;

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
        scan_limit: scanLimitRaw ? parseInt(scanLimitRaw) : null,
        expires_at: expiresRaw ? Math.floor(new Date(expiresRaw).getTime() / 1000) : null,
        rules: rulesState.dyn.filter(r => r.destination),
      }),
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

    // Reset rules
    rulesState.dyn = [];
    renderRules('dyn');
  } catch (err) { alert('Error: ' + err.message); }
  finally { btn.textContent = 'Create Dynamic QR'; btn.disabled = false; }
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
    days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
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

function codeStatus(c) {
  const now = Math.floor(Date.now() / 1000);
  if (c.expires_at && c.expires_at < now) return '<span class="badge badge-expired">Expired</span>';
  if (c.scan_limit && c.scan_count >= c.scan_limit) return '<span class="badge badge-expired">Limit reached</span>';
  return '<span class="badge badge-active">Active</span>';
}

function codeBadges(c) {
  const badges = [];
  if (c.scan_limit) badges.push(`<span class="badge badge-info">${c.scan_count}/${c.scan_limit} scans</span>`);
  if (c.expires_at) {
    const d = new Date(c.expires_at * 1000);
    badges.push(`<span class="badge badge-info">Exp ${d.toLocaleDateString()}</span>`);
  }
  if (c.rule_count > 0) badges.push(`<span class="badge badge-routing">${c.rule_count} route${c.rule_count !== 1 ? 's' : ''}</span>`);
  return badges.join('');
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
        <div class="code-label-row">
          <span class="code-label">${escHtml(c.label || 'Untitled')}</span>
          ${codeStatus(c)}
        </div>
        <div class="code-slug">/r/${c.slug}</div>
        <div class="code-dest">${escHtml(c.destination)}</div>
        <div class="code-meta">
          <span class="code-scans">${c.scan_count} scan${c.scan_count !== 1 ? 's' : ''}</span>
          <span class="code-swatch" style="background:${c.qr_color||'#000'}" title="QR color"></span>
          <span class="code-swatch" style="background:${c.qr_bg_color||'#fff'};border:1px solid var(--border)" title="BG color"></span>
          ${codeBadges(c)}
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
    <p style="margin-top:1rem;font-size:.85rem;color:#8888a8;word-break:break-all">${escHtml(data.destination)}</p>
    <p style="font-size:.8rem;color:#5af7a0;margin-top:.5rem">${data.scan_count} scans</p>
    <a href="${data.qrDataUrl}" download="qr-${slug}.png" style="display:inline-block;margin-top:1rem;padding:.5rem 1rem;background:#7c6af7;color:#fff;border-radius:8px;text-decoration:none">Download PNG</a>
  </body></html>`);
}

// =============================================================================
// Edit modal
// =============================================================================

async function openEdit(slug) {
  const res = await fetch(`${API}/api/dynamic/${slug}`, { headers: authHeaders() });
  const data = await res.json();

  document.getElementById('edit-slug').value = slug;
  document.getElementById('edit-dest').value = data.destination;
  document.getElementById('edit-label').value = data.label || '';
  document.getElementById('edit-logo').value = data.qr_logo || '';
  document.getElementById('edit-scan-limit').value = data.scan_limit || '';
  document.getElementById('edit-expires-at').value = data.expires_at
    ? new Date(data.expires_at * 1000).toISOString().slice(0, 16) : '';

  showLogoPreview(data.qr_logo || '', 'edit-logo-preview');
  setColorPair('edit-color', 'edit-color-hex', data.qr_color || '#000000');
  setColorPair('edit-bg-color', 'edit-bg-color-hex', data.qr_bg_color || '#FFFFFF');
  setSelect('edit-body-style', data.qr_body_style || 'square');
  setSelect('edit-eye-style', data.qr_eye_style || 'frame0');

  // Load routing rules
  rulesState.edit = (data.rules || []).map(r => ({
    rule_type: r.rule_type, match_value: r.match_value, destination: r.destination,
  }));
  renderRules('edit');

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
  const expiresRaw = document.getElementById('edit-expires-at').value;
  const scanLimitRaw = document.getElementById('edit-scan-limit').value;

  const [patchRes, rulesRes] = await Promise.all([
    fetch(`${API}/api/dynamic/${slug}`, {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({
        destination: document.getElementById('edit-dest').value.trim(),
        label: document.getElementById('edit-label').value.trim(),
        color: document.getElementById('edit-color').value,
        bgColor: document.getElementById('edit-bg-color').value,
        bodyStyle: document.getElementById('edit-body-style').value,
        eyeStyle: document.getElementById('edit-eye-style').value,
        logo: document.getElementById('edit-logo').value.trim(),
        scan_limit: scanLimitRaw ? parseInt(scanLimitRaw) : null,
        expires_at: expiresRaw ? Math.floor(new Date(expiresRaw).getTime() / 1000) : null,
      }),
    }),
    fetch(`${API}/api/dynamic/${slug}/rules`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify(rulesState.edit.filter(r => r.destination)),
    }),
  ]);

  if (patchRes.ok && rulesRes.ok) {
    document.getElementById('edit-modal').classList.add('hidden');
    loadManage();
  } else {
    alert('Failed to save changes');
  }
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
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
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

  document.getElementById('stats-content').innerHTML = `
    <div class="stats-summary">
      <div class="stat-box"><div class="stat-num">${data.total}</div><div class="stat-label">Total Scans</div></div>
      <div class="stat-box"><div class="stat-num">${data.daily.reduce((a,d)=>a+d.count,0)}</div><div class="stat-label">Last 30 Days</div></div>
      <div class="stat-box"><div class="stat-num">${data.recent[0] ? new Date(data.recent[0].scanned_at*1000).toLocaleDateString() : '—'}</div><div class="stat-label">Last Scan</div></div>
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
// Boot
// =============================================================================

init();
