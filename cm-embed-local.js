/**
 * cm-embed-local.js — calcula el vector de busqueda de una memoria en la maquina
 * del usuario, con el motor propio de ChainMemory (motor/): tokenizador, lector
 * del modelo y nucleo WebAssembly escritos por ChainMemory. No hay codigo de
 * terceros: ni librerias empaquetadas ni nada bajado de un CDN.
 *
 * Da el mismo vector que el servidor: validado contra el vector guardado de 837
 * memorias reales (peor coseno 0.9999988) y token por token contra el
 * tokenizador del servidor.
 *
 * Los PESOS del modelo se bajan la primera vez de models.chainmemory.ai. Son
 * datos, no codigo: se verifican contra su hash (anclado en la cadena) antes de
 * usarlos, se guardan en la cache del navegador y se vuelven a verificar cada
 * vez que se leen de ahi.
 *
 * Este archivo no usa ninguna API de chrome.*: lo usa el offscreen document de
 * la extension y tambien una pagina de prueba comun, con la misma logica.
 *
 *   const emb = await crearEmbedderLocal({ progress_callback });
 *   const v = await emb.embed("texto de la memoria");   // Array de 384 numeros
 */
import { crearMotor } from "./motor/motor.mjs";

// Los pesos del modelo los sirve ChainMemory, no Hugging Face: si un tercero se
// cae o cambia de politica, el alta no puede dejar de funcionar. Son los mismos
// archivos, byte por byte, fijados a una revision y verificados contra el hash
// que publica el origen. La ruta lleva version: si algun dia cambia el modelo, es
// /v2/ y no se pisa nada.
export const MODELOS_BASE = "https://models.chainmemory.ai/";
export const RUTA_MODELO = "Xenova/all-MiniLM-L6-v2/v1/";
export const CACHE_MODELO = "chainmemory-modelo-v1";
const CACHE_VIEJA = "transformers-cache";          // la de la version con transformers.js

// SHA-256 de los archivos que baja la extension, copiados de SHA256SUMS. Un
// archivo cuyo hash no coincida no se usa ni se guarda en la cache: la descarga
// falla. Asi, aunque alguien cambiara los archivos en el servidor, la extension
// no los aceptaria.
//
// Estos hashes estan anclados en la cadena de ChainMemory (202604), contrato
// ProjectStateAnchor 0xa7A8BA51950255b3e223a6745597C67009Fe7875, anchorId 103:
//   projectId = keccak256("cm:model:Xenova/all-MiniLM-L6-v2"), version 1
//   stateHash = SHA-256 de SHA256SUMS = SHA256SUMS_ANCLADO
// pruebas/verificar-hashes-anclados.mjs comprueba que esta lista y lo anclado
// coinciden. Si algun dia cambia el modelo, es una ruta /v2/ con su propio
// anclaje y su propia lista.
export const SHA256SUMS_ANCLADO = "4751c8bfd75b05bea5a057f817c779f7f922f4002edc03e2d9cb79285aa09f28";
export const HASHES_MODELO = Object.freeze({
    "Xenova/all-MiniLM-L6-v2/v1/tokenizer.json":       "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    "Xenova/all-MiniLM-L6-v2/v1/onnx/model_fp16.onnx": "2cdb5e58291813b6d6e248ed69010100246821a367fa17b1b81ae9483744533d",
});

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (datos) => hex(await crypto.subtle.digest("SHA-256", datos));

/**
 * Envuelve fetch para que solo se acepten archivos del modelo que coinciden con
 * HASHES_MODELO. Reglas, en orden:
 *   - lo que no es http(s) (los archivos de la propia extension) pasa directo;
 *   - cualquier servidor que no sea models.chainmemory.ai: se rechaza;
 *   - un archivo que no esta en la lista: 404 sin salir a la red, lo mismo que
 *     contesta el servidor, que no tiene otros archivos;
 *   - un archivo de la lista: se baja entero, se calcula su SHA-256 y solo si
 *     coincide se entrega. Si no coincide, error.
 * Informa el avance de la descarga, un aviso por punto porcentual.
 */
