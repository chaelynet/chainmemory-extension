// ─────────────────────────────────────────────────────────────────────────────
// offscreen.js — calcula el vector de busqueda de una memoria en la maquina del
// usuario.
//
// Para que una memoria sellada se pueda encontrar, el servidor necesita su
// vector, pero no puede calcularlo: no tiene el texto. Lo calcula este documento,
// con el mismo modelo que usa el servidor y el mismo corte en 256 tokens, asi que
// el vector sale identico al que el servidor habria calculado (validado contra
// 791 memorias reales). Lo que viaja es el vector, nunca el texto.
//
// Recibe mensajes del service worker:
//   { target: "offscreen", action: "cm-embed",   text }  -> { ok, vector }
//   { target: "offscreen", action: "cm-prepare" }         -> { ok }
// y avisa el avance de la primera descarga con:
//   { type: "cm-embed-progress", file, progress }
// ─────────────────────────────────────────────────────────────────────────────
import * as T from "./vendor/transformers.min.js";
import { crearEmbedderLocal } from "./cm-embed-local.js";

let listo = null;          // promesa del embedder: se crea una sola vez
let cola = Promise.resolve();

function avisarProgreso(p) {
    if (p && p.status === "progress" && p.file && p.file.endsWith(".onnx")) {
        chrome.runtime.sendMessage({ type: "cm-embed-progress", file: p.file, progress: Math.round(p.progress || 0) })
            .catch(() => {});   // si nadie escucha (popup cerrado), no importa
    }
}

function embedder() {
    if (!listo) {
        listo = crearEmbedderLocal(T, chrome.runtime.getURL("vendor/"), { dtype: "fp16", progress_callback: avisarProgreso })
            .catch((e) => { listo = null; throw e; });   // si fallo, el proximo intento reintenta
    }
    return listo;
}

// WebAssembly de un solo hilo: los calculos van de a uno, en orden.
function encolar(fn) {
    const r = cola.then(fn, fn);
    cola = r.catch(() => {});
    return r;
}

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
    if (!msg || msg.target !== "offscreen") return false;

    if (msg.action === "cm-prepare") {
        embedder().then(() => responder({ ok: true }), (e) => responder({ ok: false, error: String(e.message || e) }));
        return true;
    }
    if (msg.action === "cm-embed") {
        encolar(async () => {
            const emb = await embedder();
            return emb.embed(String(msg.text ?? ""));
        }).then((vector) => responder({ ok: true, vector }),
                (e) => responder({ ok: false, error: String(e.message || e) }));
        return true;
    }
    return false;
});
