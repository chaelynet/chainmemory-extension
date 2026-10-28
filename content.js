// ═══════════════════════════════════════════════════════════════════
// ChainMemory v3.3.0 — content.js
// Features:
//   1. Save to ChainMemory button on each AI response (from v2.1.0)
//   2. Retrospective scan of old messages (NEW)
//   3. Floating FAB "+ Inject memory"
//   4. Preview panel with selective inject
//   5. Optimistic payment (instant text injection)
//   6. "Top up AIC" button when balance is below the inject fee
//   7. Multi-language selectors (Perplexity contenteditable, etc.)
//   8. COMPACT project state inject: only current decisions/open risks,
//      char budget cap — fixes Perplexity "over the limit" (v3.1.1)
//   9. Project Brain has NO default project — each user sets their own
//      (v3.1.1: prevents leaking the internal 'chainmemory' namespace)
//
// v3.1.3:
//  10. NO character limit on save. The 1.500-char cut was silently
//      truncating 26% of stored memories; now the whole response is saved.
//  11. Cost shown on the button BEFORE saving, and confirmed after.
//  12. Technical ceiling of 20.000 chars, derived from the chain's block
//      gas limit — the extension warns instead of cutting or failing.
//  13. Inject fee corrected to 0.1 AIC (was reporting 0.001, 100x less
//      than what the server actually charged since 2026-06-30).
//  14. Panel opens with its three API calls in parallel, not in series.
//  15. Response scanning is O(n) instead of O(n²) on long chats.
//
// v3.1.4:
//  16. Organization keys (aicm_ / aicp_) are accepted, not just personal
//      aic_ keys — a team member can use the extension with the key their
//      administrator issued.
//  17. A write denied by role reports "your role (viewer) cannot write"
//      instead of a bare HTTP 403.
//  18. The version shown in the UI and in the console is read from the
//      manifest, so it can no longer drift from the published version.
//
// v3.3.0:
//  19. Memories are ALWAYS saved sealed. The plain-text path is gone: with no
//      vault, saving is refused and the popup opens to set it up.
//  20. Each sealed memory carries its search vector, computed on this device
//      (offscreen document) — the server can find it without reading it.
//      If the vector fails, the memory is still saved sealed, never in plain
//      text, and the user is told it will not appear in search.
//  21. Activating or removing the vault takes effect in open chat tabs at
//      once, without reloading them.
//  22. ChatGPT rebuilt its page (Sept. 2026): new selectors for its text box
//      and its answers. If a site renames its text box again, the extension
//      falls back to the lowest visible editable box instead of only copying.
//  23. The saved text no longer includes the "Save to ChainMemory" label.
//  24. After the extension is reloaded, an open tab says "reload this tab"
//      instead of saving a memory without its search vector and then
//      reporting "Save failed" (which led to duplicate, unsearchable saves).
//  25. The Save bar is full width under the answer on every site, aligned
//      with the answer's text (Gemini's answer element has no width of its own).
//
// v3.3.3:
//  26. "Create project state": when the project has no state, the user's own
//      AI organizes the project's memories (read free, decrypted here) into
//      state operations; the extension validates them, the user reviews every
//      line, and only "Save state" writes it. A notice comes first: the state
//      is readable on the server and cannot be deleted.
//  27. Save asks first when the answer seems to contain a secret (API key,
//      private key, recovery words): a memory cannot be deleted.
// ═══════════════════════════════════════════════════════════════════

