// ChainMemory Content Script v2.1.0
// - Injects "Save to ChainMemory" buttons on AI responses (v2.0.x behavior, unchanged)
// - Adds floating "Inject my context" button to paste verified memory into the prompt

// ============================================================
// PLATFORM CONFIGURATION
// ============================================================
// Each platform exposes:
//   - findResponses(): elements that hold AI responses (for Save button)
//   - findPromptInput(): the textarea/contenteditable where the user types (for Inject)
// findPromptInput is best-effort; if it returns null, the inject flow falls back
// to copying the context to clipboard.
const PLATFORMS = {
  'chatgpt.com': {
    name: 'ChatGPT',
    model: 'gpt-4',
    findResponses: () => document.querySelectorAll('[data-message-author-role="assistant"] .markdown'),
    findPromptInput: () =>
      document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
      document.querySelector('textarea[data-id]') ||
      document.querySelector('textarea[placeholder]')
  },
  'chat.openai.com': {
    name: 'ChatGPT',
    model: 'gpt-4',
    findResponses: () => document.querySelectorAll('[data-message-author-role="assistant"] .markdown'),
    findPromptInput: () =>
      document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
      document.querySelector('textarea[data-id]')
  },
  'claude.ai': {
    name: 'Claude',
    model: 'claude',
    findResponses: () => {
      const turns = document.querySelectorAll('div.mb-1.mt-6.group');
      return Array.from(turns).filter(turn => !turn.querySelector('.bg-bg-300'));
    },
    findPromptInput: () =>
      document.querySelector('div[contenteditable="true"].ProseMirror') ||
      document.querySelector('div[contenteditable="true"]')
  },
  'gemini.google.com': {
    name: 'Gemini',
    model: 'gemini',
    findResponses: () => document.querySelectorAll('message-content, .response-content'),
    findPromptInput: () =>
      document.querySelector('rich-textarea div[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]')
  },
  'www.perplexity.ai': {
    name: 'Perplexity',
    model: 'perplexity',
    findResponses: () => document.querySelectorAll('.prose'),
    findPromptInput: () =>
      document.querySelector('textarea[placeholder*="Ask"]') ||
      document.querySelector('textarea')
  }
};

const currentPlatform = Object.keys(PLATFORMS).find(p => window.location.hostname.includes(p));
if (!currentPlatform) console.log('[ChainMemory] Platform not supported');

const platform = PLATFORMS[currentPlatform];
if (platform) initChainMemory();

