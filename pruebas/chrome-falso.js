// Imitacion minima de la API de Chrome para ver el popup fuera de la extension.
// Solo para pruebas: no va en el paquete. Arranca como un usuario que acaba de
// crear su clave (vaultPending) y todavia no tiene frase.
(function () {
  const almacen = { sync: { apiKey: "aic_prueba", walletAddress: "0x1234567890abcdef1234567890abcdef12345678" },
                    local: { vaultPending: true } };
  const oyentes = [];
  const cambios = [];
  function area(nombre) {
    return {
      get(keys, cb) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in almacen[nombre]) out[k] = almacen[nombre][k]; });
        setTimeout(() => cb(out), 0);
      },
      set(obj, cb) { Object.assign(almacen[nombre], obj); cambios.push({ area: nombre, obj }); setTimeout(() => cb && cb(), 0); },
      remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete almacen[nombre][k]); setTimeout(() => cb && cb(), 0); },
    };
  }
  window.__almacen = almacen;
  window.__cambios = cambios;
  window.chrome = {
    storage: { sync: area("sync"), local: area("local"), onChanged: { addListener() {} } },
    runtime: {
      id: "simulado",
      getManifest: () => ({ version: "3.3.0" }),
      onMessage: { addListener: f => oyentes.push(f), removeListener: f => { const i = oyentes.indexOf(f); if (i >= 0) oyentes.splice(i, 1); } },
      // cm-prepare: simula la descarga del modelo con avisos de progreso.
      sendMessage(m) {
        if (m && m.action === "cm-prepare") {
          return new Promise(resolve => {
            let p = 0;
            const t = setInterval(() => {
              p += 20;
              oyentes.slice().forEach(f => f({ type: "cm-embed-progress", file: "onnx/model_fp16.onnx", progress: p }));
              if (p >= 100) { clearInterval(t); resolve({ ok: true }); }
            }, 150);
          });
        }
        return Promise.resolve({ ok: true });
      },
    },
    tabs: { create() {} },
  };
  // El popup pide saldo y memorias a la API: se contesta vacio para no depender de la red.
  const fetchReal = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.chainmemory.ai")) {
      const cuerpo = String(url).includes("balance") ? { balance_aic: "1.0000" } : { memories: [], count: 0, projects: [] };
      return Promise.resolve(new Response(JSON.stringify(cuerpo), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return fetchReal(url, opts);
  };
})();