(function() {
  'use strict';

  const API_BASE = 'https://api.chainmemory.ai';
  const FAUCET_URL = 'https://faucet.chainmemory.ai';

  // ── Costos (v3.1.3) ────────────────────────────────────────────────
  // Fee Schedule v1.0: inject 0.1 AIC, write 0.001 AIC. Hasta v3.1.2 el
  // guardia de saldo usaba 0.001 para inject — 100 veces menos de lo real —
  // asi que el boton "Top up AIC" aparecia tarde y el usuario recibia un 402.
  const INJECT_FEE_AIC = 0.1;
  const MIN_INJECT_BALANCE_WEI = 100000000000000000n; // 0.1 AIC
  const WRITE_FEE_AIC = 0.001;

  // Costo de gas al escribir en cadena, MEDIDO sobre una transaccion real
  // (memoria #536: 3.632 caracteres -> 2.863.818 gas a 1 gwei = 0.00286 AIC).
  // El contenido cifrado se guarda on-chain, asi que el gas escala con el largo.
  const GAS_AIC_PER_1000_CHARS = 0.0008;

  // Techo tecnico, NO comercial: el gas limit del bloque es 30.000.000 y a la
  // tasa medida una sola transaccion lo consumiria entero cerca de los 38.000
  // caracteres. 20.000 deja la escritura por debajo de la mitad de un bloque.
  // No se trunca al superarlo: se avisa. Truncar en silencio fue el problema
  // de las versiones anteriores (el 26% de las memorias quedo cortado).
  const MAX_SAVE_CHARS = 20000;

  function estimateSaveCostAIC(chars) {
    return WRITE_FEE_AIC + (chars / 1000) * GAS_AIC_PER_1000_CHARS;
  }
  function fmtAIC(n) {
    return n < 0.01 ? n.toFixed(4) : n.toFixed(3);
  }

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
      // v3.3.0: ChatGPT (sept. 2026) ya no tiene #prompt-textarea: la caja es un
      // div role=textbox (con sesion) o textarea#mobile-composer-prompt (sin
      // sesion). Los viejos quedan por si vuelven.
      inputSelector: 'div[role="textbox"][contenteditable="true"], textarea#mobile-composer-prompt, #prompt-textarea, textarea[data-id="root"]',
      inputType: 'mixed',
      // v3.3.0: ChatGPT saco data-message-author-role. Cada respuesta es un div
      // data-markdown-text-style="assistant-message" dentro de un contenedor con
      // data-chatgpt-selection-message-id, que es donde va el boton.
      responseSelectors: [
        '[data-chatgpt-selection-message-id]:has(> [data-markdown-text-style="assistant-message"])',
        '[data-message-author-role="assistant"]'
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
    projectBrainProject: ''
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
        _state.projectBrainProject = data.projectBrainProject || '';
        // Boveda ciega: la frase vive en storage.local (NO se sincroniza a Google).
        chrome.storage.local.get(['seedPhrase'], async local => {
          _state.blindClient = null;
          if (local.seedPhrase && typeof CMClient !== 'undefined') {
            try { _state.blindClient = await CMClient.fromMnemonic(local.seedPhrase); }
            catch (e) { console.warn('[ChainMemory] frase de boveda invalida:', e.message); }
          }
          resolve();
        });
      });
    });
  }

  // v3.3.0: si el usuario activa o quita la boveda desde el popup, esta pestana lo
  // toma en el acto. Antes habia que recargar la pagina del chat, y hasta hacerlo
  // la extension seguia guardando como antes.
  chrome.storage.onChanged.addListener(async (cambios, area) => {
    if (area !== 'local' || !cambios.seedPhrase) return;
    const nueva = cambios.seedPhrase.newValue;
    _state.blindClient = null;
    if (nueva && typeof CMClient !== 'undefined') {
      try { _state.blindClient = await CMClient.fromMnemonic(nueva); }
      catch (e) { console.warn('[ChainMemory] frase de boveda invalida:', e.message); }
    }
  });

  // ── API ──
  async function api(method, path, body = null) {
    // x-cm-client: que cliente y en que sitio pidio; lo registra el nivel completo del Brain (3.3.2)
    const opts = { method, headers: { 'Content-Type': 'application/json', 'x-cm-client': 'extension ' + chrome.runtime.getManifest().version + ' ' + location.hostname } };
    if (_state.apiKey) opts.headers['x-api-key'] = _state.apiKey;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(res.status === 403 && data.role ? `your role (${data.role}) cannot write` : (data.error || `HTTP ${res.status}`));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ── Vector de busqueda (v3.3.0) ──
  // Lo calcula el documento offscreen de la extension, en esta maquina: al
  // servidor viaja el vector, nunca el texto. Si no llega a tiempo o falla,
  // devuelve null y la memoria se guarda igual, sellada y sin vector. Nunca se
  // pierde una memoria por esto, y nunca se cae a texto plano.
  const VECTOR_TIMEOUT_MS = 20000;
  async function pedirVector(texto) {
    try {
      const r = await Promise.race([
        chrome.runtime.sendMessage({ action: 'cm-embed', text: texto }),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), VECTOR_TIMEOUT_MS))
      ]);
      if (r && r.ok && Array.isArray(r.vector) && r.vector.length === 384) return r.vector;
      console.warn('[ChainMemory] sin vector de busqueda:', r && r.error);
    } catch (e) {
      // v3.3.0: si la extension se recargo, NO se guarda sin vector: la memoria
      // quedaria imposible de encontrar y el usuario veria un error igual. Se
      // corta aca, antes de escribir nada (paso con las memorias #907 y #908).
      if (ES_CONTEXTO_INVALIDO(e && e.message)) throw e;
      console.warn('[ChainMemory] sin vector de busqueda:', e.message);
    }
    return null;
  }

  // v3.3.0: cuando la extension se actualiza o se recarga, las pestanas abiertas
  // quedan con el script viejo, que ya no puede hablar con la extension y falla
  // con "Extension context invalidated". Se dice que hacer en vez del error crudo.
  // Sin contexto (extension recargada con la pestana abierta) chrome.runtime.id
  // desaparece: se comprueba antes de guardar para no hacer nada a medias.
  function extensionViva() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  const ES_CONTEXTO_INVALIDO = (m) => /extension context invalidated/i.test(String(m || ''));

  function mensajeError(e) {
    const m = (e && e.message) || String(e);
    if (/extension context invalidated/i.test(m)) return 'ChainMemory was updated — reload this tab (F5) to keep using it';
    return m;
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
  const esVisible = (el) => !!(el && el.offsetParent !== null && el.getClientRects().length);

  function findInput() {
    if (!_platform) return null;
    const selectors = _platform.inputSelector.split(',').map(s => s.trim());
    for (const sel of selectors) {
      try {
        // v3.3.0: la primera VISIBLE. Los sitios dejan cajas ocultas (version
        // movil, editores de mensajes viejos) que antes se tomaban por error.
        const todas = Array.from(document.querySelectorAll(sel));
        const el = todas.find(esVisible) || null;
        if (el) return el;
      } catch (e) {}
    }
    // v3.3.0: respaldo. Si el sitio cambio sus nombres (paso con ChatGPT en
    // sept. 2026), se usa la caja de texto editable visible mas abajo en la
    // pantalla, que es donde esta la del chat. Se avisa en la consola para que
    // se note que los selectores del sitio quedaron viejos.
    const candidatas = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea'))
      .filter(esVisible);
    if (!candidatas.length) return null;
    candidatas.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    console.warn('[ChainMemory] los selectores de la caja de texto de ' + _platform.name + ' no coinciden; se usa la caja visible mas baja');
    return candidatas[0];
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
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch (e) { inserted = false; }
      if (!inserted) {
        // Fallback manual: insertar nodo + notificar al framework con UN solo evento.
        // (Con execCommand exitoso el evento 'input' ya se dispara nativamente;
        //  dispararlo de nuevo duplicaba el texto en editores React como Perplexity.)
        const tn = document.createTextNode(text);
        if (el.firstChild) el.insertBefore(tn, el.firstChild);
        else el.appendChild(tn);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 1: SAVE BUTTON ON EACH AI RESPONSE (from v2.1.0)
  // ═══════════════════════════════════════════════════════════════════

  function findAIResponses() {
    if (!_platform) return [];
    // v3.1.3: antes era `responses.includes(el)` sobre un array creciente — O(n²).
    // En un chat largo (200 respuestas) son ~20.000 comparaciones, y el observer
    // lo repite cada 400 ms mientras el modelo escribe. Un Set lo hace O(n).
    const seen = new Set();
    for (const sel of _platform.responseSelectors) {
      try {
        document.querySelectorAll(sel).forEach(el => seen.add(el));
      } catch (e) {}
    }
    return Array.from(seen);
  }

  function extractResponseText(el) {
    if (!el) return '';
    // v3.3.0: el boton "Save to ChainMemory" vive dentro de la respuesta y su
    // etiqueta se colaba en el texto guardado. Se oculta un instante para que
    // innerText no la cuente (innerText respeta display:none).
    // Con 'important': content.css declara display:flex !important, que le gana
    // a un display:none comun (asi fallo la primera version de esto).
    const botones = Array.from(el.querySelectorAll('.cm-save-btn'));
    botones.forEach(b => b.style.setProperty('display', 'none', 'important'));
    try {
      return (el.innerText || el.textContent || '').trim();
    } finally {
      botones.forEach(b => b.style.removeProperty('display'));
    }
  }

  // v3.3.0: la barra se alinea con el TEXTO de la respuesta. En la mayoria de los
  // sitios ya coincide y no se toca nada. En Gemini la respuesta es un elemento
  // sin ancho propio (message-content, ancho 0) y la barra tomaba el de un
  // contenedor mucho mas ancho que la columna de texto. Se mide donde esta el
  // texto (sin contar la barra) y se ajustan margen y ancho.
  // La COLUMNA del contenido: la caja interna (sin padding ni borde) de los
  // bloques que contienen el texto (parrafos, titulos, items), mas tablas,
  // codigo e imagenes. No se usan las lineas de texto (una respuesta corta daria
  // una barra corta) ni la caja de la respuesta entera (en Gemini ocupa todo el
  // contenedor aunque el texto sea una columna angosta).
  function medirContenido(responseEl) {
    let izq = Infinity, der = -Infinity, n = 0;
    const sumar = (l, r) => { if (r > l) { izq = Math.min(izq, l); der = Math.max(der, r); } };
    const bloques = new Set();
    const recorrido = document.createTreeWalker(responseEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (t.nodeValue.trim() && !(t.parentElement && t.parentElement.closest('.cm-save-btn')))
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    for (let t = recorrido.nextNode(); t && n < 3000; t = recorrido.nextNode(), n++) {
      let e = t.parentElement;
      while (e && e !== responseEl && /^inline/.test(getComputedStyle(e).display)) e = e.parentElement;
      if (e && e !== responseEl) bloques.add(e);
    }
    for (const e of bloques) {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      if (!r.width || !r.height) continue;
      sumar(r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
            r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth));
    }
    responseEl.querySelectorAll('pre, table, img, video, canvas').forEach(e => {
      if (e.closest('.cm-save-btn')) return;
      const r = e.getBoundingClientRect();
      if (r.width && r.height) sumar(r.left, r.right);
    });
    return izq < der ? { left: izq, width: der - izq } : null;
  }

  function alinearBarra(btn, responseEl) {
    if (!btn || !responseEl || !btn.isConnected) return;
    const texto = medirContenido(responseEl);
    if (!texto || !texto.width) return;
    // Sin animacion mientras se mide: con una transicion activa, el navegador
    // devuelve la posicion a mitad de camino y no la final.
    btn.style.setProperty('transition', 'none', 'important');
    btn.style.removeProperty('margin-left');
    btn.style.removeProperty('width');
    const actual = btn.getBoundingClientRect();
    if (Math.abs(actual.left - texto.left) > 12 || Math.abs(actual.width - texto.width) > 24) {
      btn.style.setProperty('margin-left', Math.round(texto.left - actual.left + 4) + 'px', 'important');
      btn.style.setProperty('width', Math.round(texto.width - 8) + 'px', 'important');
    }
    btn.getBoundingClientRect();                // aplica el ajuste antes de devolver la animacion
    btn.style.removeProperty('transition');
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
    // v3.1.3: el costo se muestra ANTES de guardar. La respuesta sigue creciendo
    // mientras el modelo escribe, asi que se recalcula al pasar el mouse — que es
    // el momento inmediatamente anterior al clic.
    btn.addEventListener('mouseenter', () => refreshSaveBtnCost(btn, responseEl));
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleSaveClick(btn, responseEl);
    });
    responseEl.appendChild(btn);
    alinearBarra(btn, responseEl);
  }

  // Muestra largo y costo estimado en el propio boton, sin bloquear ni pedir
  // confirmacion extra: informar no deberia costar un clic mas.
  function refreshSaveBtnCost(btn, responseEl) {
    if (!btn || btn.disabled || btn.classList.contains('cm-saved')) return;
    const chars = extractResponseText(responseEl).length;
    if (!chars) return;
    const label = btn.querySelector('span');
    if (!label) return;
    if (chars > MAX_SAVE_CHARS) {
      label.textContent = `Too long: ${chars.toLocaleString()} chars`;
      btn.title = `This response is ${chars.toLocaleString()} characters. A single on-chain transaction holds about ${MAX_SAVE_CHARS.toLocaleString()}. Save a shorter selection, or split it.`;
      // Estilo inline a proposito: no se toca content.css en esta version, asi el
      // diff queda acotado a la logica. Si el estado se queda, va a una clase.
      btn.style.opacity = '0.55';
      return;
    }
    btn.style.opacity = '';
    label.textContent = `Save · ${fmtAIC(estimateSaveCostAIC(chars))} AIC`;
    btn.title = `Save ${chars.toLocaleString()} characters to ChainMemory. Estimated cost ${fmtAIC(estimateSaveCostAIC(chars))} AIC: ${WRITE_FEE_AIC} protocol fee plus on-chain storage, which grows with length.`;
  }

  async function handleSaveClick(btn, responseEl) {
    if (!extensionViva()) {
      toast(mensajeError(new Error('Extension context invalidated')), 'warn');
      return;
    }
    if (!_state.apiKey) {
      toast('Connect ChainMemory first', 'warn');
      chrome.runtime.sendMessage({ action: 'openPopup' });
      return;
    }
    // v3.3.0: sin boveda no se guarda. Antes se guardaba en texto plano, que el
    // servidor puede leer; ese camino ya no existe en la extension.
    if (!_state.blindClient) {
      toast('Activate your vault (12 words) to save memories — they are encrypted before leaving this browser.', 'warn');
      chrome.runtime.sendMessage({ action: 'openPopup' });
      return;
    }
    const text = extractResponseText(responseEl);
    if (!text || text.length < 10) {
      toast('Response too short', 'warn');
      return;
    }
    // v3.1.3: el unico limite es el que impone la cadena. Se avisa, no se corta.
    if (text.length > MAX_SAVE_CHARS) {
      toast(`Too long to store in one transaction: ${text.length.toLocaleString()} characters (limit ~${MAX_SAVE_CHARS.toLocaleString()}). Save a shorter selection instead of losing the rest.`, 'warn');
      return;
    }
    // v3.3.3: una memoria no se borra; si parece tener un secreto, se pregunta antes
    const secretos = buscarSecretos(text);
    if (secretos.length && !(await confirmarSecretos(secretos))) {
      toast('Not saved', 'warn');
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

      // v3.1.3: se elimina el corte a 1.500 caracteres. Truncaba el 26% de las
      // memorias en silencio: el usuario veia "Saved" y perdia el resto sin
      // enterarse. El costo real de guardar completo son centavos de AIC y se
      // muestra en el boton antes del clic.
      const summary = `[${_platform.name}] ${text}`;
      // v3.3.0: solo se guarda sellado. Si la boveda se quito mientras tanto, se
      // corta aca: no hay camino de vuelta al texto plano.
      const boveda = _state.blindClient;
      if (!boveda) throw new Error('vault is not active');
      const sealed = await boveda.seal(summary);
      const cuerpo = {
        blob_b64: sealed.blob_b64,
        event_hash: sealed.event_hash,
        plain_len: sealed.plain_len,
        category: 'INTERACTION',
        importance: 5,
        platform: _platform.key
      };
      // Con el vector, la memoria sellada se puede encontrar desde la busqueda
      // (MCP, API) sin que el servidor lea el texto.
      const vector = await pedirVector(summary);
      if (vector) cuerpo.embedding = vector;
      const result = await api('POST', '/v1/memory/sealed', cuerpo);

      // Save to local history for quick stats. v3.3.0: la memoria YA esta
      // guardada; si esto falla no se puede mostrar "Save failed", porque el
      // usuario la guardaria de nuevo y quedaria duplicada.
      try {
        const local = await chromeGetLocal(['history']);
        const history = local.history || [];
        history.unshift({
          timestamp: Date.now(),
          platform: _platform.key,
          memoryId: result.memory_id,
          response: text.substring(0, 200)
        });
        await chromeSetLocal({ history: history.slice(0, 200) });
      } catch (e) {
        console.warn('[ChainMemory] memoria guardada, pero no se pudo anotar en el historial local:', e.message);
      }

      btn.classList.add('cm-saved');
      btn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Saved #${result.memory_number ?? result.memory_id}</span>
      `;
      // Si se guardo sellada sin vector, el usuario tiene que saber que no la va a
      // encontrar buscando: no es un error, pero tampoco es lo mismo.
      // Sin vector la memoria no aparece en la busqueda, y no hay nada que se lo agregue
      // despues: se dice asi, sin un "todavia" que prometa algo que no pasa.
      const sinBusqueda = result.scheme === 'sealed' && result.searchable === false ? ' · encrypted, but it will not appear in search' : '';
      toast(`✓ Saved #${result.memory_number ?? result.memory_id} · ${text.length.toLocaleString()} characters · ~${fmtAIC(estimateSaveCostAIC(text.length))} AIC${sinBusqueda}`, 'success');
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = orig;
      toast('Save failed: ' + mensajeError(e), 'error');
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
    // v3.1.3: mismo aviso de costo que en el boton por-respuesta.
    btn.addEventListener('mouseenter', () => refreshSaveBtnCost(btn, _saveBtnResponse));
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

    // Ya colocado en la ultima respuesta actual -> solo realinear (la respuesta
    // puede cambiar de ancho mientras el modelo escribe)
    if (_saveBtnResponse === last && last.contains(_saveBtn)) { alinearBarra(_saveBtn, last); return; }

    // Cambio el target (nueva respuesta o nodo re-renderizado) -> mover + refrescar
    _saveBtnResponse = last;
    resetSaveButton();
    last.appendChild(_saveBtn);
    alinearBarra(_saveBtn, last);
  }

  // Dispatcher: plataformas "ancho/re-render" -> uno-al-final; el resto -> por-respuesta.
  function runScan() {
    if (!_platform) return;
    if (_platform.singleButtonAtEnd) ensureSingleSaveButton();
    else scanExistingResponses();
  }

  // Al cambiar el tamano de la ventana cambia la columna de texto: se realinean.
  let _alinearTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_alinearTimer);
    _alinearTimer = setTimeout(() => {
      if (_platform && _platform.singleButtonAtEnd) alinearBarra(_saveBtn, _saveBtnResponse);
      else document.querySelectorAll('.cm-save-btn').forEach(b => alinearBarra(b, b.parentElement));
    }, 200);
  });

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
        <select class="cm-pp-brain-task" title="What to inject from the project brain">
          <option value="">Overview: what changed, risks, priorities</option>
        </select>
        <button class="cm-pp-brain-btn" title="Inject the consolidated project state into this chat">⚡ Inject project state</button>
        <label class="cm-pp-check cm-pp-full-wrap" hidden title="Adds addresses, ports, server paths and security rules. You approve every line before it goes out.">
          <input type="checkbox" class="cm-pp-full"> Include sensitive data
        </label>
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
    panel.querySelector('.cm-pp-brain-btn').addEventListener('click', e => {
      const b = e.currentTarget;
      if (b.dataset.modo === 'crear') crearEstado(b); else handleInjectProjectState(b);
    });
    prepararBrainPanel(panel);
    panel.querySelector('.cm-pp-filter-project').addEventListener('change', e => {
      _state.filterProject = e.target.value;
      loadMemoriesIntoPanel();
    });
    panel.querySelector('.cm-pp-archived-toggle').addEventListener('change', loadMemoriesIntoPanel);
    panel.querySelector('.cm-pp-select-all').addEventListener('change', e => selectAllToggle(e.target.checked));

    // v3.1.3: las tres llamadas son independientes entre si y estaban en serie,
    // asi que el usuario esperaba la SUMA en vez de la mas lenta. Con el fix del
    // servidor (memories/list bajo de 3.53s a 0.21s) la apertura pasa de ~3.7s a
    // ~0.2s en vez de ~0.4s. allSettled: si una falla, las otras igual pintan.
    await Promise.allSettled([
      loadProjectsIntoFilter(panel),
      loadBalanceIntoPanel(panel),
      loadMemoriesIntoPanel()
    ]);
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
      if (_state.balance < MIN_INJECT_BALANCE_WEI) {
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
      // Boveda ciega: descifrar en el cliente las memorias selladas para mostrarlas
      // y para poder inyectarlas despues. El servidor nunca ve el texto.
      if (_state.blindClient) {
        for (const m of _state.memories) {
          if (m.scheme === 'sealed' && m.content_blob) {
            try { m.summary = await _state.blindClient.open(m.content_blob); }
            catch (e) { m.summary = '[sellada — la frase no corresponde]'; }
          }
        }
      }
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
      list.innerHTML = `<div class="cm-pp-empty">Failed: ${escapeHtml(mensajeError(e))}</div>`;
    }
  }

  function renderMemRow(mem) {
    const div = document.createElement('div');
    div.className = 'cm-pp-mem-row';
    div.dataset.id = mem.memory_number;
    const text = mem.summary || mem.summary_preview || '(empty)';
    const dt = new Date(mem.timestamp * 1000);
    const dateStr = dt.toLocaleDateString();
    const tagsHTML = (mem.tags || []).map(t => `<span class="cm-pp-tag">${escapeHtml(t)}</span>`).join('');

    div.innerHTML = `
      <input type="checkbox" class="cm-pp-mem-check">
      <div class="cm-pp-mem-body">
        <div class="cm-pp-mem-meta">
          <span class="cm-pp-mem-id">#${mem.memory_number}</span>
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
    cb.addEventListener('click', e => { e.stopPropagation(); toggleSelect(mem.memory_number); });
    div.addEventListener('click', e => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      toggleSelect(mem.memory_number);
    });
    div.querySelector('.cm-pp-archive-btn').addEventListener('click', async e => {
      e.stopPropagation();
      await toggleArchive(mem.memory_number, !!mem.archived);
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
    if (check) _state.memories.forEach(m => _state.selectedIds.add(m.memory_number));
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
      toast('Archive failed: ' + mensajeError(e), 'error');
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
      if (_state.selectedIds.has(m.memory_number)) totalTokens += m.estimated_tokens || 0;
    });
    info.textContent = count === 0 ? '0 selected' : `${count} selected · ~${totalTokens} tokens`;

    // Logic: balance < 0.001 → "Top up AIC" button
    if (_state.balance < MIN_INJECT_BALANCE_WEI) {
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
    if (_state.balance < MIN_INJECT_BALANCE_WEI) {
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

      // Boveda ciega: descifrar en el cliente las memorias selladas que devolvio
      // el servidor (viene el blob, no el texto), antes de armar la inyeccion.
      if (_state.blindClient && result.memories) {
        for (const m of result.memories) {
          if (m.content_blob) {
            try { m.summary = await _state.blindClient.open(m.content_blob); }
            catch (e) { m.summary = '[sellada — la frase no corresponde]'; }
          }
        }
      }
      const text = buildInjectText(result.memories);

      // Inject immediately
      const ok = injectIntoInput(text);
      if (ok) {
        // v3.1.3: decia 0.001 AIC y el cobro real es 0.1 desde el 2026-06-30.
        // Se informaba al usuario cien veces menos de lo que se le cobraba.
        const charged = (result.payment && result.payment.charged_aic) || INJECT_FEE_AIC;
        toast(`✅ Injected ${result.injected} memories · ${charged} AIC`, 'success');
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
        toast('Inject failed: ' + mensajeError(e), 'error');
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

  // ── Project Brain: format + inject consolidated state (COMPACT, v3.1.1) ──
  // Regla de diseno: el inject manual de la extension responde
  // "donde esta el proyecto HOY y hacia donde va", nunca "como llegamos aca".
  // La historia completa (superseded, riesgos cerrados, milestones, metrics)
  // sigue integra en el Brain y viaja por el camino MCP/API automatico.
  const MAX_INJECT_CHARS = 7000;  // tope duro: entra en Perplexity free con margen
  const MAX_VOCAB_TERMS = 8;      // vocabulario esencial
  const MAX_VOCAB_DEF_CHARS = 90; // definiciones truncadas

  function formatProjectState(s, name) {
    const st = s.state || s;   // los campos del estado viven en s.state; fallback defensivo
    const lines = ['[ChainMemory · Project State: ' + (s.project || name) + (s.version != null ? ' v' + s.version : '') + ']', ''];
    // --- meta-info block (anchor / updated) ---
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
    if (lines.length > 2) lines.push('');   // separador meta -> cuerpo, solo si hubo meta
    // --- cuerpo del estado: solo lo VIGENTE ---
    if (st.vision && st.vision.statement) lines.push('Vision: ' + st.vision.statement, '');
    if (st.phase) lines.push('Phase: ' + st.phase);
    if (st.current_focus) lines.push('Current focus: ' + st.current_focus);
    // Vocabulario esencial: max terminos, definiciones cortas
    if (st.vocabulary && Object.keys(st.vocabulary).length) {
      const keys = Object.keys(st.vocabulary);
      lines.push('', 'Vocabulary (key terms):');
      keys.slice(0, MAX_VOCAB_TERMS).forEach(k => {
        let def = String(st.vocabulary[k]);
        if (def.length > MAX_VOCAB_DEF_CHARS) def = def.slice(0, MAX_VOCAB_DEF_CHARS - 1) + '…';
        lines.push('- ' + k + ': ' + def);
      });
      if (keys.length > MAX_VOCAB_TERMS) lines.push('  (+' + (keys.length - MAX_VOCAB_TERMS) + ' more terms in Brain)');
    }
    if (Array.isArray(st.constraints) && st.constraints.length) {
      lines.push('', 'Constraints:');
      st.constraints.forEach(c => lines.push('- ' + (typeof c === 'object' ? (c.statement || JSON.stringify(c)) : c)));
    }
    // Decisiones: solo vigentes (sin superseded), titulo solo — sin statement largo ni evidence IDs
    if (Array.isArray(st.decisions) && st.decisions.length) {
      const current = st.decisions.filter(d => d && d.status !== 'superseded');
      const omitted = st.decisions.length - current.length;
      if (current.length) {
        lines.push('', 'Decisions (current):');
        current.forEach(d => {
          lines.push('- [' + (d.status || '?') + '] ' + (d.title || ''));
        });
        if (omitted > 0) lines.push('  (+' + omitted + ' superseded omitted — full history in Brain/MCP)');
      }
    }
    // Riesgos: solo abiertos. Schema v2 usa 'risks'; fallback a 'open_risks' (schema v1)
    const risksArr = Array.isArray(st.risks) ? st.risks : (Array.isArray(st.open_risks) ? st.open_risks : []);
    if (risksArr.length) {
      const open = risksArr.filter(r => r && r.status !== 'closed' && r.status !== 'resolved' && r.status !== 'mitigated');
      if (open.length) {
        lines.push('', 'Open risks:');
        open.forEach(r => {
          lines.push('- [' + (r.severity || '?') + '] ' + (r.title || ''));
        });
      }
    }
    // Prioridades: solo activas, ordenadas por score desc. Schema v2 usa 'priorities'; fallback a 'next_priorities'
    const priosArr = Array.isArray(st.priorities) ? st.priorities : (Array.isArray(st.next_priorities) ? st.next_priorities : []);
    if (priosArr.length) {
      const prioScore = p => (p && (p.priority_score != null ? p.priority_score : p.score)) || 0;
      const active = priosArr
        .filter(p => !p || typeof p !== 'object' ? true : (p.status !== 'done' && p.status !== 'cancelled'))
        .sort((a, b) => prioScore(b) - prioScore(a));
      if (active.length) {
        lines.push('', 'Next priorities (by score):');
        active.forEach(p => {
          if (p && typeof p === 'object') {
            const sc = p.priority_score != null ? p.priority_score : (p.score != null ? p.score : '?');
            lines.push('- [' + sc + '] ' + (p.title || p.statement || ''));
          } else {
            lines.push('- ' + p);
          }
        });
      }
    }
    // Hash abreviado: identifica la version anclada sin gastar 66 chars
    if (s.state_hash) lines.push('', '(state_hash: ' + s.state_hash.slice(0, 10) + '…' + s.state_hash.slice(-8) + ')');
    lines.push('', '---', '');
    let out = lines.join('\n');
    // Tope de seguridad: nunca mas fallar por limite del sitio destino
    if (out.length > MAX_INJECT_CHARS) {
      out = out.slice(0, MAX_INJECT_CHARS - 30) + '\n…[context trimmed]\n---\n';
    }
    return out;
  }

  // v3.3.1: el texto lo arma el servidor (GET /v1/project/:name/inject), por relevancia
  // y con presupuesto: riesgos, prioridades y decisiones recientes antes que el resto,
  // y arriba "que cambio" desde la ultima version que este navegador inyecto de ese
  // proyecto (se recuerda por proyecto en storage.local). Si el servidor no tiene la
  // ruta o falla, el texto se arma aca como antes (formatProjectState): nunca queda
  // sin inject. Un 401 o "project state not found" se tratan igual que antes.
  // v3.3.2: opciones.task (una prioridad, pri_NNNN) pide lo necesario para trabajar en
  // ella; opciones.completo pide el nivel completo (direcciones, puertos, rutas), que el
  // servidor solo da a la clave del dueno y registra. En esos dos casos no hay plan B en
  // el navegador: si el servidor no los sirve, se dice, no se inyecta otra cosa.
  async function textoProjectState(projectName, opciones = {}) {
    const clave = 'injectSince:' + projectName;
    const guardada = (await chromeGetLocal([clave]))[clave];
    const lang = String(navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
    const ruta = '/v1/project/' + encodeURIComponent(projectName) + '/inject?budget=' + MAX_INJECT_CHARS + '&lang=' + lang;
    if (opciones.task || opciones.completo) {
      const r = await api('GET', ruta + (opciones.task ? '&task=' + encodeURIComponent(opciones.task) : '') + (opciones.completo ? '&level=full' : ''));
      if (opciones.task && r.task !== opciones.task) throw new Error('this server does not serve task briefs yet');
      if (opciones.completo && r.level !== 'full') throw new Error('this server does not serve the full level yet');
      // la tarea no es una lectura del estado completo: no mueve la version recordada
      return { text: r.text, version: r.version, clave: opciones.task ? null : clave, sensibles: Array.isArray(r.sensitive_lines) ? r.sensitive_lines : [] };
    }
    const pedir = (since) => api('GET', ruta + (since ? '&since=' + since : ''));
    try {
      let r;
      try {
        r = await pedir(Number.isInteger(guardada) && guardada > 0 ? guardada : null);
      } catch (e) {
        // since invalido (por ejemplo, el Brain se reinicio y tiene menos versiones): sin since
        if (e.status === 400 && guardada) r = await pedir(null); else throw e;
      }
      if (r && typeof r.text === 'string' && r.text) return { text: r.text, version: r.version, clave, sensibles: [] };
    } catch (e) {
      if (e.status === 401 || (e.status === 404 && e.data && e.data.error === 'project state not found')) throw e;
      console.warn('[ChainMemory] inject del servidor no disponible, se arma en el navegador:', e.message);
    }
    const data = await api('GET', '/v1/project/' + encodeURIComponent(projectName) + '/state');
    return { text: formatProjectState(data, projectName), version: data.version, clave, sensibles: [] };
  }

  // ── v3.3.2: selector de tarea y casilla de datos sensibles ──
  // La casilla solo aparece con una clave personal (aic_): el servidor rechaza el nivel
  // completo a las claves de miembro y de proyecto. Se arma apagada cada vez que se abre
  // el panel; no se recuerda.
  async function prepararBrainPanel(panel) {
    const casilla = panel.querySelector('.cm-pp-full-wrap');
    if (casilla && String(_state.apiKey || '').startsWith('aic_')) casilla.hidden = false;
    const sel = panel.querySelector('.cm-pp-brain-task');
    const projectName = _state.projectBrainProject || '';
    // v3.3.3: sin proyecto en Settings, o con un proyecto sin estado, el boton crea el estado
    const modoCrear = () => {
      const btn = panel.querySelector('.cm-pp-brain-btn');
      if (!btn) return;
      btn.dataset.modo = 'crear';
      btn.textContent = '✨ Create project state';
      btn.title = 'Your AI organizes the memories of this project into a project state. You review it before saving.';
      if (sel) sel.hidden = true;
      if (casilla) casilla.hidden = true;
    };
    if (!sel) return;
    if (!projectName) { modoCrear(); return; }
    try {
      const data = await api('GET', '/v1/project/' + encodeURIComponent(projectName) + '/state');
      const prios = ((data.state || {}).priorities || []).filter(p => (p.status || 'active') === 'active')
        .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));
      for (const p of prios) {
        const o = document.createElement('option');
        o.value = p.id;
        const t = String(p.title || '').replace(/\s+/g, ' ');
        o.textContent = 'Task ' + p.id + ' [' + (p.priority_score ?? '?') + ']: ' + (t.length > 60 ? t.slice(0, 59) + '…' : t);
        sel.appendChild(o);
      }
    } catch (e) {
      if (e.status === 404 && e.data && e.data.error === 'project state not found') modoCrear();
      /* sin red: queda solo la vista general */
    }
  }

  // ── v3.3.2: PIN opcional para aprobar datos sensibles ──
  // Se guarda en Settings como hash PBKDF2 con sal, solo en este navegador
  // (storage.local, no se sincroniza) y nunca se envia. Cinco intentos fallidos
  // bloquean la aprobacion cinco minutos. Frena a quien use este navegador; no a quien
  // controle la PC.
  const PIN_INTENTOS = 5, PIN_BLOQUEO_MS = 5 * 60 * 1000;
  async function hashPin(pin, saltB64, iter) {
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, 256);
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  }
  // { ok } | { ok:false, bloqueadoHasta } | { ok:false, quedan }
  async function verificarPin(pin) {
    const { fullPin, fullPinFails } = await chromeGetLocal(['fullPin', 'fullPinFails']);
    if (!fullPin) return { ok: true };
    const f = fullPinFails || { n: 0, hasta: 0 };
    if (f.hasta && Date.now() < f.hasta) return { ok: false, bloqueadoHasta: f.hasta };
    if (pin && await hashPin(pin, fullPin.salt, fullPin.iter) === fullPin.hash) {
      await chromeSetLocal({ fullPinFails: { n: 0, hasta: 0 } });
      return { ok: true };
    }
    const n = (f.hasta && Date.now() >= f.hasta ? 0 : f.n) + 1;
    if (n >= PIN_INTENTOS) {
      const hasta = Date.now() + PIN_BLOQUEO_MS;
      await chromeSetLocal({ fullPinFails: { n: 0, hasta } });
      return { ok: false, bloqueadoHasta: hasta };
    }
    await chromeSetLocal({ fullPinFails: { n, hasta: 0 } });
    return { ok: false, quedan: PIN_INTENTOS - n };
  }

  // ── v3.3.2: aprobacion antes de mandar datos sensibles ──
  // Muestra exactamente las lineas que el nivel publico reserva y el sitio que las va a
  // recibir. Resuelve true solo con "Approve this time" (y el PIN, si hay).
  async function pedirAprobacion(lineas, sitio) {
    const { fullPin } = await chromeGetLocal(['fullPin']);
    return new Promise(resolve => {
      const fondo = document.createElement('div');
      fondo.className = 'cm-approve-backdrop';
      fondo.innerHTML = `
        <div class="cm-approve" role="dialog" aria-modal="true" aria-labelledby="cm-approve-title">
          <h3 id="cm-approve-title">Send sensitive data to <b>${escapeHtml(sitio)}</b>?</h3>
          <p>These ${lineas.length} lines are withheld at the public level: addresses, ports, server paths and security rules. Once pasted, ${escapeHtml(sitio)} keeps them. ChainMemory logged this request.</p>
          <pre class="cm-approve-lines">${lineas.map(escapeHtml).join('\n')}</pre>
          ${fullPin ? '<label class="cm-approve-pin-label">PIN <input type="password" class="cm-approve-pin" autocomplete="off"></label>' : ''}
          <div class="cm-approve-error" role="alert"></div>
          <div class="cm-approve-buttons">
            <button class="cm-approve-cancel">Cancel</button>
            <button class="cm-approve-ok">Approve this time</button>
          </div>
        </div>`;
      document.body.appendChild(fondo);
      const terminar = (v) => { document.removeEventListener('keydown', alTeclado, true); fondo.remove(); resolve(v); };
      const alTeclado = (e) => { if (e.key === 'Escape') { e.stopPropagation(); terminar(false); } };
      document.addEventListener('keydown', alTeclado, true);
      fondo.querySelector('.cm-approve-cancel').addEventListener('click', () => terminar(false));
      const error = fondo.querySelector('.cm-approve-error');
      const okBtn = fondo.querySelector('.cm-approve-ok');
      okBtn.addEventListener('click', async () => {
        if (!fullPin) return terminar(true);
        okBtn.disabled = true;
        const pinIn = fondo.querySelector('.cm-approve-pin');
        const r = await verificarPin(pinIn.value);
        pinIn.value = '';
        if (r.ok) return terminar(true);
        okBtn.disabled = false;
        error.textContent = r.bloqueadoHasta
          ? 'Too many wrong PINs. Approval is locked until ' + new Date(r.bloqueadoHasta).toLocaleTimeString() + '.'
          : 'Wrong PIN. ' + r.quedan + ' attempt' + (r.quedan === 1 ? '' : 's') + ' left.';
      });
      (fondo.querySelector('.cm-approve-pin') || fondo.querySelector('.cm-approve-cancel')).focus();
    });
  }

  async function handleInjectProjectState(btn) {
    const projectName = _state.projectBrainProject || '';
    if (!projectName) {
      toast('Set your project first (extension icon → Settings → Project Brain)', 'warn');
      chrome.runtime.sendMessage({ action: 'openPopup' });
      return;
    }
    const panel = btn.closest('.cm-preview-panel');
    const task = (panel && panel.querySelector('.cm-pp-brain-task') && panel.querySelector('.cm-pp-brain-task').value) || '';
    const casilla = panel && panel.querySelector('.cm-pp-full');
    const completo = !!(casilla && casilla.checked && !casilla.closest('.cm-pp-full-wrap').hidden);
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const { text, version, clave, sensibles } = await textoProjectState(projectName, { task, completo });
      // datos sensibles: nada sale sin que el dueno vea las lineas y apruebe esta vez
      if (completo && sensibles.length) {
        const aprobado = await pedirAprobacion(sensibles, location.hostname);
        if (casilla) casilla.checked = false;
        if (!aprobado) { toast('Nothing was injected', 'warn'); return; }
      }
      const okInj = injectIntoInput(text);
      if (okInj) {
        toast('✓ Project state "' + projectName + '" injected (' + text.length + ' chars)', 'success');
        closePanel();
      } else {
        await navigator.clipboard.writeText(text);
        toast('Project state copied to clipboard', 'success');
      }
      // recien con el texto entregado se recuerda la version: la proxima vez, "que cambio desde aca"
      if (clave && Number.isInteger(version)) await chromeSetLocal({ [clave]: version });
    } catch (e) {
      if (completo && e.status === 403) toast('Sensitive data needs the owner key: nothing was injected', 'warn');
      else if (completo && e.status === 503) toast('Sensitive data is unavailable right now: nothing was injected', 'warn');
      else if (task && e.status === 404 && e.data && /priority/.test(e.data.error || '')) toast('Task ' + task + ' no longer exists in "' + projectName + '"', 'warn');
      else if (e.status === 404) toast('No project state for "' + projectName + '" yet', 'warn');
      else if (e.status === 401) toast('Connect ChainMemory first', 'warn');
      else toast('Failed to load project state: ' + mensajeError(e), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PART 3 (v3.3.3): CREATE THE PROJECT STATE WITH THE USER'S OWN AI
  // ═══════════════════════════════════════════════════════════════════
  // La extension no tiene IA propia, pero el usuario tiene una abierta. Se le pasan las
  // memorias del proyecto (descifradas aca, desde la lista, que no cobra) con una
  // consigna; se lee el JSON de su respuesta, se valida y se muestra para revisar.
  // Nada se guarda sin "Save state". El estado queda legible en el servidor y no se
  // borra: se avisa antes de empezar (decision de Silvio, 27/10/2026).

  const STATE_FEE_AIC = 0.05, STATE_FEE_PER_OP_AIC = 0.005;
  const MAX_STATE_ITEMS = 40;
  const MAX_MEM_CHARS_IN_PROMPT = 1800;   // cada memoria, dentro del tope MAX_INJECT_CHARS
  const MIN_MEM_CHARS_IN_PROMPT = 400;    // por debajo de esto se dejan afuera las mas viejas
  const ESPERA_RESPUESTA_MS = 15 * 60 * 1000;

  // Los nueve tipos de la primera version, con los campos de la gramatica del servidor.
  // set_vision no lleva evidencia en la gramatica: se le quita.
  const STATE_OPS = {
    set_vision:        { req: ['statement'], opt: [], evid: false, label: 'Vision', text: o => o.statement },
    set_phase:         { req: ['value'], opt: [], evid: true, label: 'Phase', text: o => o.value },
    set_focus:         { req: ['value'], opt: [], evid: true, label: 'Focus', text: o => o.value },
    add_decision:      { req: ['title', 'statement'], opt: [], evid: true, label: 'Decision', text: o => o.title + ' — ' + o.statement },
    add_milestone:     { req: ['title'], opt: ['status'], evid: true, label: 'Milestone', text: o => (o.status ? '(' + o.status + ') ' : '') + o.title },
    add_risk:          { req: ['title'], opt: ['severity'], evid: true, label: 'Risk', text: o => (o.severity ? '(' + o.severity + ') ' : '') + o.title },
    add_priority:      { req: ['title'], opt: ['priority_score'], evid: true, label: 'Priority', text: o => (o.priority_score != null ? '(' + o.priority_score + ') ' : '') + o.title },
    add_open_question: { req: ['question'], opt: [], evid: true, label: 'Question', text: o => o.question },
    add_constraint:    { req: ['statement'], opt: [], evid: true, label: 'Rule', text: o => o.statement },
  };
  const UNICOS = new Set(['set_vision', 'set_phase', 'set_focus']);
  // Valores cerrados del servidor. Solo se corrige lo obvio; el resto se descarta.
  const CERRADOS = {
    severity: { low: 'low', med: 'med', high: 'high', medium: 'med', bajo: 'low', baja: 'low', medio: 'med', media: 'med', alto: 'high', alta: 'high' },
    status: { planned: 'planned', in_progress: 'in_progress', 'in progress': 'in_progress', done: 'done' },
  };

  // ── Secretos (tambien para el boton Save) ──
  // Patrones de alta confianza: claves de ChainMemory, bloques PEM, una clave privada en
  // hex sin 0x (los hashes de transaccion llevan 0x y no cuentan) y una frase de
  // recuperacion: 12 o mas palabras BIP39 seguidas, que en un texto normal no pasa.
  let _wordset = null;
  function buscarSecretos(texto) {
    const s = String(texto || '');
    const hallados = [];
    if (/\b(aic|aicm|aicp)_[A-Za-z0-9]{20,}/.test(s)) hallados.push('a ChainMemory API key');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) hallados.push('a private key block');
    if (/(^|[^0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(s)) hallados.push('what looks like a private key (64 hex characters)');
    if (!_wordset && typeof CM_WORDLIST !== 'undefined') _wordset = new Set(CM_WORDLIST);
    if (_wordset) {
      let racha = 0;
      for (const w of s.toLowerCase().split(/[^a-z]+/)) {
        if (!w) continue;
        racha = _wordset.has(w) ? racha + 1 : 0;
        if (racha >= 12) { hallados.push('what looks like recovery words (12 words)'); break; }
      }
    }
    return hallados;
  }

  // Cuadro de dialogo con el estilo de la aprobacion de datos sensibles (3.3.2).
  function abrirDialogo(html) {
    const fondo = document.createElement('div');
    fondo.className = 'cm-approve-backdrop';
    fondo.innerHTML = `<div class="cm-approve cm-cs" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(fondo);
    const alTeclado = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cerrar(); } };
    const cerrar = () => { document.removeEventListener('keydown', alTeclado, true); fondo.remove(); if (fondo._alCerrar) fondo._alCerrar(); };
    document.addEventListener('keydown', alTeclado, true);
    return { fondo, cerrar, $: (sel) => fondo.querySelector(sel) };
  }

  // Antes de guardar una memoria que parece tener un secreto. Resuelve true con "Save anyway".
  function confirmarSecretos(hallados) {
    return new Promise(resolve => {
      const d = abrirDialogo(`
        <h3>This answer seems to contain ${escapeHtml(hallados.join(', '))}</h3>
        <p>Your memories are encrypted, but they are kept for good — they cannot be deleted — and you may inject them into other AIs later. If it is a real secret, save a version without it.</p>
        <div class="cm-approve-buttons">
          <button class="cm-approve-cancel">Cancel</button>
          <button class="cm-approve-ok">Save anyway</button>
        </div>`);
      let ok = false;
      d.fondo._alCerrar = () => resolve(ok);
      d.$('.cm-approve-cancel').addEventListener('click', d.cerrar);
      d.$('.cm-approve-ok').addEventListener('click', () => { ok = true; d.cerrar(); });
      d.$('.cm-approve-cancel').focus();
    });
  }

  // Memorias del proyecto, legibles: las selladas se abren aca con la boveda.
  async function memoriasDelProyecto(proyecto) {
    const params = new URLSearchParams({ include_plaintext: '1', limit: '50', project: proyecto.project_id });
    const data = await api('GET', '/v1/memories/list?' + params);
    const out = [];
    let sinBoveda = 0;
    for (const m of data.memories || []) {
      let texto = m.summary || '';
      if (m.scheme === 'sealed') {
        if (!_state.blindClient || !m.content_blob) { sinBoveda++; continue; }
        try { texto = await _state.blindClient.open(m.content_blob); } catch (e) { sinBoveda++; continue; }
      }
      texto = String(texto || '').trim();
      if (texto && Number.isInteger(m.memory_number)) out.push({ n: m.memory_number, texto });
    }
    return { memorias: out, sinBoveda };
  }

  // El ejemplo del formato cita los numeros reales de la consigna (a, b, c), asi la IA no copia uno que no recibio.
  function cabeceraConsigna(projectName, a, b, c) {
    return [
      `[ChainMemory · Create the project state: "${projectName}"]`,
      '',
      'Below are my saved memories for this project, each with its number. Organize them into a project state.',
      '',
      'Answer ONLY with one JSON code block, nothing before or after it, in exactly this form:',
      '{"ops":[',
      ' {"op":"set_vision","statement":"..."},',
      ` {"op":"set_phase","value":"...","evidence_memory_ids":[${a}]},`,
      ` {"op":"set_focus","value":"...","evidence_memory_ids":[${a},${b}]},`,
      ` {"op":"add_decision","title":"...","statement":"...","evidence_memory_ids":[${b}]},`,
      ` {"op":"add_milestone","title":"...","status":"planned","evidence_memory_ids":[${a}]},`,
      ` {"op":"add_risk","title":"...","severity":"high","evidence_memory_ids":[${b}]},`,
      ` {"op":"add_priority","title":"...","priority_score":80,"evidence_memory_ids":[${c}]},`,
      ` {"op":"add_open_question","question":"...","evidence_memory_ids":[${c}]},`,
      ` {"op":"add_constraint","statement":"...","evidence_memory_ids":[${a}]}`,
      ']}',
      '',
      'Rules:',
      '- Use only these 9 operation types. At most one set_vision, one set_phase and one set_focus.',
      '- Every item except set_vision lists in evidence_memory_ids the memory numbers that support it. Use only the numbers below; the ones in the example are placeholders.',
      '- severity is low, med or high. status is planned, in_progress or done. priority_score goes from 0 to 100, higher first.',
      '- Include only what the memories say. Do not invent anything; leave out what you are not sure about.',
      '- Never include passwords, API keys, private keys, recovery words, addresses or server details.',
      `- At most ${MAX_STATE_ITEMS} items. Write the text in the same language as the memories.`,
      '',
      'Memories:',
      ''
    ].join('\n');
  }

  // La consigna: entran todas las memorias que caben con al menos MIN_MEM_CHARS_IN_PROMPT cada una
  // (las mas recientes primero) y el tope se reparte entre ellas; las cortas le ceden lugar a las largas.
  function armarConsigna(projectName, memorias) {
    const mayor = memorias.reduce((x, m) => Math.max(x, m.n), 0);
    const libre = MAX_INJECT_CHARS - cabeceraConsigna(projectName, mayor, mayor, mayor).length - 10;
    const sobra = (n) => `[#${n}] `.length + 3;   // numero, salto doble y la elipsis si se acorta
    const k = Math.min(memorias.length, Math.floor(libre / (MIN_MEM_CHARS_IN_PROMPT + sobra(mayor))));
    const usadas = memorias.slice(0, k)           // la lista viene de la mas nueva a la mas vieja
      .map(m => ({ n: m.n, t: m.texto.replace(/\s+\n/g, '\n') }))
      .sort((x, y) => x.t.length - y.t.length);
    let resto = libre, recortadas = 0;
    usadas.forEach((u, i) => {
      const cupo = Math.max(0, Math.min(MAX_MEM_CHARS_IN_PROMPT, Math.floor(resto / (usadas.length - i)) - sobra(u.n)));
      if (u.t.length > cupo) { u.t = u.t.slice(0, cupo) + '…'; recortadas++; }
      u.bloque = `[#${u.n}] ${u.t}\n\n`;
      resto -= u.bloque.length;
    });
    usadas.sort((x, y) => x.n - y.n);
    const numeros = usadas.map(u => u.n);
    const [a, b = a, c = b] = numeros;
    const cabecera = cabeceraConsigna(projectName, a, b, c);
    const omitidas = memorias.slice(k).map(m => m.n).sort((x, y) => x - y);
    return { text: cabecera + usadas.map(u => u.bloque).join('') + '---\n', numeros, recortadas, omitidas };
  }

  // El primer objeto JSON con "ops" de la respuesta, contando llaves fuera de las cadenas.
  function extraerOps(texto) {
    const probar = (s) => {
      for (let i = s.indexOf('"ops"'); i !== -1; i = s.indexOf('"ops"', i + 5)) {
        const ini = s.lastIndexOf('{', i);
        if (ini === -1) continue;
        let prof = 0, enCadena = false, esc = false;
        for (let k = ini; k < s.length; k++) {
          const c = s[k];
          if (enCadena) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') enCadena = false; continue; }
          if (c === '"') enCadena = true;
          else if (c === '{') prof++;
          else if (c === '}' && --prof === 0) {
            try { const j = JSON.parse(s.slice(ini, k + 1)); if (j && Array.isArray(j.ops)) return j.ops; } catch (e) {}
            break;
          }
        }
      }
      return null;
    };
    const s = String(texto || '');
    return probar(s) || probar(s.replace(/[“”]/g, '"'));
  }

  // Valida cada operacion como el servidor y descarta lo que no entra, diciendo por que.
  function validarOps(crudas, numerosDados) {
    const dados = new Set(numerosDados);
    const items = [], descartes = {};
    const descartar = (motivo) => { descartes[motivo] = (descartes[motivo] || 0) + 1; };
    const vistos = new Set();
    for (const o of crudas) {
      const def = o && typeof o === 'object' && STATE_OPS[o.op];
      if (!def) { descartar('not one of the 9 types'); continue; }
      if (UNICOS.has(o.op) && items.some(i => i.op.op === o.op)) { descartar('repeated'); continue; }
      const limpio = { op: o.op };
      let falla = null;
      for (const f of def.req) {
        const v = typeof o[f] === 'string' ? o[f].trim() : '';
        if (!v) { falla = 'missing text'; break; }
        limpio[f] = v;
      }
      if (!falla && def.opt.includes('severity') && o.severity != null) {
        const v = CERRADOS.severity[String(o.severity).trim().toLowerCase()];
        if (v) limpio.severity = v; else falla = 'value out of the list';
      }
      if (!falla && def.opt.includes('status') && o.status != null) {
        const v = CERRADOS.status[String(o.status).trim().toLowerCase()];
        if (v) limpio.status = v; else falla = 'value out of the list';
      }
      if (!falla && def.opt.includes('priority_score') && o.priority_score != null) {
        const v = Number(o.priority_score);
        if (Number.isFinite(v) && v >= 0 && v <= 100) limpio.priority_score = Math.round(v); else falla = 'value out of the list';
      }
      if (!falla && def.evid) {
        const ids = Array.isArray(o.evidence_memory_ids) ? [...new Set(o.evidence_memory_ids.map(Number))] : [];
        if (!ids.length) falla = 'no supporting memory';
        else if (ids.some(n => !dados.has(n))) falla = 'cites a memory that was not given';
        else limpio.evidence_memory_ids = ids.sort((a, b) => a - b);
      }
      if (!falla && buscarSecretos(Object.values(limpio).filter(v => typeof v === 'string').join('\n')).length) falla = 'looks like a secret';
      const texto = falla ? '' : def.text(limpio);
      if (!falla && vistos.has(o.op + '|' + texto)) falla = 'repeated';
      if (!falla && items.length >= MAX_STATE_ITEMS) falla = 'over the limit of ' + MAX_STATE_ITEMS;
      if (falla) { descartar(falla); continue; }
      vistos.add(o.op + '|' + texto);
      items.push({ op: limpio, label: def.label, texto });
    }
    return { items, descartes };
  }

  let _creacion = null;   // { projectName, consigna, numeros, antesEl, antesTexto, timer, barra }

  function costoEstado(n) { return STATE_FEE_AIC + STATE_FEE_PER_OP_AIC * n; }

  // Entrada: el boton del panel en modo "crear" (el proyecto no tiene estado todavia).
  async function crearEstado(btn) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    let proyectos;
    try { proyectos = (await api('GET', '/v1/projects')).projects || []; }
    catch (e) { toast('Could not load your projects: ' + mensajeError(e), 'error'); return; }
    finally { btn.disabled = false; btn.textContent = orig; }
    if (!proyectos.length) { toast('Create a project first (extension icon → Settings)', 'warn'); return; }
    const configurado = _state.projectBrainProject || '';
    const fijo = configurado && proyectos.find(p => p.name === configurado || p.project_id === configurado);

    const d = abrirDialogo(`
      <h3>Before you create the project state</h3>
      ${fijo ? '' : `<label class="cm-cs-field">Project <select class="cm-cs-project"><option value="">Choose a project…</option>${proyectos.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('')}</select></label>`}
      <ul class="cm-cs-notice">
        <li>Your AI will read the memories of <b class="cm-cs-name">${fijo ? escapeHtml(configurado) : 'this project'}</b> (<span class="cm-cs-count">…</span>) and organize them into a summary: focus, decisions, risks, priorities and open questions.</li>
        <li>Unlike your memories, <b>this summary is stored readable on ChainMemory's server</b>, so it can be checked and injected. Only its fingerprint goes on chain.</li>
        <li><b>It cannot be deleted.</b> You can correct it later, but every version is kept.</li>
        <li>You will review every line before anything is saved.</li>
        <li>Reading your memories is free. Saving the state costs ${STATE_FEE_AIC} AIC plus ${STATE_FEE_PER_OP_AIC} per item: about 0.1–0.25 AIC.</li>
      </ul>
      <label class="cm-pp-check cm-cs-ok-wrap"><input type="checkbox" class="cm-cs-understand"> I understand</label>
      <div class="cm-approve-error" role="alert"></div>
      <div class="cm-approve-buttons">
        <button class="cm-approve-cancel">Cancel</button>
        <button class="cm-approve-ok" disabled>Continue</button>
      </div>`);
    let elegido = fijo || null, memorias = null, carga = 0;
    const ok = d.$('.cm-approve-ok'), error = d.$('.cm-approve-error'), cuenta = d.$('.cm-cs-count');
    const refrescar = () => { ok.disabled = !(elegido && memorias && memorias.length && d.$('.cm-cs-understand').checked); };
    const cargar = async () => {
      memorias = null; error.textContent = ''; refrescar();
      if (!elegido) { cuenta.textContent = '…'; return; }
      const mia = ++carga;
      cuenta.textContent = 'counting…';
      // "Create" no se usa sobre un estado que ya existe: le sumaria items repetidos
      const nombre = fijo ? configurado : elegido.name;
      try {
        const st = await api('GET', '/v1/project/' + encodeURIComponent(nombre) + '/state');
        if (mia !== carga) return;
        cuenta.textContent = '—';
        error.textContent = `"${nombre}" already has a project state (version ${st.version}). Set it in Settings → Project Brain to inject it.`;
        return;
      } catch (e) {
        if (mia !== carga) return;
        if (!(e.status === 404 && e.data && e.data.error === 'project state not found')) {
          cuenta.textContent = '—';
          error.textContent = 'Could not check the project state: ' + mensajeError(e);
          return;
        }
      }
      try {
        const r = await memoriasDelProyecto(elegido);
        if (mia !== carga) return;
        memorias = r.memorias;
        cuenta.textContent = memorias.length + (memorias.length === 1 ? ' memory' : ' memories');
        if (!memorias.length) error.textContent = r.sinBoveda
          ? 'Your memories are encrypted and the vault is not active in this browser. Activate it with your 12 words first.'
          : 'This project has no memories yet. Save some answers to it first.';
      } catch (e) { if (mia === carga) error.textContent = 'Could not load the memories: ' + mensajeError(e); }
      refrescar();
    };
    const sel = d.$('.cm-cs-project');
    if (sel) sel.addEventListener('change', () => {
      elegido = sel.value === '' ? null : proyectos[Number(sel.value)];
      d.$('.cm-cs-name').textContent = elegido ? elegido.name : 'this project';
      cargar();
    });
    d.$('.cm-cs-understand').addEventListener('change', refrescar);
    d.$('.cm-approve-cancel').addEventListener('click', d.cerrar);
    ok.addEventListener('click', () => {
      // el estado se crea con el nombre que usa "Inject project state": el de Settings si lo hay
      const projectName = fijo ? configurado : elegido.name;
      d.cerrar();
      enviarConsigna(projectName, memorias);
    });
    cargar();
  }

  function enviarConsigna(projectName, memorias) {
    const { text, numeros, recortadas, omitidas } = armarConsigna(projectName, memorias);
    if (!numeros.length) { toast('Your memories are too long to fit in the chat box', 'warn'); return; }
    cerrarCreacion();
    const antesEl = getLastResponseEl();
    _creacion = { projectName, consigna: text, numeros, antesEl, antesTexto: antesEl ? extractResponseText(antesEl) : '' };
    const okInj = injectIntoInput(text);
    if (!okInj) navigator.clipboard.writeText(text).catch(() => {});
    closePanel();
    const partes = [];
    if (omitidas.length) {
      const lista = omitidas.slice(0, 5).map(n => '#' + n).join(', ') + (omitidas.length > 5 ? '…' : '');
      partes.push(`${numeros.length} of ${memorias.length} memories fit (oldest left out: ${lista})`);
    }
    if (recortadas) partes.push(`${recortadas} shortened`);
    toast((okInj ? '✓ Instructions pasted' : 'Instructions copied: paste them in the chat') + (partes.length ? ' · ' + partes.join(' · ') : '') + ' · nothing was charged', 'success');
    esperarRespuesta();
  }

  // Barra mientras la IA responde. La revision se abre sola cuando aparece un JSON valido
  // que dejo de cambiar; el boton sirve si la deteccion no la abre.
  function esperarRespuesta() {
    const c = _creacion;
    const barra = document.createElement('div');
    barra.className = 'cm-cs-bar';
    barra.innerHTML = `
      <span>Send the message to your AI. When it finishes, ChainMemory opens the review.</span>
      <button class="cm-cs-bar-review">Review the answer</button>
      <button class="cm-cs-bar-again" title="Paste the instructions again">Ask again</button>
      <button class="cm-cs-bar-cancel" title="Cancel">×</button>`;
    document.body.appendChild(barra);
    c.barra = barra;
    barra.querySelector('.cm-cs-bar-cancel').addEventListener('click', () => { cerrarCreacion(); toast('Nothing was saved', 'info'); });
    barra.querySelector('.cm-cs-bar-review').addEventListener('click', () => revisarRespuesta(true));
    barra.querySelector('.cm-cs-bar-again').addEventListener('click', pedirDeNuevo);
    const inicio = Date.now();
    let previo = null;
    c.timer = setInterval(() => {
      if (_creacion !== c) return clearInterval(c.timer);
      if (Date.now() - inicio > ESPERA_RESPUESTA_MS) return clearInterval(c.timer);
      const t = textoNuevaRespuesta(c);
      if (t && t === previo && extraerOps(t)) revisarRespuesta(false);
      previo = t;
    }, 2000);
  }

  function textoNuevaRespuesta(c) {
    const el = getLastResponseEl();
    if (!el || el.getAttribute('data-is-streaming') === 'true') return null;
    const t = extractResponseText(el);
    if (!t || t === c.antesTexto) return null;
    return t;
  }

  function pedirDeNuevo() {
    const c = _creacion;
    if (!c) return;
    const antesEl = getLastResponseEl();
    c.antesEl = antesEl;
    c.antesTexto = antesEl ? extractResponseText(antesEl) : '';
    if (injectIntoInput(c.consigna)) toast('✓ Instructions pasted again · send the message', 'success');
    else navigator.clipboard.writeText(c.consigna).then(() => toast('Instructions copied: paste them in the chat', 'success')).catch(() => {});
  }

  function cerrarCreacion() {
    if (_creacion) { clearInterval(_creacion.timer); if (_creacion.barra) _creacion.barra.remove(); }
    _creacion = null;
  }

  function revisarRespuesta(manual) {
    const c = _creacion;
    if (!c || c.revisando) return;
    const t = textoNuevaRespuesta(c);
    const crudas = t && extraerOps(t);
    if (!crudas) {
      if (manual) toast(t ? 'The answer has no valid state yet. Wait until it finishes, or click Ask again.' : 'No new answer yet. Send the message to your AI first.', 'warn');
      return;
    }
    c.revisando = true;
    clearInterval(c.timer);
    if (c.barra) { c.barra.remove(); c.barra = null; }
    abrirRevision(c, crudas);
  }

  async function abrirRevision(c, crudas) {
    const { items, descartes } = validarOps(crudas, c.numeros);
    const fuera = Object.entries(descartes).map(([m, n]) => `${n} ${m}`).join(' · ');
    const orden = Object.keys(STATE_OPS);
    items.sort((a, b) => orden.indexOf(a.op.op) - orden.indexOf(b.op.op));
    const d = abrirDialogo(`
      <h3>Review your project state — ${escapeHtml(c.projectName)}</h3>
      <p>Untick anything you do not want. Nothing is saved until you click Save state.</p>
      <div class="cm-cs-list">${items.length ? items.map((it, i) => `
        <label class="cm-cs-row"><input type="checkbox" data-i="${i}" checked>
          <span class="cm-cs-label">${escapeHtml(it.label)}</span>
          <span class="cm-cs-text">${escapeHtml(it.texto)}</span>
          <span class="cm-cs-ev">${(it.op.evidence_memory_ids || []).map(n => '#' + n).join(' ')}</span>
        </label>`).join('') : '<div class="cm-pp-empty">Your AI did not return any valid item. Click Ask again.</div>'}
      </div>
      ${fuera ? `<p class="cm-cs-out">Left out: ${escapeHtml(fuera)}.</p>` : ''}
      <div class="cm-cs-total"></div>
      <div class="cm-approve-error" role="alert"></div>
      <div class="cm-approve-buttons">
        <button class="cm-approve-cancel">Cancel</button>
        <button class="cm-cs-again">Ask again</button>
        <button class="cm-approve-ok">Save state</button>
      </div>`);
    const ok = d.$('.cm-approve-ok'), error = d.$('.cm-approve-error'), total = d.$('.cm-cs-total');
    let saldo = null;
    api('GET', '/v1/inject/balance').then(b => { saldo = parseFloat(b.balance_aic); refrescar(); }).catch(() => {});
    const marcados = () => Array.from(d.fondo.querySelectorAll('.cm-cs-row input:checked')).map(x => items[Number(x.dataset.i)].op);
    const refrescar = () => {
      const n = marcados().length, costo = costoEstado(n);
      total.textContent = `${n} ${n === 1 ? 'item' : 'items'} · Cost: ${fmtAIC(costo)} AIC` + (saldo != null ? ` · Balance: ${saldo.toFixed(4)} AIC` : '');
      const corto = saldo != null && saldo < costo;
      ok.disabled = !n || corto;
      if (corto) error.textContent = 'Not enough AIC to save this state.';
      else if (/^Not enough AIC/.test(error.textContent)) error.textContent = '';
    };
    d.fondo.querySelectorAll('.cm-cs-row input').forEach(x => x.addEventListener('change', refrescar));
    refrescar();
    let guardado = false;
    d.fondo._alCerrar = () => { if (!guardado && _creacion === c) { cerrarCreacion(); toast('Nothing was saved', 'info'); } };
    d.$('.cm-approve-cancel').addEventListener('click', d.cerrar);
    d.$('.cm-cs-again').addEventListener('click', () => {
      guardado = true;            // cerrar este cuadro no cancela: se espera la nueva respuesta
      d.cerrar();
      c.revisando = false;
      pedirDeNuevo();
      if (c.barra) c.barra.remove();
      esperarRespuesta();
    });
    ok.addEventListener('click', async () => {
      const ops = marcados();
      if (!ops.length) return;
      ok.disabled = true;
      ok.textContent = 'Saving…';
      error.textContent = '';
      try {
        const r = await api('POST', '/v1/project/' + encodeURIComponent(c.projectName) + '/state/ops', {
          ops,
          generated_by: 'chainmemory-extension ' + chrome.runtime.getManifest().version,
          consolidated_until_event: Math.max(...c.numeros)
        });
        guardado = true;
        d.cerrar();
        cerrarCreacion();
        const rechazadas = Array.isArray(r.rejected) ? r.rejected.length : 0;
        if (rechazadas) console.warn('[ChainMemory] operaciones rechazadas por el servidor:', r.rejected);
        if (!r.version || !r.applied_count) { toast('No changes were saved: the server did not accept any item', 'warn'); return; }
        if (!_state.projectBrainProject) {
          _state.projectBrainProject = c.projectName;
          chrome.storage.sync.set({ projectBrainProject: c.projectName });
        }
        toast(`✓ Project state created — version ${r.version} · ${r.applied_count} items` + (rechazadas ? ` · ${rechazadas} rejected` : '') + ' · it is anchored on chain in about 10 minutes', 'success');
      } catch (e) {
        ok.textContent = 'Save state';
        refrescar();
        if (e.status === 402 || (e.data && e.data.error === 'insufficient_aic')) error.textContent = 'Not enough AIC to save this state. Nothing was charged.';
        else if (e.status === 422) error.textContent = 'A memory is not anchored on chain yet. Try again in a minute. Nothing was charged.';
        else if (e.status === 409) error.textContent = 'The project state changed meanwhile. Close this and open the panel again.';
        else error.textContent = 'Save failed: ' + mensajeError(e);
      }
    });
    ok.focus();
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
      console.log(`[ChainMemory v${chrome.runtime.getManifest().version}] save-button mode on ${_platform.name}: ${_platform.singleButtonAtEnd ? 'single-at-end' : 'per-response'}`);
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

    console.log(`[ChainMemory v${chrome.runtime.getManifest().version}] loaded on`, _platform.name);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
