const API = '';
const getToken = () => localStorage.getItem('qr_token');
const authHeaders = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` });

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString();
}

function fmtDateShort(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString();
}

function deviceType(ua) {
  if (!ua) return '—';
  if (/mobile|android|iphone/i.test(ua)) return 'Mobile';
  if (/ipad|tablet/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

// =============================================================================
// Boot — verify admin
// =============================================================================

async function init() {
  document.getElementById('auth-gate').classList.remove('hidden');

  const token = getToken();
  if (!token) return showGate('Sign in to the main app first.');

  const res = await fetch(`${API}/api/admin/me`, { headers: authHeaders() });
  if (res.status === 401) return showGate('You must be signed in.');
  if (res.status === 403) return showGate('Admin access required.');
  if (!res.ok) return showGate('Something went wrong.');

  const user = await res.json();
  document.getElementById('admin-email').textContent = user.name || user.email;
  document.getElementById('auth-gate').classList.add('hidden');
  document.getElementById('admin-app').classList.remove('hidden');

  loadOverview();
}

function showGate(msg) {
  document.getElementById('gate-message').textContent = msg;
}

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('qr_token');
  window.location.href = '/';
});

// =============================================================================
// Tabs
// =============================================================================

const tabLoaders = {
  overview: loadOverview,
  users:    loadUsers,
  codes:    loadCodes,
  scans:    loadScans,
  inbox:    loadInbox,
};

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => { t.classList.add('hidden'); t.classList.remove('active'); });
    btn.classList.add('active');
    const tab = document.getElementById(`tab-${btn.dataset.tab}`);
    tab.classList.remove('hidden'); tab.classList.add('active');
    tabLoaders[btn.dataset.tab]?.();
  });
});

// =============================================================================
// Overview
// =============================================================================

async function loadOverview() {
  const res = await fetch(`${API}/api/admin/overview`, { headers: authHeaders() });
  if (!res.ok) return;
  const { totalUsers, totalCodes, totalScans, unreadEmail, daily } = await res.json();

  // Update inbox badge
  const badge = document.getElementById('inbox-badge');
  badge.textContent = unreadEmail;
  badge.classList.toggle('hidden', unreadEmail === 0);

  document.getElementById('overview-cards').innerHTML = `
    <div class="overview-card">
      <div class="overview-num">${totalUsers.toLocaleString()}</div>
      <div class="overview-label">Users</div>
    </div>
    <div class="overview-card">
      <div class="overview-num">${totalCodes.toLocaleString()}</div>
      <div class="overview-label">QR Codes</div>
    </div>
    <div class="overview-card">
      <div class="overview-num">${totalScans.toLocaleString()}</div>
      <div class="overview-label">Total Scans</div>
    </div>
    <div class="overview-card${unreadEmail > 0 ? ' overview-card-alert' : ''}">
      <div class="overview-num">${unreadEmail.toLocaleString()}</div>
      <div class="overview-label">Unread Emails</div>
    </div>`;

  // Bar chart
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const dailyMap = Object.fromEntries(daily.map(d => [d.day, d.count]));
  const maxCount = daily.length ? Math.max(...daily.map(d => d.count)) : 1;

  document.getElementById('overview-chart').innerHTML = days.map(day => {
    const count = dailyMap[day] || 0;
    const pct = maxCount ? Math.round((count / maxCount) * 100) : 0;
    return `<div class="bar-col">
      <div class="bar-wrap"><div class="bar" style="height:${Math.max(pct,count?2:0)}%" title="${count} on ${day}"></div></div>
      <div class="bar-label">${day.slice(5)}</div>
    </div>`;
  }).join('');
}

// =============================================================================
// Users
// =============================================================================

async function loadUsers() {
  const res = await fetch(`${API}/api/admin/users`, { headers: authHeaders() });
  if (!res.ok) return;
  const users = await res.json();

  document.getElementById('users-tbody').innerHTML = users.length
    ? users.map(u => `
        <tr>
          <td>${escHtml(u.email)}</td>
          <td>${escHtml(u.name || '—')}</td>
          <td class="num-cell">${u.code_count}</td>
          <td class="num-cell">${u.total_scans.toLocaleString()}</td>
          <td class="muted-cell">${fmtDateShort(u.created_at)}</td>
          <td>
            <label class="toggle" title="${u.is_admin ? 'Revoke admin' : 'Grant admin'}">
              <input type="checkbox" ${u.is_admin ? 'checked' : ''} onchange="toggleAdmin('${u.id}', this.checked)" />
              <span class="toggle-track"></span>
            </label>
          </td>
        </tr>`).join('')
    : '<tr><td colspan="6" class="empty">No users yet.</td></tr>';
}

async function toggleAdmin(userId, grant) {
  await fetch(`${API}/api/admin/users/${userId}/admin`, {
    method: 'PATCH', headers: authHeaders(),
    body: JSON.stringify({ is_admin: grant }),
  });
}

document.getElementById('refresh-users').addEventListener('click', loadUsers);

// =============================================================================
// QR Codes
// =============================================================================

async function loadCodes() {
  const res = await fetch(`${API}/api/admin/codes`, { headers: authHeaders() });
  if (!res.ok) return;
  const codes = await res.json();

  document.getElementById('codes-tbody').innerHTML = codes.length
    ? codes.map(c => `
        <tr>
          <td><a href="/r/${escHtml(c.slug)}" target="_blank" class="accent-link">/r/${escHtml(c.slug)}</a></td>
          <td>${escHtml(c.label || '—')}</td>
          <td class="muted-cell">${escHtml(c.owner_email || '—')}</td>
          <td class="num-cell">${c.scan_count.toLocaleString()}${c.scan_limit ? ' / ' + c.scan_limit : ''}</td>
          <td class="num-cell">${c.scan_limit || '∞'}</td>
          <td class="muted-cell">${c.expires_at ? fmtDateShort(c.expires_at) : '—'}</td>
          <td class="muted-cell">${fmtDateShort(c.created_at)}</td>
        </tr>`).join('')
    : '<tr><td colspan="7" class="empty">No QR codes yet.</td></tr>';
}

document.getElementById('refresh-codes').addEventListener('click', loadCodes);

// =============================================================================
// Recent Scans
// =============================================================================

async function loadScans() {
  const res = await fetch(`${API}/api/admin/scans/recent`, { headers: authHeaders() });
  if (!res.ok) return;
  const scans = await res.json();

  document.getElementById('scans-tbody').innerHTML = scans.length
    ? scans.map(s => `
        <tr>
          <td class="muted-cell">${fmtDate(s.scanned_at)}</td>
          <td><a href="/r/${escHtml(s.slug)}" target="_blank" class="accent-link">/r/${escHtml(s.slug)}</a>${s.label ? ' <span class="muted-cell">'+escHtml(s.label)+'</span>' : ''}</td>
          <td class="muted-cell">${escHtml(s.owner_email || '—')}</td>
          <td>${deviceType(s.user_agent)}</td>
          <td class="mono-cell">${escHtml(s.ip || '—')}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="empty">No scans yet.</td></tr>';
}

