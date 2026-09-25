/**
 * cm-embed-local.js — prepara transformers.js para correr SIN tocar ningun CDN.
 *
 * Por defecto transformers.js baja el motor ONNX (WebAssembly) desde
 * cdn.jsdelivr.net. En una extension eso esta prohibido: Manifest V3 no permite
 * ejecutar codigo remoto, y el WebAssembly cuenta como codigo. Ademas elegiria la
 * variante "asyncify" de 26 MB, pensada para WebGPU, que aca no se usa.
 *
 * transformers.js solo elige la ruta si nadie la configuro antes, asi que alcanza
 * con fijarla apuntando a los archivos empaquetados en vendor/, con la variante
 * de CPU (14 MB).
 *
 * Los PESOS del modelo se bajan la primera vez de models.chainmemory.ai, un
 * servidor de ChainMemory: son datos, no codigo, se verifican contra su hash
 * (anclado en la cadena) antes de usarlos y quedan en la cache del navegador.
 *
 * Este archivo no usa ninguna API de chrome.*: lo usa el offscreen document de
 * la extension y tambien una pagina de prueba comun, con la misma logica.
 */
import { createEmbedder } from "./cm-embed.js";

// Los pesos del modelo los sirve ChainMemory, no Hugging Face: si un tercero se
// cae o cambia de politica, el alta no puede dejar de funcionar. Son los mismos
// archivos, byte por byte, fijados a una revision y verificados contra el hash
// que publica el origen. La ruta lleva version: si algun dia cambia el modelo, es
// /v2/ y no se pisa nada.
export const MODELOS_BASE = "https://models.chainmemory.ai/";
export const MODELOS_RUTA = "{model}/v1/";

// SHA-256 de cada archivo que baja la extension, copiados de SHA256SUMS. Un
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
    "Xenova/all-MiniLM-L6-v2/v1/config.json":           "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
    "Xenova/all-MiniLM-L6-v2/v1/tokenizer.json":        "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    "Xenova/all-MiniLM-L6-v2/v1/tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
    "Xenova/all-MiniLM-L6-v2/v1/onnx/model_fp16.onnx":  "2cdb5e58291813b6d6e248ed69010100246821a367fa17b1b81ae9483744533d",
});

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Envuelve fetch para que transformers.js solo reciba archivos del modelo que
 * coinciden con HASHES_MODELO. Reglas, en orden:
 *   - lo que no es http(s) (los archivos de la propia extension) pasa directo;
 *   - cualquier servidor que no sea models.chainmemory.ai: se rechaza;
 *   - el sondeo de 1 byte (Range: bytes=0-0) con el que transformers.js pregunta
 *     si un archivo existe y cuanto pesa: pasa directo, su contenido no se usa;
 *   - un archivo que no esta en la lista: 404 sin salir a la red, lo mismo que
 *     contesta el servidor, que no tiene otros archivos;
 *   - un archivo de la lista: se baja entero, se calcula su SHA-256 y solo si
 *     coincide se entrega. Si no coincide, error.
 *
 * La respuesta se lee entera antes de entregarla, asi que el avance de la
 * descarga lo informa este envoltorio, con el mismo formato que transformers.js.
 */
export function crearFetchVerificado(fetchBase, { hashes = HASHES_MODELO, base = MODELOS_BASE, progress_callback } = {}) {
    return async function fetchVerificado(recurso, init) {
        const url = typeof recurso === "string" ? recurso : (recurso instanceof URL ? recurso.href : recurso.url);
        if (!/^https?:/i.test(url)) return fetchBase(recurso, init);
        if (!url.startsWith(base)) {
            throw new Error(`descarga bloqueada: ${new URL(url).origin} no es el servidor del modelo`);
        }
        const rango = init && init.headers ? new Headers(init.headers).get("Range") : null;
        if (rango === "bytes=0-0") return fetchBase(recurso, init);

        const ruta = url.slice(base.length).split(/[?#]/)[0];
        const esperado = Object.prototype.hasOwnProperty.call(hashes, ruta) ? hashes[ruta] : null;
        if (!esperado) return new Response(null, { status: 404, statusText: "Not Found" });

        const r = await fetchBase(recurso, init);
        if (!r.ok) return r;
        const total = parseInt(r.headers.get("content-length") || "0", 10) || 0;
        const archivo = ruta.split("/").slice(3).join("/");      // "onnx/model_fp16.onnx"
        const partes = [];
        let recibidos = 0;
        let ultimoPorcentaje = -1;      // un aviso por punto porcentual, no uno por pedazo
        const lector = r.body.getReader();
        for (;;) {
            const { done, value } = await lector.read();
            if (done) break;
            partes.push(value);
            recibidos += value.length;
            const porcentaje = total ? Math.min(100, Math.floor((recibidos / total) * 100)) : -1;
            if (progress_callback && porcentaje > ultimoPorcentaje) {
                ultimoPorcentaje = porcentaje;
                progress_callback({ status: "progress", name: "", file: archivo, loaded: recibidos, total, progress: porcentaje });
            }
        }
        const datos = new Uint8Array(recibidos);
        let pos = 0;
        for (const p of partes) { datos.set(p, pos); pos += p.length; }

        const obtenido = hex(await crypto.subtle.digest("SHA-256", datos));
        if (obtenido !== esperado) {
            throw new Error(`${archivo} no coincide con el hash anclado en la cadena (llego ${obtenido.slice(0, 16)}…); no se usa`);
        }
        return new Response(datos, { status: r.status, statusText: r.statusText, headers: r.headers });
    };
}

/**
 * @param T        el modulo de transformers.js ya importado
 * @param baseVendor URL de la carpeta vendor/ (chrome.runtime.getURL("vendor/")
 *                 en la extension, "./vendor/" en una pagina)
 */
export async function crearEmbedderLocal(T, baseVendor, { dtype = "fp16", progress_callback } = {}) {
    const base = baseVendor.endsWith("/") ? baseVendor : baseVendor + "/";
    T.env.backends.onnx.wasm.wasmPaths = {
        mjs:  base + "ort-wasm-simd-threaded.mjs",
        wasm: base + "ort-wasm-simd-threaded.wasm",
    };
    // Sin cross-origin isolation no hay SharedArrayBuffer: un solo hilo. Se fija
    // explicito para que no intente levantar workers que despues fallan.
    T.env.backends.onnx.wasm.numThreads = 1;
    T.env.allowLocalModels = false;
    T.env.remoteHost = MODELOS_BASE;
    T.env.remotePathTemplate = MODELOS_RUTA;
    // Cada archivo del modelo se verifica contra su hash antes de usarlo. El
    // avance de la descarga lo informa el verificador; los avisos de avance de
    // transformers.js se descartan porque llegarian despues, sobre datos que ya
    // estan en memoria, y harian saltar la barra hacia atras.
    T.env.fetch = crearFetchVerificado(globalThis.fetch.bind(globalThis), { progress_callback });
    const avisos = progress_callback && ((p) => { if (!p || p.status !== "progress") progress_callback(p); });
    return createEmbedder(T, { dtype, device: "wasm", progress_callback: avisos });
}
