// ChainMemory v3.3.0 — background service worker

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Abrir el faucet al instalar (como v2.1.0)
    chrome.tabs.create({ url: 'https://faucet.chainmemory.ai' });
  } else if (details.reason === 'update') {
    console.log('ChainMemory updated to', chrome.runtime.getManifest().version);
  }
});

// ── Vector de busqueda (v3.3.0) ──────────────────────────────────────────────
// El modelo corre en un documento offscreen: el service worker no puede con el
// WebAssembly, y en la pagina del chat congelaria la pagina mientras calcula.
//
// El documento NO queda abierto todo el tiempo: el modelo ocupa bastante memoria
// y no tiene sentido cobrarsela al usuario mientras Chrome este abierto sin usar
// ChainMemory. Se abre cuando hace falta y se cierra tras 5 minutos sin pedidos.
// Reabrirlo cuesta medio segundo: los pesos quedan en la cache del disco.
const OFFSCREEN_URL = 'offscreen.html';
const CIERRE_INACTIVO_MS = 5 * 60 * 1000;
let creando = null;
let temporizador = null;

async function hayOffscreen() {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return ctx.length > 0;
}

async function asegurarOffscreen() {
  if (await hayOffscreen()) return;
  // Dos pedidos simultaneos no pueden crear dos documentos: Chrome permite uno.
  if (!creando) {
    creando = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'Calcula en la maquina del usuario el vector de busqueda de sus memorias selladas, para que el servidor pueda encontrarlas sin ver el texto.'
    }).finally(() => { creando = null; });
  }
  await creando;
}

function reiniciarCierre() {
  if (temporizador) clearTimeout(temporizador);
  temporizador = setTimeout(async () => {
    temporizador = null;
    try { if (await hayOffscreen()) await chrome.offscreen.closeDocument(); } catch (e) {}
  }, CIERRE_INACTIVO_MS);
}

async function alOffscreen(accion, datos) {
  await asegurarOffscreen();
  reiniciarCierre();
  return chrome.runtime.sendMessage(Object.assign({ target: 'offscreen', action: accion }, datos || {}));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request) return false;

  if (request.action === 'openPopup') {
    if (chrome.action && chrome.action.openPopup) {
      try { chrome.action.openPopup(); } catch (e) {}
    }
    return false;
  }

  // Los mensajes que van AL offscreen y los avisos de progreso que salen de el no
  // son para este listener. Antes este listener devolvia true para todo, lo que
  // dejaba abierto el canal de cualquier mensaje aunque nunca fuera a contestar.
  if (request.target === 'offscreen' || request.type === 'cm-embed-progress') return false;

  if (request.action === 'cm-embed') {
    alOffscreen('cm-embed', { text: request.text })
      .then((r) => sendResponse(r || { ok: false, error: 'sin respuesta del documento offscreen' }),
            (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (request.action === 'cm-prepare') {
    alOffscreen('cm-prepare')
      .then((r) => sendResponse(r || { ok: false }),
            (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  return false;
});
