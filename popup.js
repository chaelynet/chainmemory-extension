// ═══════════════════════════════════════════════════════════════════
// ChainMemory v3.3.0 — popup.js
// Complete onboarding (auto-generate + manual paste) + tabs
// v3.1.1: Project Brain has NO hardcoded default — user sets their own
//         (prevents leaking the internal 'chainmemory' namespace)
// v3.3.0: the vault is required to save. New users go through the 12 words
//         (generate + confirm three of them, or paste existing ones) and the
//         search model is downloaded with visible progress. Existing users
//         without a vault can still browse and inject, with a banner to set it up.
// ═══════════════════════════════════════════════════════════════════

const API_BASE = 'https://api.chainmemory.ai';
const FAUCET_URL = 'https://faucet.chainmemory.ai';

const state = {
  apiKey: null,
  wallet: null,
  projects: [],
  templates: [],
  filterProject: '',
  editingProject: null,
  projectBrainProject: ''
};

// ── API ──
async function api(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (state.apiKey) opts.headers['x-api-key'] = state.apiKey;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Config storage ──
function loadConfig() {
  return new Promise(resolve => {
    chrome.storage.sync.get(['apiKey', 'walletAddress', 'filterProject', 'projectBrainProject'], data => {
      if (data.apiKey) state.apiKey = data.apiKey;
      if (data.walletAddress) state.wallet = data.walletAddress;
      if (data.filterProject) state.filterProject = data.filterProject;
      state.projectBrainProject = data.projectBrainProject || '';
      resolve();
    });
  });
}

function saveConfigSync(updates) {
  return new Promise(resolve => chrome.storage.sync.set(updates, resolve));
}

// ── State machine ──
function showState(name) {
  ['noKey', 'pasteKey', 'keyCreated', 'vault', 'connected', 'viewKey'].forEach(s => {
    const el = document.getElementById('state-' + s);
    if (!el) return;
    el.classList.toggle('hide', s !== name);
  });
}

// ── Toast ──
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'cm-toast ' + type;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function msg(id, text, type = 'info') {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'cm-msg ' + type;
  el.textContent = text || '';
}
function clearMsg(id) {
  const el = document.getElementById(id);
  if (el) { el.className = 'cm-msg'; el.textContent = ''; }
}

// ── Network status ──
async function updateNetStatus() {
  try {
    const data = await fetch(API_BASE + '/v1/stats').then(r => r.json());
    document.getElementById('netStatus').textContent = `Block #${data.block}`;
  } catch (e) {
    document.getElementById('netStatus').textContent = 'Offline';
  }
}

// ── Routing ──
async function route() {
  if (!state.apiKey) { showState('noKey'); return; }
  // v3.3.0: la boveda es obligatoria para guardar. Quien acaba de crear o pegar
  // su clave pasa por las 12 palabras antes de entrar. Quien ya usaba la
  // extension sin boveda entra igual —puede ver e inyectar lo que tiene—, pero
  // ve el aviso y no puede guardar memorias nuevas hasta activarla.
  const local = await localGet(['seedPhrase', 'vaultPending']);
  if (!local.seedPhrase && local.vaultPending) { abrirPasoBoveda(); return; }
  await loadConnected();
  showState('connected');
  document.getElementById('vaultBanner').classList.toggle('hide', !!local.seedPhrase);
}

function localGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function localSet(obj) { return new Promise(r => chrome.storage.local.set(obj, r)); }
function localRemove(keys) { return new Promise(r => chrome.storage.local.remove(keys, r)); }

// ── Generate API Key automatically ──
async function generateNewKey() {
  const btn = document.getElementById('generateKey');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating...';
  msg('generateMsg', 'Creating wallet on ChainMemory blockchain...', 'info');

  try {
    const data = await fetch(API_BASE + '/v1/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).then(r => r.json());

    if (!data.api_key || !data.wallet) throw new Error('Invalid response');

    await saveConfigSync({
      apiKey: data.api_key,
      walletAddress: data.wallet
    });
    await localSet({ vaultPending: true });   // v3.3.0: sigue el paso de las 12 palabras
    state.apiKey = data.api_key;
    state.wallet = data.wallet;

    document.getElementById('newKeyDisplay').textContent = data.api_key;
    document.getElementById('newWalletDisplay').textContent = data.wallet;
    document.getElementById('confirmSaved').checked = false;
    document.getElementById('continueAfterCreate').disabled = true;

    clearMsg('generateMsg');
    showState('keyCreated');
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = originalText;
    msg('generateMsg', 'Error: ' + e.message, 'error');
  }
}

// ── Continue after create → faucet con wallet ──
async function continueAfterCreate() {
  if (state.wallet) {
    chrome.tabs.create({ url: `${FAUCET_URL}/?wallet=${state.wallet}` });
  } else {
    chrome.tabs.create({ url: FAUCET_URL });
  }
  await route();
}

// ── Save existing key (paste flow) ──
async function saveExistingKey() {
  const key = document.getElementById('apiKey').value.trim();
  if (!/^aic[mp]?_/.test(key)) {
    msg('setupMsg', 'Invalid key. Must start with "aic_", "aicm_" or "aicp_"', 'error');
    return;
  }
  msg('setupMsg', 'Verifying...', 'info');

  try {
    const res = await fetch(API_BASE + '/v1/profile', { headers: { 'x-api-key': key } });
    if (res.status === 401) { msg('setupMsg', 'Invalid API key', 'error'); return; }
    const data = await res.json();
    await saveConfigSync({
      apiKey: key,
      walletAddress: data.owner || null
    });
    // v3.3.0: sigue el paso de las 12 palabras, salvo que este navegador ya las tenga.
    const yaTiene = (await localGet(['seedPhrase'])).seedPhrase;
    if (!yaTiene) await localSet({ vaultPending: true });
    state.apiKey = key;
    state.wallet = data.owner || null;
    msg('setupMsg', '✅ Connected!', 'success');
    setTimeout(route, 1000);
  } catch (e) {
    msg('setupMsg', 'Error: ' + e.message, 'error');
  }
}

// ── Connected view ──
async function loadConnected() {
  // Wallet short
  if (state.wallet) {
    const short = state.wallet.substring(0, 6) + '...' + state.wallet.substring(38);
    document.getElementById('walletShort').textContent = short;
  } else {
    document.getElementById('walletShort').textContent = 'Connected';
  }
  // Balance
  try {
    const bal = await api('GET', '/v1/inject/balance');
    document.getElementById('balanceAmount').textContent =
      parseFloat(bal.balance_aic).toFixed(4) + ' AIC';
    document.getElementById('quickBalance').textContent =
      parseFloat(bal.balance_aic).toFixed(2);
  } catch (e) {
    document.getElementById('balanceAmount').textContent = '-- AIC';
  }
  // Load projects (for filter dropdown)
  await loadProjectsFilter();
  // Load memories list (for re-tag)
  await loadMemoriesView();
}

// ═══════════════════════════════════════════════════════════════════
// RE-TAG MEMORIES VIEW (NEW in v3.0.2)
// ═══════════════════════════════════════════════════════════════════

state.allMemories = [];
state.selectedMemIds = new Set();

async function loadMemoriesView() {
  const list = document.getElementById('memories-list');
  if (!list) return;
  list.innerHTML = '<div class="cm-loading">Loading memories…</div>';

  const params = new URLSearchParams();
  params.set('include_plaintext', '1');
  params.set('limit', '100');
  if (state.filterProject) params.set('project', state.filterProject);

  try {
    const data = await api('GET', '/v1/memories/list?' + params);
    state.allMemories = data.memories || [];
    document.getElementById('savedCount').textContent = data.total || state.allMemories.length;

    if (state.allMemories.length === 0) {
      list.innerHTML = '<div class="cm-empty">No memories yet. Save AI responses with the page button to start.</div>';
      hideBulkBar();
      return;
    }

    // Populate bulk dropdown with available projects
    populateBulkDropdown();

    list.innerHTML = '';
    for (const mem of state.allMemories) {
      list.appendChild(renderMemCard(mem));
    }
  } catch (e) {
    list.innerHTML = `<div class="cm-empty">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

function populateBulkDropdown() {
  const bulk = document.getElementById('bulk-add-tag');
  if (!bulk) return;
  bulk.innerHTML = '<option value="">Add tag to selected…</option>';
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.project_id;
    opt.textContent = p.name;
    bulk.appendChild(opt);
  }
}

function renderMemCard(mem) {
  const div = document.createElement('div');
  div.className = 'cm-mem-card';
  if (state.selectedMemIds.has(mem.memory_number)) div.classList.add('selected');
  div.dataset.id = mem.memory_number;

  const text = mem.summary || mem.summary_preview || '(empty)';
  const dt = new Date(mem.timestamp * 1000);
  const dateStr = dt.toLocaleDateString();
  const tags = mem.tags || [];

  const tagsHTML = tags.map(t =>
    `<span class="cm-mem-tag">${escapeHtml(t)}<button class="cm-tag-remove" data-tag="${escapeHtml(t)}" title="Remove tag">×</button></span>`
  ).join('');

  div.innerHTML = `
    <div class="cm-mem-card-head">
      <input type="checkbox" class="cm-mem-check" ${state.selectedMemIds.has(mem.memory_number) ? 'checked' : ''}>
      <span class="cm-mem-id">#${mem.memory_number}</span>
      <span class="cm-mem-cat-pill">${escapeHtml(mem.category || 'CUSTOM')}</span>
      <span class="cm-mem-date">${dateStr}</span>
      <button class="cm-mem-archive-btn" title="${mem.archived ? 'Unarchive' : 'Archive'}">${mem.archived ? '↩' : '📦'}</button>
    </div>
    <div class="cm-mem-preview">${escapeHtml(text.substring(0, 120))}${text.length > 120 ? '…' : ''}</div>
    <div class="cm-mem-tags-row">
      ${tagsHTML}
      <select class="cm-mem-add-tag-select" data-id="${mem.memory_number}">
        <option value="">+ tag</option>
        ${state.projects.filter(p => !tags.includes(p.project_id)).map(p => `<option value="${escapeHtml(p.project_id)}">${escapeHtml(p.name)}</option>`).join('')}
      </select>
    </div>
  `;

  // Checkbox click
  const cb = div.querySelector('.cm-mem-check');
  cb.addEventListener('click', e => {
    e.stopPropagation();
    toggleSelectMem(mem.memory_number);
  });
  // Click row
  div.addEventListener('click', e => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    toggleSelectMem(mem.memory_number);
  });
  // Remove tag
  div.querySelectorAll('.cm-tag-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeTagFromMemory(mem.memory_number, btn.dataset.tag);
    });
  });
  // Add tag dropdown
  const sel = div.querySelector('.cm-mem-add-tag-select');
  sel.addEventListener('change', async e => {
    const newTag = e.target.value;
    if (!newTag) return;
    await addTagToMemory(mem.memory_number, newTag);
    e.target.value = '';
  });
  // Archive / unarchive
  const arch = div.querySelector('.cm-mem-archive-btn');
  if (arch) arch.addEventListener('click', async e => {
    e.stopPropagation();
    await toggleArchiveMem(mem.memory_number, !!mem.archived);
  });

  return div;
}

async function toggleArchiveMem(id, currentlyArchived) {
  try {
    const ep = currentlyArchived ? `/v1/memories/${id}/unarchive` : `/v1/memories/${id}/archive`;
    await api('POST', ep);
    state.selectedMemIds.delete(id);
    toast(currentlyArchived ? 'Unarchived' : 'Archived', 'success');
    await loadMemoriesView();
  } catch (e) {
    toast('Archive failed: ' + e.message, 'error');
  }
}

function toggleSelectMem(id) {
  if (state.selectedMemIds.has(id)) state.selectedMemIds.delete(id);
  else state.selectedMemIds.add(id);
  const card = document.querySelector(`.cm-mem-card[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('selected', state.selectedMemIds.has(id));
    const cb = card.querySelector('.cm-mem-check');
    if (cb) cb.checked = state.selectedMemIds.has(id);
  }
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('memories-bulk-bar');
  const count = document.getElementById('bulk-count');
  if (!bar || !count) return;
  if (state.selectedMemIds.size === 0) {
    hideBulkBar();
    return;
  }
  bar.style.display = 'flex';
  count.textContent = state.selectedMemIds.size;
}

function hideBulkBar() {
  const bar = document.getElementById('memories-bulk-bar');
  if (bar) bar.style.display = 'none';
}

async function addTagToMemory(memId, newTag) {
  try {
    const mem = state.allMemories.find(m => m.memory_number === memId);
    if (!mem) return;
    const currentTags = mem.tags || [];
    if (currentTags.includes(newTag)) {
      toast('Tag already present', 'info');
      return;
    }
    const newTags = [...currentTags, newTag];
    await api('PUT', `/v1/memories/${memId}/tags`, { tags: newTags });
    mem.tags = newTags;
    toast('Tag added', 'success');
    loadMemoriesView();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function removeTagFromMemory(memId, tag) {
  try {
    const mem = state.allMemories.find(m => m.memory_number === memId);
    if (!mem) return;
    const newTags = (mem.tags || []).filter(t => t !== tag);
    await api('PUT', `/v1/memories/${memId}/tags`, { tags: newTags });
    mem.tags = newTags;
    toast('Tag removed', 'success');
    loadMemoriesView();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function applyBulkTag() {
  const bulk = document.getElementById('bulk-add-tag');
  const tag = bulk.value;
  if (!tag) return toast('Pick a tag from the dropdown', 'warn');
  if (state.selectedMemIds.size === 0) return;

  const ids = Array.from(state.selectedMemIds);
  let success = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      const mem = state.allMemories.find(m => m.memory_number === id);
      if (!mem) continue;
      const currentTags = mem.tags || [];
      if (currentTags.includes(tag)) { success++; continue; }
      const newTags = [...currentTags, tag];
      await api('PUT', `/v1/memories/${id}/tags`, { tags: newTags });
      mem.tags = newTags;
      success++;
    } catch (e) {
      failed++;
    }
  }

  toast(`Tagged ${success}${failed > 0 ? ` (${failed} failed)` : ''}`, success > 0 ? 'success' : 'error');
  state.selectedMemIds.clear();
  bulk.value = '';
  loadMemoriesView();
}

async function loadProjectsFilter() {
  try {
    const data = await api('GET', '/v1/projects');
    state.projects = data.projects || [];
    const sel = document.getElementById('filter-project');
    sel.innerHTML = '<option value="">All projects</option><option value="general">General (untagged)</option>';
    for (const p of state.projects) {
      const opt = document.createElement('option');
      opt.value = p.project_id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    sel.value = state.filterProject || '';
  } catch (e) {
    console.error('Load projects failed:', e);
  }
}

// ── Tabs ──
function initTabs() {
  document.querySelectorAll('.cm-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.cm-tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.cm-view').forEach(v => v.classList.remove('active'));
      t.classList.add('active');
      const view = document.getElementById('view-' + t.dataset.view);
      if (view) view.classList.add('active');
      if (t.dataset.view === 'settings') loadSettings();
      if (t.dataset.view === 'history') loadHistory();
    });
  });
}

// ── PIN de datos sensibles (v3.3.2) ──
// Hash PBKDF2-SHA256 con sal, en storage.local (no se sincroniza) y nunca se envia. Lo
// verifica content.js antes de mandar datos sensibles. Cambiarlo o quitarlo pide el PIN
// actual, con el mismo bloqueo de 5 intentos: si no, quitarlo seria la forma de saltearlo.
const PIN_ITER = 200000, PIN_INTENTOS = 5, PIN_BLOQUEO_MS = 5 * 60 * 1000;
async function hashPin(pin, saltB64, iter) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
async function pinActualValido() {
  const { fullPin, fullPinFails } = await localGet(['fullPin', 'fullPinFails']);
  if (!fullPin) return true;
  const f = fullPinFails || { n: 0, hasta: 0 };
  if (f.hasta && Date.now() < f.hasta) { toast('Too many wrong PINs. Try again after ' + new Date(f.hasta).toLocaleTimeString(), 'error'); return false; }
  const input = document.getElementById('pin-current');
  const pin = input.value; input.value = '';
  if (pin && await hashPin(pin, fullPin.salt, fullPin.iter) === fullPin.hash) { await localSet({ fullPinFails: { n: 0, hasta: 0 } }); return true; }
  const n = (f.hasta && Date.now() >= f.hasta ? 0 : f.n) + 1;
  if (n >= PIN_INTENTOS) { await localSet({ fullPinFails: { n: 0, hasta: Date.now() + PIN_BLOQUEO_MS } }); toast('Too many wrong PINs: locked for 5 minutes', 'error'); return false; }
  await localSet({ fullPinFails: { n, hasta: 0 } });
  toast('Wrong current PIN. ' + (PIN_INTENTOS - n) + ' attempts left', 'error');
  return false;
}
async function refrescarEstadoPin() {
  const { fullPin } = await localGet(['fullPin']);
  const actual = document.getElementById('pin-current');
  const quitar = document.getElementById('pin-remove');
  const guardar = document.getElementById('pin-save');
  if (actual) actual.hidden = !fullPin;
  if (quitar) quitar.disabled = !fullPin;
  if (guardar) guardar.textContent = fullPin ? 'Change PIN' : 'Save PIN';
}
async function guardarPin() {
  const input = document.getElementById('pin-new');
  const pin = input.value;
  if (pin.length < 4 || pin.length > 32) { toast('The PIN must have 4 to 32 characters', 'error'); return; }
  if (!await pinActualValido()) return;
  input.value = '';
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = btoa(String.fromCharCode(...salt));
  await localSet({ fullPin: { salt: saltB64, hash: await hashPin(pin, saltB64, PIN_ITER), iter: PIN_ITER }, fullPinFails: { n: 0, hasta: 0 } });
  toast('PIN saved on this device', 'success');
  refrescarEstadoPin();
}
async function quitarPin() {
  if (!await pinActualValido()) return;
  await localRemove(['fullPin', 'fullPinFails']);
  toast('PIN removed', 'success');
  refrescarEstadoPin();
}

// ── Settings ──
async function loadSettings() {
  const pbInput = document.getElementById('pb-project');
  if (pbInput) pbInput.value = state.projectBrainProject || '';
  refrescarEstadoPin();
  document.getElementById('conn-wallet').textContent = state.wallet || '--';
  document.getElementById('conn-apikey').textContent =
    state.apiKey ? state.apiKey.substring(0, 12) + '...' + state.apiKey.substring(state.apiKey.length - 4) : '--';

  // Cargar mis proyectos
  try {
    const data = await api('GET', '/v1/projects');
    state.projects = data.projects || [];
    renderProjectList();
  } catch (e) {
    document.getElementById('project-list').innerHTML = '<div class="cm-empty">Failed</div>';
  }

  // Templates
  try {
    const data = await fetch(API_BASE + '/v1/projects/defaults').then(r => r.json());
    state.templates = data.defaults || [];
    renderTemplateList();
  } catch (e) {
    document.getElementById('template-list').innerHTML = '<div class="cm-empty">Failed</div>';
  }
}

function renderProjectList() {
  const list = document.getElementById('project-list');
  if (state.projects.length === 0) {
    list.innerHTML = '<div class="cm-empty">No custom projects yet</div>';
    return;
  }
  list.innerHTML = '';
  for (const p of state.projects) {
    const row = document.createElement('div');
    row.className = 'cm-project-row';
    row.innerHTML = `
      <div class="cm-project-row-head">
        <span class="cm-project-dot" style="background:${escapeHtml(p.color)}"></span>
        <span class="cm-project-name">${escapeHtml(p.name)}</span>
        <div class="cm-project-actions">
          <button class="cm-edit-proj" data-id="${p.id}">Edit</button>
          <button class="cm-del-proj" data-id="${p.id}">Del</button>
        </div>
      </div>
      <div class="cm-project-keywords">${(p.keywords || []).map(escapeHtml).join(', ') || '<em>no keywords</em>'}</div>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll('.cm-edit-proj').forEach(b =>
    b.addEventListener('click', () => openEditProjectModal(parseInt(b.dataset.id)))
  );
  list.querySelectorAll('.cm-del-proj').forEach(b =>
    b.addEventListener('click', () => deleteProject(parseInt(b.dataset.id)))
  );
}

function renderTemplateList() {
  const list = document.getElementById('template-list');
  const userIds = new Set(state.projects.map(p => p.project_id));
  const available = state.templates.filter(t => !userIds.has(t.project_id));
  if (available.length === 0) {
    list.innerHTML = '<div class="cm-empty">All templates added</div>';
    return;
  }
  list.innerHTML = '';
  for (const t of available) {
    const row = document.createElement('div');
    row.className = 'cm-template-row';
    row.innerHTML = `
      <div class="cm-project-row-head">
        <span class="cm-project-dot" style="background:${escapeHtml(t.color || '#888')}"></span>
        <span class="cm-project-name">${escapeHtml(t.name)}</span>
        <div class="cm-project-actions">
          <button class="cm-add-tpl" data-tid="${escapeHtml(t.project_id)}">+ Add</button>
        </div>
      </div>
      <div class="cm-project-keywords">${(t.keywords || []).map(escapeHtml).join(', ')}</div>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll('.cm-add-tpl').forEach(b =>
    b.addEventListener('click', () => addFromTemplate(b.dataset.tid))
  );
}

async function addFromTemplate(tid) {
  try {
    await api('POST', '/v1/projects/from-default/' + encodeURIComponent(tid));
    toast('Added', 'success');
    loadSettings();
    loadProjectsFilter();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

async function deleteProject(id) {
  if (!confirm('Delete project?')) return;
  try {
    await api('DELETE', '/v1/projects/' + id);
    toast('Deleted', 'success');
    loadSettings();
    loadProjectsFilter();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

function openNewProjectModal() {
  state.editingProject = null;
  document.getElementById('modal-project-title').textContent = 'New project';
  document.getElementById('proj-id').value = '';
  document.getElementById('proj-id').disabled = false;
  document.getElementById('proj-name').value = '';
  document.getElementById('proj-keywords').value = '';
  document.getElementById('proj-color').value = '#d4af37';
  document.getElementById('modal-project').style.display = 'flex';
}

function openEditProjectModal(id) {
  const p = state.projects.find(x => x.id === id);
  if (!p) return;
  state.editingProject = id;
  document.getElementById('modal-project-title').textContent = 'Edit project';
  document.getElementById('proj-id').value = p.project_id;
  document.getElementById('proj-id').disabled = true;
  document.getElementById('proj-name').value = p.name;
  document.getElementById('proj-keywords').value = (p.keywords || []).join(', ');
  document.getElementById('proj-color').value = p.color || '#d4af37';
  document.getElementById('modal-project').style.display = 'flex';
}

function closeProjectModal() {
  document.getElementById('modal-project').style.display = 'none';
}

async function saveProject() {
  const project_id = document.getElementById('proj-id').value.trim().toLowerCase();
  const name = document.getElementById('proj-name').value.trim();
  const keywordsStr = document.getElementById('proj-keywords').value.trim();
  const color = document.getElementById('proj-color').value;
  if (!name) return toast('Name required', 'error');
  const keywords = keywordsStr.split(',').map(s => s.trim()).filter(Boolean);
  try {
    if (state.editingProject) {
      await api('PUT', '/v1/projects/' + state.editingProject, { name, keywords, color });
      toast('Updated', 'success');
    } else {
      if (!project_id || !/^[a-z0-9_-]+$/.test(project_id)) {
        return toast('Invalid project_id', 'error');
      }
      await api('POST', '/v1/projects', { project_id, name, keywords, color });
      toast('Created', 'success');
    }
    closeProjectModal();
    loadSettings();
    loadProjectsFilter();
  } catch (e) { toast('Failed: ' + e.message, 'error'); }
}

// ── History ──
async function loadHistory() {
  try {
    const data = await api('GET', '/v1/inject/history?limit=20');
    const t = data.totals || {};
    document.getElementById('stat-injects').textContent = t.total_injects || 0;
    document.getElementById('stat-memories').textContent = t.total_memories_injected || 0;
    document.getElementById('stat-spent').textContent = parseFloat(t.total_aic_spent || 0).toFixed(4);
    const list = document.getElementById('history-list');
    if (!data.history || data.history.length === 0) {
      list.innerHTML = '<div class="cm-empty">No injects yet</div>';
      return;
    }
    list.innerHTML = '';
    for (const h of data.history) {
      const dt = new Date(h.timestamp * 1000);
      const row = document.createElement('div');
      row.className = 'cm-history-row';
      row.innerHTML = `
        <div class="cm-history-head">
          <span class="cm-history-date">${dt.toLocaleString()}</span>
          <span class="cm-history-cost">${h.aic_charged} AIC</span>
        </div>
        <div class="cm-history-meta">
          ${h.memory_count} memories · ${h.token_count} tokens · ${escapeHtml(h.target_platform || 'unknown')}
        </div>
      `;
      list.appendChild(row);
    }
  } catch (e) { toast('Failed to load history: ' + e.message, 'error'); }
}

// ── Disconnect ──
async function disconnect() {
  if (!confirm('Disconnect from ChainMemory?\n\nYour API key will be removed from this browser. Make sure you have backed it up.\n\nYour memories stay on the blockchain forever.')) return;
  await saveConfigSync({ apiKey: null, walletAddress: null });
  state.apiKey = null;
  state.wallet = null;
  await route();
}

// ── Blind vault: 12-word phrase (stored ONLY on this device) ──
async function refreshSeedStatus() {
  const el = document.getElementById('seedMsg');
  if (!el) return;
  const data = await new Promise(r => chrome.storage.local.get(['seedPhrase'], r));
  if (data.seedPhrase) {
    el.textContent = '🔒 Vault active — your memories are stored encrypted.';
    el.className = 'cm-msg success';
  } else {
    el.textContent = 'Vault inactive — you cannot save new memories until you activate it.';
    el.className = 'cm-msg info';
  }
}
async function generateSeedPhrase() {
  const ta = document.getElementById('seedPhrase');
  const el = document.getElementById('seedMsg');
  if (typeof CMBip39 === 'undefined') {
    el.textContent = 'Cannot generate: the crypto module did not load.';
    el.className = 'cm-msg error';
    return;
  }
  const phrase = await CMBip39.generateMnemonic();
  ta.value = phrase;
  el.textContent = '⚠ Write these 12 words on paper BEFORE activating. Nobody can recover them for you.';
  el.className = 'cm-msg error';
}
async function saveSeedPhrase() {
  const ta = document.getElementById('seedPhrase');
  const el = document.getElementById('seedMsg');
  const phrase = (ta.value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!phrase) { el.textContent = 'Enter your 12 words.'; el.className = 'cm-msg error'; return; }
  const valid = (typeof CMBip39 !== 'undefined')
    ? await CMBip39.validateMnemonic(phrase)
    : (phrase.split(' ').length === 12);
  if (!valid) { el.textContent = 'Invalid phrase (12 BIP-39 words, in order).'; el.className = 'cm-msg error'; return; }
  await new Promise(r => chrome.storage.local.set({ seedPhrase: phrase }, r));
  await localRemove(['vaultPending']);
  ta.value = '';
  el.textContent = '🔒 Vault activated.';
  el.className = 'cm-msg success';
  const banner = document.getElementById('vaultBanner');
  if (banner) banner.classList.add('hide');
  chrome.runtime.sendMessage({ action: 'cm-prepare' }).catch(() => {});   // deja el modelo listo
}
async function clearSeedPhrase() {
  if (!confirm('Remove the phrase from this device.\n\nWithout it you cannot save new memories, and the ones you already encrypted can only be read with these same 12 words. Make sure you have them written down.')) return;
  await new Promise(r => chrome.storage.local.remove(['seedPhrase'], r));
  const el = document.getElementById('seedMsg');
  el.textContent = 'Vault disabled. You cannot save new memories until you activate it again.';
  el.className = 'cm-msg info';
  const banner = document.getElementById('vaultBanner');
  if (banner) banner.classList.remove('hide');
}

// ── Paso de la boveda (v3.3.0) ──
// La frase generada vive solo en esta variable mientras dura el paso: no se
// guarda en ningun lado hasta que el usuario demuestra que la anoto.
let fraseEnCurso = null;
let preguntas = [];

function vaultVista(nombre) {
  ['vault-choose', 'vault-show', 'vault-check', 'vault-paste', 'vault-prepare'].forEach(id => {
    document.getElementById(id).classList.toggle('hide', id !== nombre);
  });
  clearMsg('vaultMsg');
}

function abrirPasoBoveda() {
  fraseEnCurso = null;
  preguntas = [];
  document.getElementById('vaultWritten').checked = false;
  document.getElementById('vaultToCheck').disabled = true;
  ['vaultAnsA', 'vaultAnsB', 'vaultAnsC', 'vaultPasted'].forEach(id => { document.getElementById(id).value = ''; });
  vaultVista('vault-choose');
  showState('vault');
}

async function vaultGenerar() {
  if (typeof CMBip39 === 'undefined') { msg('vaultMsg', 'Cannot generate: the crypto module did not load.', 'error'); return; }
  fraseEnCurso = await CMBip39.generateMnemonic();
  const ol = document.getElementById('vaultWords');
  ol.innerHTML = '';
  fraseEnCurso.split(' ').forEach(w => { const li = document.createElement('li'); li.textContent = w; ol.appendChild(li); });
  vaultVista('vault-show');
}

// Tres posiciones al azar, distintas, con el generador criptografico.
function tresPosiciones() {
  const elegidas = new Set();
  const buf = new Uint32Array(1);
  while (elegidas.size < 3) { crypto.getRandomValues(buf); elegidas.add(buf[0] % 12); }
  return Array.from(elegidas).sort((a, b) => a - b);
}

function vaultIrAControl() {
  preguntas = tresPosiciones();
  ['A', 'B', 'C'].forEach((k, i) => {
    document.getElementById('vaultAsk' + k).textContent = 'Word #' + (preguntas[i] + 1);
    document.getElementById('vaultAns' + k).value = '';
  });
  vaultVista('vault-check');
  document.getElementById('vaultAnsA').focus();
}

async function vaultConfirmar() {
  const palabras = fraseEnCurso.split(' ');
  const ok = ['A', 'B', 'C'].every((k, i) =>
    document.getElementById('vaultAns' + k).value.trim().toLowerCase() === palabras[preguntas[i]]);
  if (!ok) { msg('vaultMsg', "One or more words don't match. Check your paper and try again.", 'error'); return; }
  await vaultActivar(fraseEnCurso);
}

async function vaultActivarPegada() {
  const frase = (document.getElementById('vaultPasted').value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const valida = typeof CMBip39 !== 'undefined' && await CMBip39.validateMnemonic(frase);
  if (!valida) { msg('vaultMsg', 'Those are not 12 valid words. Check the spelling and the order.', 'error'); return; }
  await vaultActivar(frase);
}

// Guarda la frase en este dispositivo y deja listo el modelo de busqueda. Si el
// modelo no se puede bajar ahora, la boveda queda activa igual: las memorias se
// guardan cifradas, solo que sin vector hasta que el modelo este disponible.
async function vaultActivar(frase) {
  await localSet({ seedPhrase: frase });
  await localRemove(['vaultPending']);
  fraseEnCurso = null;
  document.getElementById('vaultWords').innerHTML = '';
  vaultVista('vault-prepare');

  const barra = document.getElementById('vaultProgress');
  const texto = document.getElementById('vaultProgressText');
  const alProgreso = (m) => {
    if (m && m.type === 'cm-embed-progress') { barra.style.width = m.progress + '%'; texto.textContent = m.progress + '%'; }
  };
  chrome.runtime.onMessage.addListener(alProgreso);
  let r;
  try { r = await chrome.runtime.sendMessage({ action: 'cm-prepare' }); }
  catch (e) { r = { ok: false, error: e.message }; }
  chrome.runtime.onMessage.removeListener(alProgreso);

  if (r && r.ok) {
    barra.style.width = '100%';
    texto.textContent = 'Ready. Your memories are encrypted and searchable.';
  } else {
    texto.textContent = 'Search could not be prepared right now. Your memories will still be saved encrypted. It will retry the next time you save; memories saved before it works will not appear in search.';
  }
  document.getElementById('vaultDone').classList.remove('hide');
}

// ── Show current key ──
async function showCurrentKey() {
  document.getElementById('currentKeyDisplay').textContent = state.apiKey || '--';
  document.getElementById('currentWalletDisplay').textContent = state.wallet || '--';
  showState('viewKey');
}

// ── Faucet ──
function openFaucet() {
  if (state.wallet) {
    chrome.tabs.create({ url: `${FAUCET_URL}/?wallet=${state.wallet}` });
  } else {
    chrome.tabs.create({ url: FAUCET_URL });
  }
}

// ── Copy buttons ──
function initCopyButtons() {
  document.body.addEventListener('click', async e => {
    const btn = e.target.closest('.cm-copy-btn');
    if (!btn) return;
    const targetId = btn.dataset.copy;
    const target = document.getElementById(targetId);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent);
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
    } catch (err) {}
  });
}

// ── Utility ──
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => { try { const _v = 'v' + chrome.runtime.getManifest().version; const _a = document.getElementById('cmVersion'); const _b = document.getElementById('cmVersionFooter'); if (_a) _a.textContent = _v; if (_b) _b.textContent = _v; } catch (e) {}
  await loadConfig();
  updateNetStatus();
  setInterval(updateNetStatus, 30000);
  await route();
  initTabs();
  initCopyButtons();

  // noKey state
  document.getElementById('generateKey').addEventListener('click', generateNewKey);
  document.getElementById('haveKey').addEventListener('click', () => {
    clearMsg('generateMsg');
    clearMsg('setupMsg');
    showState('pasteKey');
  });

  // pasteKey state
  document.getElementById('saveKey').addEventListener('click', saveExistingKey);
  document.getElementById('backToNoKey').addEventListener('click', () => {
    clearMsg('setupMsg');
    showState('noKey');
  });
  document.getElementById('linkGenerate').addEventListener('click', e => {
    e.preventDefault();
    showState('noKey');
    generateNewKey();
  });

  // keyCreated state
  document.getElementById('confirmSaved').addEventListener('change', e => {
    document.getElementById('continueAfterCreate').disabled = !e.target.checked;
  });
  document.getElementById('continueAfterCreate').addEventListener('click', continueAfterCreate);

  // connected state
  document.getElementById('viewKey').addEventListener('click', showCurrentKey);
  document.getElementById('claimAic').addEventListener('click', openFaucet);
  document.getElementById('disconnect').addEventListener('click', disconnect);

  // Boveda ciega
  const _genSeedBtn = document.getElementById('genSeed');
  if (_genSeedBtn) _genSeedBtn.addEventListener('click', generateSeedPhrase);
  const _saveSeedBtn = document.getElementById('saveSeed');
  if (_saveSeedBtn) _saveSeedBtn.addEventListener('click', saveSeedPhrase);
  const _clearSeedBtn = document.getElementById('clearSeed');
  if (_clearSeedBtn) _clearSeedBtn.addEventListener('click', clearSeedPhrase);
  refreshSeedStatus();

  // v3.3.0: paso de la boveda
  document.getElementById('vaultGenerate').addEventListener('click', vaultGenerar);
  document.getElementById('vaultHave').addEventListener('click', () => vaultVista('vault-paste'));
  document.getElementById('vaultWritten').addEventListener('change', e => {
    document.getElementById('vaultToCheck').disabled = !e.target.checked;
  });
  document.getElementById('vaultToCheck').addEventListener('click', vaultIrAControl);
  document.getElementById('vaultBackToShow').addEventListener('click', () => vaultVista('vault-show'));
  document.getElementById('vaultConfirm').addEventListener('click', vaultConfirmar);
  document.getElementById('vaultBackToChoose').addEventListener('click', () => vaultVista('vault-choose'));
  document.getElementById('vaultActivatePasted').addEventListener('click', vaultActivarPegada);
  document.getElementById('vaultDone').addEventListener('click', route);
  document.getElementById('vaultBannerBtn').addEventListener('click', abrirPasoBoveda);

  // viewKey state
  document.getElementById('closeViewKey').addEventListener('click', () => showState('connected'));

  // filter
  document.getElementById('filter-project').addEventListener('change', e => {
    state.filterProject = e.target.value;
    state.selectedMemIds.clear();
    saveConfigSync({ filterProject: e.target.value });
    loadMemoriesView();
  });

  // refresh memories
  const refreshBtn = document.getElementById('refresh-memories');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadMemoriesView());

  // bulk apply tag
  const bulkApply = document.getElementById('bulk-apply');
  if (bulkApply) bulkApply.addEventListener('click', applyBulkTag);

  // settings — Project Brain: guardar el nombre tal cual (vacio = sin proyecto)
  const pbInput = document.getElementById('pb-project');
  if (pbInput) pbInput.addEventListener('change', e => {
    const v = (e.target.value || '').trim();
    state.projectBrainProject = v;
    saveConfigSync({ projectBrainProject: v });
  });
  // settings — PIN de datos sensibles (v3.3.2)
  const pinSave = document.getElementById('pin-save');
  if (pinSave) pinSave.addEventListener('click', guardarPin);
  const pinRemove = document.getElementById('pin-remove');
  if (pinRemove) pinRemove.addEventListener('click', quitarPin);
  document.getElementById('btn-add-project').addEventListener('click', openNewProjectModal);
  document.getElementById('modal-project-cancel').addEventListener('click', closeProjectModal);
  document.getElementById('modal-project-save').addEventListener('click', saveProject);
});
