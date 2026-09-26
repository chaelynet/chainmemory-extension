// Extension y API de ChainMemory de mentira, para correr content.js real en una
// pagina de prueba. Solo pruebas: no va en el paquete. Modos en window.__modo:
// normal | sin-id | vector-invalido | historial-falla.
// ── Chrome de mentira, con modos ──
window.__modo = "normal";
window.__errorContexto = () => new Error("Extension context invalidated.");
const almacen = { sync: { apiKey: "aic_prueba", aiName: "prueba" },
                  local: { seedPhrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" } };
function area(nombre) {
  return {
    get(keys, cb) {
      const ks = Array.isArray(keys) ? keys : [keys];
      if (nombre === "local" && ks.includes("history") && window.__modo === "historial-falla") throw window.__errorContexto();
      const out = {}; ks.forEach(k => { if (k in almacen[nombre]) out[k] = almacen[nombre][k]; });
      setTimeout(() => cb(out), 0);
    },
    set(obj, cb) { Object.assign(almacen[nombre], obj); setTimeout(() => cb && cb(), 0); },
  };
}
window.chrome = {
  storage: { sync: area("sync"), local: area("local"), onChanged: { addListener() {} } },
  runtime: {
    get id() { return window.__modo === "sin-id" ? undefined : "simulado"; },
    getManifest: () => ({ version: "3.3.0" }),
    onMessage: { addListener() {} },
    sendMessage(m) {
      if (m && m.action === "cm-embed") {
        (window.__textosVector = window.__textosVector || []).push(m.text);
        if (window.__modo === "vector-invalido") throw window.__errorContexto();
        return Promise.resolve({ ok: true, vector: new Array(384).fill(0.05) });
      }
      return Promise.resolve({ ok: true });
    },
  },
};
// ── API de ChainMemory de mentira ──
window.__escrituras = [];
const fetchReal = window.fetch.bind(window);
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.chainmemory.ai")) return fetchReal(url, opts);
  const cuerpo = opts.body ? JSON.parse(opts.body) : null;
  if ((opts.method || "GET") === "POST") window.__escrituras.push({ ruta: u.replace("https://api.chainmemory.ai", ""), conVector: !!(cuerpo && Array.isArray(cuerpo.embedding)) });
  const n = window.__escrituras.length;
  return new Response(JSON.stringify({ memory_number: 1000 + n, memory_id: n, scheme: "sealed", searchable: !!(cuerpo && cuerpo.embedding) }), { status: 200, headers: { "content-type": "application/json" } });
};
