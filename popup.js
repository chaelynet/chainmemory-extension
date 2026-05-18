// ChainMemory Extension Popup v2.1.0

const API_BASE = 'https://api.chainmemory.ai';
const FAUCET_URL = 'https://faucet.chainmemory.ai';

document.addEventListener('DOMContentLoaded', async () => {
  await updateStatus();
  await routeInitialState();
  initTabs();
  initSetupActions();
  initFaqAccordion();
  initCopyButtons();
  initInjectionSettings();
  setInterval(updateStatus, 30000);
});

// ============================================================
// TAB SWITCHING
// ============================================================
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('[id^="tab-"]').forEach(c => c.classList.add('hide'));
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hide');

      if (btn.dataset.tab === 'history') loadHistory();
    });
  });
}

// ============================================================
// NETWORK STATUS (live block)
// ============================================================
async function updateStatus() {
  try {
    const res = await fetch(`${API_BASE}/v1/stats`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    document.getElementById('netStatus').textContent = `Block #${data.block}`;
  } catch (e) {
    document.getElementById('netStatus').textContent = 'Offline';
  }
}

// ============================================================
// INITIAL STATE ROUTING
// ============================================================
async function routeInitialState() {
  const storage = await chrome.storage.sync.get(['apiKey', 'walletAddress']);

  if (storage.apiKey) {
    showState('connected');
    if (storage.walletAddress) {
      const short = storage.walletAddress.substring(0, 6) + '...' + storage.walletAddress.substring(38);
      document.getElementById('walletShort').textContent = short;
    } else {
      document.getElementById('walletShort').textContent = 'Saved';
    }
    const local = await chrome.storage.local.get(['history']);
    document.getElementById('savedCount').textContent = (local.history || []).length;
  } else {
    showState('noKey');
  }
}

function showState(name) {
  const states = ['noKey', 'pasteKey', 'keyCreated', 'connected', 'viewKey'];
  states.forEach(s => {
    const el = document.getElementById(`state-${s}`);
    if (el) {
      if (s === name) el.classList.remove('hide');
      else el.classList.add('hide');
    }
  });
}

// ============================================================
// SETUP ACTIONS
// ============================================================
function initSetupActions() {
  // ---- STATE noKey: Generate or Have key ----
  document.getElementById('generateKey').addEventListener('click', generateNewKey);
  document.getElementById('haveKey').addEventListener('click', () => {
    clearMsg('generateMsg');
    clearMsg('setupMsg');
    showState('pasteKey');
  });

  // ---- STATE pasteKey: Save key ----
  document.getElementById('saveKey').addEventListener('click', saveExistingKey);
  document.getElementById('backToNoKey').addEventListener('click', () => {
    clearMsg('setupMsg');
    showState('noKey');
  });

  // ---- STATE keyCreated: Checkbox + Continue ----
  document.getElementById('confirmSaved').addEventListener('change', (e) => {
    document.getElementById('continueAfterCreate').disabled = !e.target.checked;
  });
  document.getElementById('continueAfterCreate').addEventListener('click', continueAfterCreate);

  // ---- STATE connected: Actions ----
  document.getElementById('viewKey').addEventListener('click', showCurrentKey);
  document.getElementById('claimAic').addEventListener('click', openFaucetWithWallet);
  document.getElementById('disconnect').addEventListener('click', disconnect);

  // ---- STATE viewKey: Close ----
  document.getElementById('closeViewKey').addEventListener('click', () => showState('connected'));
}

// ============================================================
// GENERATE NEW KEY
// ============================================================
async function generateNewKey() {
  const btn = document.getElementById('generateKey');
  const msgEl = document.getElementById('generateMsg');
  const originalText = btn.innerHTML;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating your API key...';
  msgEl.className = 'msg info';
  msgEl.textContent = 'Creating your wallet on ChainMemory blockchain. This takes a few seconds...';

  try {
    const res = await fetch(`${API_BASE}/v1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!res.ok) throw new Error('Server returned ' + res.status);

    const data = await res.json();
    if (!data.api_key || !data.wallet) {
      throw new Error('Invalid response from server');
    }

    // Store BOTH key and wallet
    await chrome.storage.sync.set({
      apiKey: data.api_key,
      walletAddress: data.wallet
    });

    // Show the key in the keyCreated screen
    document.getElementById('newKeyDisplay').textContent = data.api_key;
    document.getElementById('newWalletDisplay').textContent = data.wallet;

    // Reset state of the key-created screen
    document.getElementById('confirmSaved').checked = false;
    document.getElementById('continueAfterCreate').disabled = true;

    clearMsg('generateMsg');
    showState('keyCreated');

  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = originalText;
    msgEl.className = 'msg error';
    msgEl.textContent = 'Error: ' + e.message + '. Please try again.';
  }
}

// ============================================================
// CONTINUE AFTER KEY CREATED
// ============================================================
async function continueAfterCreate() {
  const storage = await chrome.storage.sync.get(['walletAddress']);
  // Open faucet pre-filled with wallet
  if (storage.walletAddress) {
    chrome.tabs.create({ url: `${FAUCET_URL}/?wallet=${storage.walletAddress}` });
  } else {
    chrome.tabs.create({ url: FAUCET_URL });
  }
  // Go to connected state
  await routeInitialState();
}

// ============================================================
// SAVE EXISTING KEY (paste flow)
// ============================================================
async function saveExistingKey() {
  const key = document.getElementById('apiKey').value.trim();
  const msg = document.getElementById('setupMsg');

  if (!key.startsWith('aic_')) {
    msg.className = 'msg error';
    msg.textContent = 'Invalid API key. It should start with "aic_"';
    return;
  }

  msg.className = 'msg info';
  msg.textContent = 'Verifying your API key...';

  try {
    const res = await fetch(`${API_BASE}/v1/profile`, {
      headers: { 'x-api-key': key }
    });

    if (res.status === 401) {
      msg.className = 'msg error';
      msg.textContent = 'Invalid API key.';
      return;
    }

    const data = await res.json();

    // Save data
    await chrome.storage.sync.set({
      apiKey: key,
      walletAddress: data.owner || null,
      aiName: data.name || null,
      aiId: data.ai_id || null
    });

    msg.className = 'msg success';
    msg.textContent = 'Connected!';

    setTimeout(() => routeInitialState(), 1200);

  } catch (e) {
    msg.className = 'msg error';
    msg.textContent = 'Error: ' + e.message;
  }
}

// ============================================================
// VIEW KEY (with state transition)
// ============================================================
async function showCurrentKey() {
  const storage = await chrome.storage.sync.get(['apiKey', 'walletAddress']);
  document.getElementById('currentKeyDisplay').textContent = storage.apiKey || '(missing)';
  document.getElementById('currentWalletDisplay').textContent = storage.walletAddress || '(not registered)';
  showState('viewKey');
}

// ============================================================
// FAUCET (open with wallet pre-filled)
// ============================================================
async function openFaucetWithWallet() {
  const storage = await chrome.storage.sync.get(['walletAddress']);
  if (storage.walletAddress) {
    chrome.tabs.create({ url: `${FAUCET_URL}/?wallet=${storage.walletAddress}` });
  } else {
    chrome.tabs.create({ url: FAUCET_URL });
  }
}

// ============================================================
// DISCONNECT
// ============================================================
async function disconnect() {
  if (!confirm('Disconnect ChainMemory? Your API key will be removed from this browser. Make sure you have backed it up.\n\nYour memories remain on the blockchain forever.')) return;
  await chrome.storage.sync.remove(['apiKey', 'walletAddress', 'aiName', 'aiId']);
  await routeInitialState();
}

// ============================================================
// HISTORY TAB
// ============================================================
async function loadHistory() {
  const storage = await chrome.storage.local.get(['history']);
  const history = storage.history || [];
  const container = document.getElementById('historyList');

  if (history.length === 0) {
    container.innerHTML = '<div class="empty">No memories saved yet.<br><br>Click "Save to ChainMemory" on any AI response to start.</div>';
    return;
  }

  container.innerHTML = history.slice(0, 30).map(item => `
    <div class="memory-item">
      <div class="mem-meta">
        <span class="mem-badge">${escapeHtml(item.platform || 'AI')}</span>
        <span>${timeAgo(item.timestamp)}${item.memoryId ? ' · #' + item.memoryId : ''}</span>
      </div>
      <div class="mem-text">${escapeHtml((item.response || '').substring(0, 200))}</div>
    </div>
  `).join('');
}

// ============================================================
// FAQ ACCORDION
// ============================================================
function initFaqAccordion() {
  document.querySelectorAll('.faq-q').forEach(q => {
    q.addEventListener('click', () => {
      q.classList.toggle('open');
    });
  });
}

// ============================================================
// COPY BUTTONS
// ============================================================
function initCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.copy;
      const target = document.getElementById(targetId);
      if (!target) return;
      const text = target.textContent;
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1500);
      } catch (e) {
        btn.textContent = 'Error';
      }
    });
  });
}

// ============================================================
// INJECTION SETTINGS (new in v2.1.0)
// ============================================================
async function initInjectionSettings() {
  const limitSel = document.getElementById('injectLimit');
  const verifiedChk = document.getElementById('injectVerifiedOnly');
  if (!limitSel || !verifiedChk) return; // popup state may not have these yet

  // Load saved settings
  const settings = await chrome.storage.sync.get(['injectLimit', 'injectVerifiedOnly']);
  if (settings.injectLimit) limitSel.value = String(settings.injectLimit);
  if (settings.injectVerifiedOnly === true) verifiedChk.checked = true;

  // Persist on change
  limitSel.addEventListener('change', async () => {
    await chrome.storage.sync.set({ injectLimit: parseInt(limitSel.value, 10) });
  });
  verifiedChk.addEventListener('change', async () => {
    await chrome.storage.sync.set({ injectVerifiedOnly: verifiedChk.checked });
  });
}

// ============================================================
// HELPERS
// ============================================================
function clearMsg(id) {
  const el = document.getElementById(id);
  if (el) {
    el.className = '';
    el.textContent = '';
  }
}

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  return days + 'd ago';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