export function crearFetchVerificado(fetchBase, { hashes = HASHES_MODELO, base = MODELOS_BASE, progress_callback } = {}) {
    return async function fetchVerificado(recurso, init) {
        const url = typeof recurso === "string" ? recurso : (recurso instanceof URL ? recurso.href : recurso.url);
        if (!/^https?:/i.test(url)) return fetchBase(recurso, init);
        if (!url.startsWith(base)) {
            throw new Error(`descarga bloqueada: ${new URL(url).origin} no es el servidor del modelo`);
        }
        const ruta = url.slice(base.length).split(/[?#]/)[0];
        const esperado = Object.prototype.hasOwnProperty.call(hashes, ruta) ? hashes[ruta] : null;
        if (!esperado) return new Response(null, { status: 404, statusText: "Not Found" });

        const r = await fetchBase(recurso, init);
        if (!r.ok) return r;
        const total = parseInt(r.headers.get("content-length") || "0", 10) || 0;
        const archivo = ruta.split("/").slice(3).join("/");      // "onnx/model_fp16.onnx"
        const partes = [];
        let recibidos = 0;
        let ultimoPorcentaje = -1;
        const lector = r.body.getReader();
        for (;;) {
            const { done, value } = await lector.read();
            if (done) break;
            partes.push(value);
            recibidos += value.length;
            const porcentaje = total ? Math.min(100, Math.floor((recibidos / total) * 100)) : -1;
            if (progress_callback && porcentaje > ultimoPorcentaje) {
                ultimoPorcentaje = porcentaje;
                progress_callback({ status: "progress", file: archivo, loaded: recibidos, total, progress: porcentaje });
            }
        }
        const datos = new Uint8Array(recibidos);
        let pos = 0;
        for (const p of partes) { datos.set(p, pos); pos += p.length; }

        const obtenido = await sha256(datos);
        if (obtenido !== esperado) {
            throw new Error(`${archivo} no coincide con el hash anclado en la cadena (llego ${obtenido.slice(0, 16)}…); no se usa`);
        }
        return new Response(datos, { status: r.status, statusText: r.statusText, headers: r.headers });
    };
}

/**
 * Un archivo del modelo, verificado. Primero la cache (y se verifica igual: si
 * alguien la altero, se descarta y se baja de nuevo); si no esta, se baja con el
 * fetch verificado y se guarda.
 */
async function archivoVerificado(ruta, fetchVerificado) {
    const url = MODELOS_BASE + ruta;
    const cache = await caches.open(CACHE_MODELO);
    const guardado = await cache.match(url);
    if (guardado) {
        const datos = new Uint8Array(await guardado.arrayBuffer());
        if ((await sha256(datos)) === HASHES_MODELO[ruta]) return datos;
        await cache.delete(url);
    }
    const r = await fetchVerificado(url);
    if (!r.ok) throw new Error(`no se pudo bajar ${ruta}: HTTP ${r.status}`);
    const datos = new Uint8Array(await r.arrayBuffer());
    await cache.put(url, new Response(datos, { headers: { "content-type": "application/octet-stream" } }));
    return datos;
}

export async function crearEmbedderLocal({ progress_callback } = {}) {
    // La cache de la version anterior (transformers.js) ya no se usa: se libera.
    try { await caches.delete(CACHE_VIEJA); } catch (_) {}
    const fetchVerificado = crearFetchVerificado(globalThis.fetch.bind(globalThis), { progress_callback });
    const [tokenizer, onnx] = await Promise.all([
        archivoVerificado(RUTA_MODELO + "tokenizer.json", fetchVerificado),
        archivoVerificado(RUTA_MODELO + "onnx/model_fp16.onnx", fetchVerificado),
    ]);
    const motor = await crearMotor({ onnx, tokenizer: JSON.parse(new TextDecoder().decode(tokenizer)) });
    return {
        // Array comun: el vector viaja por mensajes de la extension, que no
        // conservan los Float32Array.
        embed: async (texto) => Array.from(motor.embed(String(texto ?? ""))),
    };
}