document.getElementById('refresh-scans').addEventListener('click', loadScans);

// =============================================================================
// Inbox
// =============================================================================

async function loadInbox() {
  const res = await fetch(`${API}/api/admin/inbox`, { headers: authHeaders() });
  if (!res.ok) return;
  const { emails, unread } = await res.json();

  const badge = document.getElementById('inbox-badge');
  const unreadLabel = document.getElementById('inbox-unread-label');
  badge.textContent = unread;
  badge.classList.toggle('hidden', unread === 0);
  unreadLabel.textContent = `${unread} unread`;
  unreadLabel.classList.toggle('hidden', unread === 0);

  const container = document.getElementById('inbox-list');
  if (!emails.length) {
    container.innerHTML = '<div class="empty">No emails yet.</div>';
    return;
  }
  container.innerHTML = emails.map(e => `
    <div class="inbox-item${e.is_read ? '' : ' inbox-unread'}" data-id="${e.id}">
      <div class="inbox-item-info" onclick="openEmail(${e.id})">
        <div class="inbox-from">${escHtml(e.from_addr)}${e.to_addr ? ' → ' + escHtml(e.to_addr) : ''}</div>
        <div class="inbox-subject">${escHtml(e.subject || '(no subject)')}</div>
        <div class="inbox-date">${fmtDate(e.received_at)}</div>
      </div>
      <div class="inbox-actions">
        <button class="btn danger small" onclick="deleteEmail(${e.id})">Delete</button>
      </div>
    </div>`).join('');
}

async function openEmail(id) {
  const res = await fetch(`${API}/api/admin/inbox/${id}`, { headers: authHeaders() });
  const email = await res.json();
  if (!res.ok) return;

  document.getElementById('email-modal-subject').textContent = email.subject || '(no subject)';
  document.getElementById('email-modal-meta').innerHTML =
    `<span class="email-from">From: ${escHtml(email.from_addr)}</span>` +
    (email.to_addr ? `<span>To: ${escHtml(email.to_addr)}</span>` : '') +
    `<span class="email-date">${fmtDate(email.received_at)}</span>`;

  const bodyEl = document.getElementById('email-modal-body');
  if (email.body_html) {
    const iframe = document.createElement('iframe');
    iframe.className = 'email-iframe';
    iframe.sandbox = 'allow-same-origin';
    bodyEl.innerHTML = '';
    bodyEl.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(email.body_html);
    iframe.contentDocument.close();
    iframe.onload = () => {
      iframe.style.height = Math.min(iframe.contentDocument.body.scrollHeight + 32, 600) + 'px';
    };
  } else {
    bodyEl.innerHTML = `<pre class="email-text">${escHtml(email.body_text || '')}</pre>`;
  }

  document.getElementById('email-modal').classList.remove('hidden');

  const item = document.querySelector(`.inbox-item[data-id="${id}"]`);
  if (item) item.classList.remove('inbox-unread');
  loadInbox();
}

async function deleteEmail(id) {
  if (!confirm('Delete this email?')) return;
  await fetch(`${API}/api/admin/inbox/${id}`, { method: 'DELETE', headers: authHeaders() });
  loadInbox();
}

document.getElementById('email-modal-close').addEventListener('click', () => {
  document.getElementById('email-modal').classList.add('hidden');
});

document.getElementById('refresh-inbox').addEventListener('click', loadInbox);

// =============================================================================
// Start
// =============================================================================

init();
