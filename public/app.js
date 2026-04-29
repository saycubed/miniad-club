const API = '';

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => { t.classList.add('hidden'); t.classList.remove('active'); });
    btn.classList.add('active');
    const tab = document.getElementById(`tab-${btn.dataset.tab}`);
    tab.classList.remove('hidden');
    tab.classList.add('active');
    if (btn.dataset.tab === 'manage') loadCodes();
  });
});

// --- Static QR ---
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

// --- Dynamic QR ---
document.getElementById('dyn-create').addEventListener('click', async () => {
  const destination = document.getElementById('dyn-url').value.trim();
  const label = document.getElementById('dyn-label').value.trim();
  const slug = document.getElementById('dyn-slug').value.trim();
  if (!destination) return alert('Please enter a destination URL.');

  const res = await fetch(`${API}/api/dynamic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

// --- Manage ---
async function loadCodes() {
  const res = await fetch(`${API}/api/dynamic`);
  const codes = await res.json();
  const container = document.getElementById('codes-list');

  if (!codes.length) {
    container.innerHTML = '<div class="empty">No dynamic QR codes yet.</div>';
    return;
  }

  container.innerHTML = codes.map(c => `
    <div class="code-item" data-slug="${c.slug}">
      <div>
        <div class="code-label">${c.label || 'Untitled'}</div>
        <div class="code-slug">/r/${c.slug}</div>
        <div class="code-dest">${c.destination}</div>
        <div class="code-scans">Scans: ${c.scan_count}</div>
      </div>
      <div class="code-actions">
        <button class="btn secondary small" onclick="viewCode('${c.slug}')">QR</button>
        <button class="btn secondary small" onclick="openEdit('${c.slug}', '${encodeURIComponent(c.destination)}', '${encodeURIComponent(c.label || '')}')">Edit</button>
        <button class="btn danger small" onclick="deleteCode('${c.slug}')">Delete</button>
      </div>
    </div>
  `).join('');
}

async function viewCode(slug) {
  const res = await fetch(`${API}/api/dynamic/${slug}`);
  const data = await res.json();
  const win = window.open('', '_blank', 'width=400,height=500');
  win.document.write(`
    <html><body style="background:#0f0f13;color:#e8e8f0;font-family:sans-serif;text-align:center;padding:2rem">
    <h2 style="color:#7c6af7">/r/${slug}</h2>
    <img src="${data.qrDataUrl}" style="background:#fff;padding:8px;border-radius:8px;max-width:280px" />
    <p style="margin-top:1rem;font-size:0.85rem;color:#8888a8">${data.destination}</p>
    <a href="${data.qrDataUrl}" download="qr-${slug}.png" style="display:inline-block;margin-top:1rem;padding:0.5rem 1rem;background:#7c6af7;color:#fff;border-radius:8px;text-decoration:none">Download</a>
    </body></html>
  `);
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destination, label })
  });

  if (res.ok) {
    document.getElementById('edit-modal').classList.add('hidden');
    loadCodes();
  } else {
    alert('Failed to update');
  }
});

async function deleteCode(slug) {
  if (!confirm(`Delete /r/${slug}?`)) return;
  await fetch(`${API}/api/dynamic/${slug}`, { method: 'DELETE' });
  loadCodes();
}

document.getElementById('refresh-list').addEventListener('click', loadCodes);