// ============================================================
// INIT
// ============================================================
function initChainMemory() {
  console.log(`[ChainMemory] v2.1.0 initialized on ${platform.name}`);

  // Observe DOM for new AI responses (existing Save flow)
  const observer = new MutationObserver(() => {
    injectButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(injectButtons, 1000);

  // Floating "Inject context" button (new in v2.1)
  setTimeout(injectFloatingButton, 1500);
}

// ============================================================
// SAVE FLOW (unchanged from v2.0.x)
// ============================================================
function injectButtons() {
  const responses = platform.findResponses();
  responses.forEach((response, idx) => {
    if (response.dataset.cmInjected) return;
    response.dataset.cmInjected = 'true';

    const btn = createSaveButton(response, idx);
    let parent;
    if (platform.name === 'Claude') {
      parent = response;
    } else {
      parent = response.closest('[class*="message"], [class*="turn"], article') || response.parentElement;
    }
    if (parent && !parent.querySelector('.cm-save-btn')) {
      parent.appendChild(btn);
    }
  });
}

function createSaveButton(response, idx) {
  const btn = document.createElement('button');
  btn.className = 'cm-save-btn';
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M19 21L12 16L5 21V5C5 4.44772 5.44772 4 6 4H18C18.5523 4 19 4.44772 19 5V21Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span>Save to ChainMemory</span>
  `;
  btn.title = 'Save this response permanently to ChainMemory blockchain';

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const text = response.innerText || response.textContent;
    if (!text || text.length < 10) return;

    let userQuestion = '';
    let prevTurn;
    if (platform.name === 'Claude') {
      prevTurn = response.previousElementSibling;
    } else {
      const wrapper = response.closest('[class*="message"], [class*="turn"], article');
      prevTurn = wrapper?.previousElementSibling;
    }
    if (prevTurn) userQuestion = (prevTurn.innerText || '').substring(0, 100);

    saveMemory(btn, text, userQuestion);
  });

  return btn;
}

async function saveMemory(btn, responseText, userQuestion) {
  const original = btn.innerHTML;
  btn.innerHTML = '<span>Saving...</span>';
  btn.disabled = true;

  try {
    const storage = await chrome.storage.sync.get(['apiKey', 'walletAddress']);
    if (!storage.apiKey) {
      openSetup();
      btn.innerHTML = original;
      btn.disabled = false;
      return;
    }

    const summary = buildSummary(userQuestion, responseText, platform.name);

    let response = await fetch('https://api.chainmemory.ai/v1/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': storage.apiKey },
      body: JSON.stringify({ summary, category: 'INTERACTION', importance: 5 })
    });
    let data = await response.json();

    // Auto-register if needed
    if (data.error && /not registered/i.test(data.error)) {
      btn.innerHTML = '<span>Registering on-chain...</span>';
      const regRes = await fetch('https://api.chainmemory.ai/v1/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': storage.apiKey },
        body: JSON.stringify({ name: 'ChainMemory Browser User', model: 'browser-extension' })
      });
      const regData = await regRes.json();
      if (regData.error) throw new Error('Auto-register failed: ' + regData.error);
      await chrome.storage.sync.set({ aiId: regData.ai_id });

      btn.innerHTML = '<span>Saving...</span>';
      response = await fetch('https://api.chainmemory.ai/v1/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': storage.apiKey },
        body: JSON.stringify({ summary, category: 'INTERACTION', importance: 5 })
      });
      data = await response.json();
    }

    if (data.success || data.memory_id) {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>Saved on-chain</span>
      `;
      btn.classList.add('cm-saved');
      showToast(`Memory #${data.memory_id} saved to ChainMemory forever.`);

      await saveToLocalHistory({
        platform: platform.name,
        question: userQuestion,
        response: responseText,
        memoryId: data.memory_id,
        timestamp: Date.now()
      });

      setTimeout(() => {
        btn.innerHTML = original;
        btn.classList.remove('cm-saved');
        btn.disabled = false;
      }, 3000);
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (err) {
    btn.innerHTML = original;
    btn.disabled = false;
    showToast(`Error: ${err.message}`, 'error');
  }
}

function buildSummary(question, response, platformName) {
  const q = (question || '').trim().substring(0, 80);
  const r = (response || '').trim().substring(0, 160);
  let summary = `[${platformName}] `;
  if (q) summary += `Q: ${q} | `;
  summary += `A: ${r}`;
  return summary.substring(0, 280);
}

async function saveToLocalHistory(item) {
  const storage = await chrome.storage.local.get(['history']);
  const history = storage.history || [];
  history.unshift(item);
  if (history.length > 500) history.pop();
  await chrome.storage.local.set({ history });
}

// ============================================================
// INJECT FLOW (new in v2.1.0)
// ============================================================

// Floating button — anchored bottom-left of viewport
function injectFloatingButton() {
  if (document.getElementById('cm-inject-fab')) return; // idempotent

  const fab = document.createElement('button');
  fab.id = 'cm-inject-fab';
  fab.className = 'cm-inject-fab';
  fab.title = 'Inject your verified memory from ChainMemory';
  fab.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 4V20M4 12H20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    </svg>
    <span>Inject memory</span>
  `;
  fab.addEventListener('click', handleInjectClick);
  document.body.appendChild(fab);
}

async function handleInjectClick() {
  const fab = document.getElementById('cm-inject-fab');
  if (!fab) return;
  const original = fab.innerHTML;

  try {
    const storage = await chrome.storage.sync.get(['apiKey']);
    if (!storage.apiKey) {
      openSetup();
      return;
    }

    // Read injection settings (defaults are sensible if not set)
    const settings = await chrome.storage.sync.get(['injectLimit', 'injectVerifiedOnly']);
    const limit = settings.injectLimit || 10;
    const verifiedOnly = settings.injectVerifiedOnly === true;

    fab.innerHTML = '<span>Loading context...</span>';
    fab.disabled = true;

    const qs = `?limit=${limit}` + (verifiedOnly ? '&verified_only=true' : '');
    const res = await fetch(`https://api.chainmemory.ai/v1/memory/context${qs}`, {
      headers: { 'x-api-key': storage.apiKey }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    fab.innerHTML = original;
    fab.disabled = false;

    if (!data.memories || data.memories.length === 0) {
      showToast('No memories saved yet. Use "Save to ChainMemory" first.', 'warn');
      return;
    }

    // Show preview panel with Inject / Cancel buttons (hybrid UX)
    showPreviewPanel(data);
  } catch (err) {
    fab.innerHTML = original;
    fab.disabled = false;
    showToast(`Error: ${err.message}`, 'error');
  }
}

function showPreviewPanel(data) {
  const existing = document.getElementById('cm-preview-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'cm-preview-panel';
  panel.className = 'cm-preview-panel';

  const verifiedBadge = data.memory_count_verified > 0
    ? `<span class="cm-pp-verified">${data.memory_count_verified} verified on-chain</span>`
    : '';

  const platsTxt = (data.platforms_used || []).join(', ') || '—';
  const memoryLines = data.memories.slice(0, 10).map(m => {
    const mark = m.verified ? '✓' : '·';
    const plat = m.platform ? `[${m.platform}]` : '';
    const summary = (m.summary || '').substring(0, 120);
    return `<div class="cm-pp-mem"><span class="cm-pp-mark">${mark}</span> <span class="cm-pp-plat">${plat}</span> ${escapeHtmlCM(summary)}</div>`;
  }).join('');

  panel.innerHTML = `
    <div class="cm-pp-header">
      <div class="cm-pp-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 4V20M4 12H20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
        Inject ChainMemory context
      </div>
      <button class="cm-pp-close" title="Close">×</button>
    </div>
    <div class="cm-pp-summary">
      ${escapeHtmlCM(data.summary || '')}
      ${verifiedBadge}
    </div>
    <div class="cm-pp-stats">
      <span><strong>${data.memory_count_total}</strong> total</span>
      <span><strong>${data.memory_count_returned}</strong> to inject</span>
      <span>Platforms: ${escapeHtmlCM(platsTxt)}</span>
    </div>
    <div class="cm-pp-list">${memoryLines}</div>
    <div class="cm-pp-actions">
      <button class="cm-pp-cancel">Cancel</button>
      <button class="cm-pp-inject">Inject into prompt</button>
    </div>
    <div class="cm-pp-foot">This text will be prepended to your next message. Review before sending.</div>
  `;

  document.body.appendChild(panel);

  panel.querySelector('.cm-pp-close').addEventListener('click', () => panel.remove());
  panel.querySelector('.cm-pp-cancel').addEventListener('click', () => panel.remove());
  panel.querySelector('.cm-pp-inject').addEventListener('click', () => {
    const text = buildInjectionText(data);
    const ok = injectIntoPrompt(text);
    panel.remove();
    if (ok) {
      showToast('Context injected. Continue typing your question.', 'success');
    } else {
      // Fallback: copy to clipboard if we couldn't find the input
      navigator.clipboard.writeText(text).then(
        () => showToast('Could not auto-inject. Context copied to clipboard — paste it manually.', 'warn'),
        () => showToast('Could not inject or copy. Try refreshing the page.', 'error')
      );
    }
  });
}

function buildInjectionText(data) {
  const lines = [];
  lines.push('--- Context from ChainMemory (my verified AI memory) ---');
  lines.push(data.summary || '');
  lines.push('');
  lines.push('Recent memories:');
  for (const m of (data.memories || [])) {
    const mark = m.verified ? '✓' : '·';
    const plat = m.platform ? `[${m.platform}]` : '';
    const summary = (m.summary || '').replace(/\n+/g, ' ');
    lines.push(`${mark} ${plat} ${summary}`);
  }
  lines.push('');
  if (data.memory_count_verified > 0) {
    lines.push(`(${data.memory_count_verified} of these are cryptographically anchored on the ChainMemory blockchain. ✓ = verified)`);
  }
  lines.push('--- End ChainMemory context ---');
  lines.push('');
  lines.push(''); // empty line so the user starts typing on a new line below
  return lines.join('\n');
}

// Try to insert the text at the start of the platform's prompt input.
// Returns true if injection succeeded, false otherwise.
function injectIntoPrompt(text) {
  const input = platform.findPromptInput && platform.findPromptInput();
  if (!input) return false;

  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      // Native textarea — set value via native setter so React/etc pick it up
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const current = input.value || '';
      const combined = text + current;
      if (setter) setter.call(input, combined);
      else input.value = combined;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
      // Move cursor to end of injected text
      try { input.setSelectionRange(text.length, text.length); } catch (_) {}
      return true;
    } else if (input.isContentEditable) {
      // contenteditable (Claude, ChatGPT newer, Gemini)
      // We insert each line as a separate <p> so the formatting is preserved
      // and the platform's editor sees real text nodes.
      input.focus();
      const lines = text.split('\n');
      const fragment = document.createDocumentFragment();
      for (const line of lines) {
        const p = document.createElement('p');
        p.textContent = line.length === 0 ? '\u00A0' : line;
        fragment.appendChild(p);
      }
      // Prepend at the start of the editor
      input.insertBefore(fragment, input.firstChild);
      // Fire input event so the editor's state updates
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      // Move cursor to end
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }
  } catch (e) {
    console.error('[ChainMemory] inject failed:', e);
    return false;
  }
  return false;
}

function escapeHtmlCM(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ============================================================
// SHARED HELPERS
// ============================================================
function openSetup() {
  chrome.runtime.sendMessage({ action: 'openPopup' });
  showToast('Setup required. Click the ChainMemory extension icon.', 'warn');
}

function showToast(message, type = 'success') {
  const existing = document.getElementById('cm-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'cm-toast';
  toast.className = `cm-toast cm-toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('cm-toast-out');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
