// ═══════════════════════════════════════════════════════════════════
// ChainMemory v3.0.9 — content.js
// Features:
//   1. Save to ChainMemory button on each AI response (from v2.1.0)
//   2. Retrospective scan of old messages (NEW)
//   3. Floating FAB "+ Inject memory"
//   4. Preview panel with selective inject
//   5. Optimistic payment (instant text injection)
//   6. "Top up AIC" button when balance < 0.001
//   7. Multi-language selectors (Perplexity contenteditable, etc.)
// ═══════════════════════════════════════════════════════════════════

(function() {
  'use strict';

  const API_BASE = 'https://api.chainmemory.ai';
  const FAUCET_URL = 'https://faucet.chainmemory.ai';
  const MIN_BALANCE_WEI = 1000000000000000n; // 0.001 AIC

  // ── Platform configs ──
  const PLATFORMS = {
    'claude.ai': {
      name: 'Claude',
      key: 'claude',
      inputSelector: 'div[contenteditable="true"][role="textbox"], div.ProseMirror, fieldset textarea',
      inputType: 'contenteditable',
      // For Save button: each AI response container
      responseSelectors: [
        '[data-is-streaming]'
      ]
    },
    'chatgpt.com': {
      name: 'ChatGPT',
      key: 'chatgpt',
      inputSelector: '#prompt-textarea, div#prompt-textarea[contenteditable="true"], textarea[data-id="root"]',
      inputType: 'mixed',
      responseSelectors: [
        '[data-message-author-role="assistant"]',
        'div[data-testid^="conversation-turn"][data-message-author-role="assistant"]'
      ]
    },
    'chat.openai.com': {
      name: 'ChatGPT',
      key: 'chatgpt',
      inputSelector: '#prompt-textarea, textarea[data-id="root"]',
      inputType: 'textarea',
      responseSelectors: ['[data-message-author-role="assistant"]']
    },
    'perplexity.ai': {
      name: 'Perplexity',
      key: 'perplexity',
      // Perplexity 2026: contenteditable + textarea fallbacks for older versions/i18n
      inputSelector: [
        'div[contenteditable="true"][role="textbox"]',
        'textarea[placeholder*="Ask"]',
        'textarea[placeholder*="Solicitar"]',
        'textarea[placeholder*="follow"]',
        'main [contenteditable="true"]',
        'main textarea'
      ].join(', '),
      inputType: 'contenteditable',
      responseSelectors: [
        'div.prose',
        '[class*="prose"]',
        'div[class*="answer"]'
      ],
      singleButtonAtEnd: true
    },
    'gemini.google.com': {
      name: 'Gemini',
      key: 'gemini',
      inputSelector: 'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"]',
      inputType: 'contenteditable',
      responseSelectors: [
        'message-content',
        'div.model-response-text',
        '[class*="response"]'
      ],
      singleButtonAtEnd: true
    }
  };

  // ── State ──
  let _state = {
    apiKey: null,
    wallet: null,
    filterProject: '',
    panelOpen: false,
    memories: [],
    selectedIds: new Set(),
    balance: 0n,
    aiName: null,
    projectBrainProject: 'chainmemory'
  };

  let _platform = null;
  let _observer = null;
  let _savedResponses = new WeakSet();
  let _saveBtn = null;          // boton unico "Save" (plataformas singleButtonAtEnd)
  let _saveBtnResponse = null;  // respuesta a la que apunta el boton unico
  let _scanTimer = null;        // debounce del observer

  // ── Detect platform ──
  function detectPlatform() {
    const host = window.location.hostname.replace(/^www\./, '');
    for (const key in PLATFORMS) {
      if (host.includes(key)) return { ...PLATFORMS[key], host };
    }
    return null;
  }

  // ── Load config ──
  function loadConfig() {
    return new Promise(resolve => {
      chrome.storage.sync.get(['apiKey', 'walletAddress', 'filterProject', 'aiName', 'projectBrainProject'], data => {
        _state.apiKey = data.apiKey || null;
        _state.wallet = data.walletAddress || null;
        _state.filterProject = data.filterProject || '';
        _state.aiName = data.aiName || null;
        _state.projectBrainProject = data.projectBrainProject || 'chainmemory';
        resolve();
      });
    });
  }

  // ── API ──
  async function api(method, path, body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (_state.apiKey) opts.headers['x-api-key'] = _state.apiKey;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ── Toast ──
  function toast(msg, type = 'info') {
    const old = document.querySelector('.cm-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'cm-toast cm-toast-' + type;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.classList.add('cm-toast-out');
      setTimeout(() => t.remove(), 300);
    }, 3000);
  }

  // ── Find input element ──
  function findInput() {
    if (!_platform) return null;
    const selectors = _platform.inputSelector.split(',').map(s => s.trim());
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) {}
    }
    return null;
  }

  // ── Inject text into chat input ──
  function injectIntoInput(text) {
    const el = findInput();
    if (!el) return false;
    el.focus();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const existing = el.value || '';
      const merged = existing ? (text + existing) : text;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, merged);
      else el.value = merged;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (el.isContentEditable || el.contentEditable === 'true') {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        document.execCommand('insertText', false, text);
      } catch (e) {
        const tn = document.createTextNode(text);
        if (el.firstChild) el.insertBefore(tn, el.firstChild);
        else el.appendChild(tn);
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 1: SAVE BUTTON ON EACH AI RESPONSE (from v2.1.0)
  // ═══════════════════════════════════════════════════════════════════

  function findAIResponses() {
    if (!_platform) return [];
    const responses = [];
    for (const sel of _platform.responseSelectors) {
      try {
        const found = document.querySelectorAll(sel);
        found.forEach(el => {
          if (!responses.includes(el)) responses.push(el);
        });
      } catch (e) {}
    }
    return responses;
  }

  function extractResponseText(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim();
  }

  function attachSaveButton(responseEl) {
    if (!responseEl || _savedResponses.has(responseEl)) return;
    if (responseEl.querySelector('.cm-save-btn')) return;
    _savedResponses.add(responseEl);

    const btn = document.createElement('button');
    btn.className = 'cm-save-btn';
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Save to ChainMemory</span>
    `;
    btn.title = 'Save this response to your ChainMemory blockchain';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleSaveClick(btn, responseEl);
    });
    responseEl.appendChild(btn);
  }

  async function handleSaveClick(btn, responseEl) {
    if (!_state.apiKey) {
      toast('Connect ChainMemory first', 'warn');
      chrome.runtime.sendMessage({ action: 'openPopup' });
      return;
    }
    const text = extractResponseText(responseEl);
    if (!text || text.length < 10) {
      toast('Response too short', 'warn');
      return;
    }

    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="40 60" /></svg><span>Saving...</span>';

    try {
      // Ensure registered (one-time per session)
      if (!_state.aiName) {
        try {
          const profile = await api('GET', '/v1/profile');
          if (profile.ai_id) {
            _state.aiName = profile.name || _platform.name;
            chrome.storage.sync.set({ aiName: _state.aiName });
          } else {
            // Auto-register
            await api('POST', '/v1/register', { name: _platform.name + ' user', model: _platform.key });
            _state.aiName = _platform.name;
            chrome.storage.sync.set({ aiName: _state.aiName });
          }
        } catch (e) {
          console.warn('[ChainMemory] register check failed:', e.message);
        }
      }

      const summary = `[${_platform.name}] ${text.substring(0, 1500)}`;
      const result = await api('POST', '/v1/memory', {
        summary,
        category: 'INTERACTION',
        importance: 5,
        platform: _platform.key
      });

      // Save to local history for quick stats
      const local = await chromeGetLocal(['history']);
      const history = local.history || [];
      history.unshift({
        timestamp: Date.now(),
        platform: _platform.key,
        memoryId: result.memory_id,
        response: text.substring(0, 200)
      });
      await chromeSetLocal({ history: history.slice(0, 200) });

      btn.classList.add('cm-saved');
      btn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Saved #${result.memory_number ?? result.memory_id}</span>
      `;
      toast(`✓ Saved to ChainMemory #${result.memory_number ?? result.memory_id}`, 'success');
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = orig;
      toast('Save failed: ' + e.message, 'error');
    }
  }

  // ── Scan retrospectivo (NEW) ──
  function scanExistingResponses() {
    const responses = findAIResponses();
    if (responses.length === 0) return 0;
    let attached = 0;
    for (const r of responses) {
      if (!_savedResponses.has(r) && !r.querySelector('.cm-save-btn')) {
        attachSaveButton(r);
        attached++;
      }
    }
    return attached;
  }

  // ── Modelo "un boton al final" (Perplexity/Gemini: DOM ancho + re-render) ──
  function createSaveButton() {
    const btn = document.createElement('button');
    btn.className = 'cm-save-btn';
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Save to ChainMemory</span>
    `;
    btn.title = 'Save the latest response to your ChainMemory blockchain';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleSaveClick(btn, _saveBtnResponse);
    });
    return btn;
  }

  function resetSaveButton() {
    if (!_saveBtn) return;
    _saveBtn.classList.remove('cm-saved');
    _saveBtn.disabled = false;
    _saveBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Save to ChainMemory</span>
    `;
  }

  // Devuelve la ULTIMA respuesta en orden de DOM, usando el selector mas especifico
  // que matchee, colapsando matches anidados a su ancestro mas externo.
  function getLastResponseEl() {
    if (!_platform) return null;
    for (const sel of _platform.responseSelectors) {
      let found;
      try { found = document.querySelectorAll(sel); } catch (e) { continue; }
      if (!found || !found.length) continue;
      let list = Array.from(found);
      list = list.filter(el => !list.some(o => o !== el && o.contains(el)));
      list.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
      return list[list.length - 1] || null;
    }
    return null;
  }

  // Garantiza EXACTAMENTE UN boton, sobre la ultima respuesta ("final del chat").
  function ensureSingleSaveButton() {
    const last = getLastResponseEl();
    if (!last) return;
    if (!_saveBtn) _saveBtn = createSaveButton();

    // Borra cualquier boton que no sea nuestra instancia unica
    document.querySelectorAll('.cm-save-btn').forEach(b => { if (b !== _saveBtn) b.remove(); });

    // Ya colocado en la ultima respuesta actual -> nada que hacer
    if (_saveBtnResponse === last && last.contains(_saveBtn)) return;

    // Cambio el target (nueva respuesta o nodo re-renderizado) -> mover + refrescar
    _saveBtnResponse = last;
    resetSaveButton();
    last.appendChild(_saveBtn);
  }

  // Dispatcher: plataformas "ancho/re-render" -> uno-al-final; el resto -> por-respuesta.
  function runScan() {
    if (!_platform) return;
    if (_platform.singleButtonAtEnd) ensureSingleSaveButton();
    else scanExistingResponses();
  }

  function startObserver() {
    if (_observer) return;
    _observer = new MutationObserver(() => {
      if (_scanTimer) return;            // throttle de rafagas de mutaciones
      _scanTimer = setTimeout(() => {
        _scanTimer = null;
        runScan();
      }, 400);
    });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 2: FAB + PREVIEW PANEL (INJECT)
  // ═══════════════════════════════════════════════════════════════════

  function createFAB() {
    if (document.querySelector('.cm-inject-fab')) return;
    const btn = document.createElement('button');
    btn.className = 'cm-inject-fab';
    btn.title = 'Inject ChainMemory context';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
      <span>Inject memory</span>
    `;
    btn.addEventListener('click', togglePanel);
    document.body.appendChild(btn);
  }

  async function togglePanel() {
    if (_state.panelOpen) {
      closePanel();
      return;
    }
    await loadConfig();
    if (!_state.apiKey) {
      toast('Connect ChainMemory first (click extension icon)', 'warn');
      chrome.runtime.sendMessage({ action: 'openPopup' });
      return;
    }
    openPanel();
  }

  function closePanel() {
    const p = document.querySelector('.cm-preview-panel');
    if (p) p.remove();
    _state.panelOpen = false;
    _state.selectedIds.clear();
  }

  async function openPanel() {
    _state.panelOpen = true;
    _state.selectedIds.clear();
    const panel = document.createElement('div');
    panel.className = 'cm-preview-panel';
    panel.innerHTML = `
      <div class="cm-pp-header">
        <div class="cm-pp-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
          Inject ChainMemory context <span class="cm-pp-ver">v${chrome.runtime.getManifest().version}</span>
        </div>
        <button class="cm-pp-close" title="Close">×</button>
      </div>
      <div class="cm-pp-brain">
        <button class="cm-pp-brain-btn" title="Inject the consolidated project state into this chat">⚡ Inject project state</button>
        <span class="cm-pp-brain-hint">Loads the whole project brain</span>
      </div>
      <div class="cm-pp-filters">
        <select class="cm-pp-filter-project">
          <option value="">All projects</option>
        </select>
        <label class="cm-pp-check"><input type="checkbox" class="cm-pp-archived-toggle"> Show archived</label>
      </div>
      <div class="cm-pp-actions-top">
        <label class="cm-pp-check"><input type="checkbox" class="cm-pp-select-all"> Select all</label>
        <span class="cm-pp-selection-info">0 selected</span>
      </div>
      <div class="cm-pp-list">
        <div class="cm-pp-loading">Loading memories…</div>
      </div>
      <div class="cm-pp-balance-line">
        <span class="cm-pp-bal-label">Balance:</span>
        <span class="cm-pp-bal-value">--</span>
      </div>
      <div class="cm-pp-actions">
        <button class="cm-pp-cancel">Cancel</button>
        <button class="cm-pp-inject" disabled>Inject 0 memories</button>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.cm-pp-close').addEventListener('click', closePanel);
    panel.querySelector('.cm-pp-cancel').addEventListener('click', closePanel);
    panel.querySelector('.cm-pp-inject').addEventListener('click', handleInjectClick);
    panel.querySelector('.cm-pp-brain-btn').addEventListener('click', e => handleInjectProjectState(e.currentTarget));
    panel.querySelector('.cm-pp-filter-project').addEventListener('change', e => {
      _state.filterProject = e.target.value;
      loadMemoriesIntoPanel();
    });
    panel.querySelector('.cm-pp-archived-toggle').addEventListener('change', loadMemoriesIntoPanel);
    panel.querySelector('.cm-pp-select-all').addEventListener('change', e => selectAllToggle(e.target.checked));

    await loadProjectsIntoFilter(panel);
    await loadBalanceIntoPanel(panel);
    await loadMemoriesIntoPanel();
  }

  async function loadProjectsIntoFilter(panel) {
    try {
      const data = await api('GET', '/v1/projects');
      const sel = panel.querySelector('.cm-pp-filter-project');
      sel.innerHTML = '<option value="">All projects</option><option value="general">General (untagged)</option>';
      for (const p of data.projects || []) {
        const opt = document.createElement('option');
        opt.value = p.project_id;
        opt.textContent = p.name;
        sel.appendChild(opt);
      }
      if (_state.filterProject) sel.value = _state.filterProject;
    } catch (e) {}
  }

  async function loadBalanceIntoPanel(panel) {
    try {
      const bal = await api('GET', '/v1/inject/balance');
      _state.balance = BigInt(bal.balance_wei);
      const balDisplay = panel.querySelector('.cm-pp-bal-value');
      balDisplay.textContent = parseFloat(bal.balance_aic).toFixed(4) + ' AIC';
      if (_state.balance < MIN_BALANCE_WEI) {
        balDisplay.classList.add('cm-pp-bal-low');
      }
    } catch (e) {
      panel.querySelector('.cm-pp-bal-value').textContent = '--';
    }
    updatePanelFooter();
  }

  async function loadMemoriesIntoPanel() {
    const panel = document.querySelector('.cm-preview-panel');
    if (!panel) return;
    const list = panel.querySelector('.cm-pp-list');
    list.innerHTML = '<div class="cm-pp-loading">Loading memories…</div>';

    const filterProj = panel.querySelector('.cm-pp-filter-project').value;
    const showArchived = panel.querySelector('.cm-pp-archived-toggle').checked;

    const params = new URLSearchParams();
    params.set('include_plaintext', '1');
    params.set('limit', '50');
    if (filterProj) params.set('project', filterProj);
    if (showArchived) params.set('archived', '1');

    try {
      const data = await api('GET', '/v1/memories/list?' + params);
      _state.memories = data.memories || [];
      _state.selectedIds.clear();

      if (_state.memories.length === 0) {
        list.innerHTML = '<div class="cm-pp-empty">No memories yet. Save AI responses with the page button to start.</div>';
        updatePanelFooter();
        return;
      }

      list.innerHTML = '';
      for (const mem of _state.memories) {
        list.appendChild(renderMemRow(mem));
      }
      updatePanelFooter();
    } catch (e) {
      list.innerHTML = `<div class="cm-pp-empty">Failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  function renderMemRow(mem) {
    const div = document.createElement('div');
    div.className = 'cm-pp-mem-row';
    div.dataset.id = mem.id;
    const text = mem.summary || mem.summary_preview || '(empty)';
    const dt = new Date(mem.timestamp * 1000);
    const dateStr = dt.toLocaleDateString();
    const tagsHTML = (mem.tags || []).map(t => `<span class="cm-pp-tag">${escapeHtml(t)}</span>`).join('');

    div.innerHTML = `
      <input type="checkbox" class="cm-pp-mem-check">
      <div class="cm-pp-mem-body">
        <div class="cm-pp-mem-meta">
          <span class="cm-pp-mem-id">#${mem.memory_number || mem.id}</span>
          <span class="cm-pp-plat">[${escapeHtml(mem.category || 'CUSTOM')}]</span>
          <span class="cm-pp-mem-date">${dateStr}</span>
          <span class="cm-pp-mem-tokens">~${mem.estimated_tokens || 0} tokens</span>
        </div>
        <div class="cm-pp-mem-text">${escapeHtml(text.substring(0, 200))}${text.length > 200 ? '…' : ''}</div>
        ${tagsHTML ? `<div class="cm-pp-mem-tags">${tagsHTML}</div>` : ''}
      </div>
      <button class="cm-pp-archive-btn" title="${mem.archived ? 'Unarchive' : 'Archive'}">${mem.archived ? '↩' : '📦'}</button>
    `;

    const cb = div.querySelector('.cm-pp-mem-check');
    cb.addEventListener('click', e => { e.stopPropagation(); toggleSelect(mem.id); });
    div.addEventListener('click', e => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      toggleSelect(mem.id);
    });
    div.querySelector('.cm-pp-archive-btn').addEventListener('click', async e => {
      e.stopPropagation();
      await toggleArchive(mem.id, !!mem.archived);
    });
    return div;
  }

  function toggleSelect(id) {
    if (_state.selectedIds.has(id)) _state.selectedIds.delete(id);
    else _state.selectedIds.add(id);
    const row = document.querySelector(`.cm-pp-mem-row[data-id="${id}"]`);
    if (row) {
      row.classList.toggle('selected', _state.selectedIds.has(id));
      const cb = row.querySelector('.cm-pp-mem-check');
      if (cb) cb.checked = _state.selectedIds.has(id);
    }
    updatePanelFooter();
  }

  function selectAllToggle(check) {
    if (check) _state.memories.forEach(m => _state.selectedIds.add(m.id));
    else _state.selectedIds.clear();
    document.querySelectorAll('.cm-pp-mem-row').forEach(row => {
      const id = parseInt(row.dataset.id);
      row.classList.toggle('selected', _state.selectedIds.has(id));
      const cb = row.querySelector('.cm-pp-mem-check');
      if (cb) cb.checked = _state.selectedIds.has(id);
    });
    updatePanelFooter();
  }

  async function toggleArchive(id, currentlyArchived) {
    try {
      const ep = currentlyArchived ? `/v1/memories/${id}/unarchive` : `/v1/memories/${id}/archive`;
      await api('POST', ep);
      toast(currentlyArchived ? 'Unarchived' : 'Archived', 'success');
      _state.selectedIds.delete(id);
      loadMemoriesIntoPanel();
    } catch (e) {
      toast('Archive failed: ' + e.message, 'error');
    }
  }

  // ── Update footer button — Top up AIC if no balance ──
  function updatePanelFooter() {
    const panel = document.querySelector('.cm-preview-panel');
    if (!panel) return;
    const btn = panel.querySelector('.cm-pp-inject');
    const info = panel.querySelector('.cm-pp-selection-info');
    const count = _state.selectedIds.size;

    let totalTokens = 0;
    _state.memories.forEach(m => {
      if (_state.selectedIds.has(m.id)) totalTokens += m.estimated_tokens || 0;
    });
    info.textContent = count === 0 ? '0 selected' : `${count} selected · ~${totalTokens} tokens`;

    // Logic: balance < 0.001 → "Top up AIC" button
    if (_state.balance < MIN_BALANCE_WEI) {
      btn.disabled = false;
      btn.textContent = '💧 Top up AIC';
      btn.classList.add('cm-pp-inject-topup');
      return;
    }
    btn.classList.remove('cm-pp-inject-topup');

    if (count === 0) {
      btn.disabled = true;
      btn.textContent = 'Inject 0 memories';
      return;
    }
    btn.disabled = false;
    btn.textContent = `Inject ${count} ${count === 1 ? 'memory' : 'memories'}`;
  }

  async function handleInjectClick() {
    // If no balance → open faucet
    if (_state.balance < MIN_BALANCE_WEI) {
      const url = _state.wallet ? `${FAUCET_URL}/?wallet=${_state.wallet}` : FAUCET_URL;
      window.open(url, '_blank');
      return;
    }

    if (_state.selectedIds.size === 0) return;
    executeInjectOptimistic();
  }

  // ── Execute inject — OPTIMISTIC (instant text injection) ──
  async function executeInjectOptimistic() {
    const panel = document.querySelector('.cm-preview-panel');
    const btn = panel.querySelector('.cm-pp-inject');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Injecting…';

    const ids = Array.from(_state.selectedIds);

    try {
      // Call optimistic endpoint
      const result = await api('POST', '/v1/inject', {
        memory_ids: ids,
        project_filter: _state.filterProject || null,
        target_platform: _platform ? _platform.key : 'unknown',
        optimistic: true
      });

      const text = buildInjectText(result.memories);

      // Inject immediately
      const ok = injectIntoInput(text);
      if (ok) {
        toast(`✅ Injected ${result.injected} memories · 0.001 AIC`, 'success');
      } else {
        await navigator.clipboard.writeText(text);
        toast('Inject paid · text copied to clipboard', 'success');
      }
      closePanel();
    } catch (e) {
      if (e.status === 402 || (e.data && e.data.error === 'insufficient_aic')) {
        toast('Not enough AIC. Opening faucet…', 'warn');
        setTimeout(() => {
          const url = _state.wallet ? `${FAUCET_URL}/?wallet=${_state.wallet}` : FAUCET_URL;
          window.open(url, '_blank');
        }, 800);
        // Reload balance for next attempt
        await loadBalanceIntoPanel(panel);
      } else {
        toast('Inject failed: ' + e.message, 'error');
      }
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  function buildInjectText(memories) {
    if (!memories || memories.length === 0) return '';
    const header = '[Context from ChainMemory]\n\n';
    const body = memories.map(m => {
      const date = new Date(m.timestamp * 1000).toISOString().split('T')[0];
      return `[${date}] ${m.summary}`;
    }).join('\n\n');
    return header + body + '\n\n---\n\n';
  }

  // ── Project Brain: format + inject consolidated state ──
  function formatProjectState(s, name) {
    const st = s.state || s;   // los campos del estado viven en s.state; fallback defensivo
    const lines = ['[ChainMemory · Project State: ' + (s.project || name) + (s.version != null ? ' v' + s.version : '') + ']', ''];
    // --- meta-info block (anchor / updated / evidence) ---
    if (s.anchor && s.anchor.status === 'anchored') {
      const blk = s.anchor.block_number != null ? ' (block ' + s.anchor.block_number + ')' : '';
      const tx = s.anchor.tx_hash ? ', tx ' + s.anchor.tx_hash.slice(0, 10) + '…' + s.anchor.tx_hash.slice(-8) : '';
      lines.push('✓ Anchored on chain' + blk + tx);
    }
    if (s.generated_at) {
      const d = new Date(s.generated_at);
      if (!isNaN(d.getTime())) {
        const ymd = d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        const diffMs = Date.now() - d.getTime();
        const mins = Math.floor(diffMs / 60000);
        const hours = Math.floor(diffMs / 3600000);
        const days = Math.floor(diffMs / 86400000);
        let rel;
        if (diffMs < 60000) rel = 'just now';
        else if (hours < 1) rel = mins + ' min ago';
        else if (days < 1) rel = hours + 'h ago';
        else if (days === 1) rel = 'yesterday';
        else if (days < 30) rel = days + ' days ago';
        else rel = Math.floor(days / 30) + ' months ago';
        lines.push('Updated: ' + ymd + ' (' + rel + ')');
      }
    }
    const evidenceIds = new Set();
    ['decisions','open_risks','next_priorities','milestones','assumptions','open_questions','priorities'].forEach(k => {
      const arr = st[k];
      if (!Array.isArray(arr)) return;
      arr.forEach(item => {
        if (item && Array.isArray(item.memory_ids)) item.memory_ids.forEach(id => evidenceIds.add(id));
        if (item && Array.isArray(item.evidence)) item.evidence.forEach(id => evidenceIds.add(id));
      });
    });
    if (evidenceIds.size > 0) lines.push('Evidence: ' + evidenceIds.size + ' memories');
    if (lines.length > 2) lines.push('');   // separador meta -> cuerpo, solo si hubo meta
    // --- cuerpo del estado ---
    if (st.phase) lines.push('Phase: ' + st.phase);
    if (st.current_focus) lines.push('Current focus: ' + st.current_focus);
    if (st.vocabulary && Object.keys(st.vocabulary).length) {
      lines.push('', 'Vocabulary:');
      for (const k in st.vocabulary) lines.push('- ' + k + ': ' + st.vocabulary[k]);
    }
    if (Array.isArray(st.constraints) && st.constraints.length) {
      lines.push('', 'Constraints:');
      st.constraints.forEach(c => lines.push('- ' + (typeof c === 'object' ? (c.statement || JSON.stringify(c)) : c)));
    }
    if (Array.isArray(st.decisions) && st.decisions.length) {
      lines.push('', 'Decisions:');
      st.decisions.filter(d => d && d.status !== 'superseded').forEach(d => {
        const ev = '';
        lines.push('- [' + (d.status || '?') + '] ' + (d.title || '') + (d.statement ? ' — ' + d.statement : '') + ev);
      });
    }
    if (Array.isArray(st.open_risks) && st.open_risks.length) {
      lines.push('', 'Open risks:');
      st.open_risks.filter(r => r && r.status !== 'closed').forEach(r => {
        const ev = '';
        lines.push('- [' + (r.severity || '?') + '] ' + (r.title || '') + (r.status ? ' → ' + r.status : '') + ev);
      });
    }
    if (Array.isArray(st.next_priorities) && st.next_priorities.length) {
      lines.push('', 'Next priorities:');
      st.next_priorities.forEach(p => lines.push('- ' + p));
    }
    if (s.state_hash) lines.push('', '(state_hash: ' + s.state_hash.slice(0, 10) + '\u2026' + s.state_hash.slice(-8) + ')');
    lines.push('', '---', '');
    let out = lines.join('\n');
    const MAX_INJECT_CHARS = 7000;
    if (out.length > MAX_INJECT_CHARS) {
      out = out.slice(0, MAX_INJECT_CHARS - 30) + '\n\u2026[context trimmed]\n---\n';
    }
    return out;
  }

  async function handleInjectProjectState(btn) {
    const projectName = _state.projectBrainProject || 'chainmemory';
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const data = await api('GET', '/v1/project/' + encodeURIComponent(projectName) + '/state');
      const text = formatProjectState(data, projectName);
      const okInj = injectIntoInput(text);
      if (okInj) {
        toast('✓ Project state "' + projectName + '" injected', 'success');
        closePanel();
      } else {
        await navigator.clipboard.writeText(text);
        toast('Project state copied to clipboard', 'success');
      }
    } catch (e) {
      if (e.status === 404) toast('No project state for "' + projectName + '" yet', 'warn');
      else if (e.status === 401) toast('Connect ChainMemory first', 'warn');
      else toast('Failed to load project state: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════

  function chromeGetLocal(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }
  function chromeSetLocal(obj) {
    return new Promise(resolve => chrome.storage.local.set(obj, resolve));
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ═══════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════

  async function init() {
    _platform = detectPlatform();
    if (!_platform) return;
    await loadConfig();
    createFAB();

    // Retrospective scan after page loads + observe for new
    setTimeout(() => {
      runScan();
      console.log(`[ChainMemory v3.0.9] save-button mode on ${_platform.name}: ${_platform.singleButtonAtEnd ? 'single-at-end' : 'per-response'}`);
      startObserver();
    }, 1500);

    // Listen for refresh request from popup
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === 'rescan') {
        let added = 0;
        if (_platform.singleButtonAtEnd) { ensureSingleSaveButton(); added = _saveBtn ? 1 : 0; }
        else { added = scanExistingResponses(); }
        sendResponse({ scanned: added });
        return true;
      }
    });

    console.log('[ChainMemory v3.0.9] loaded on', _platform.name);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
