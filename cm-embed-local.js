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
 * Los PESOS del modelo si se bajan de Hugging Face la primera vez: son datos, no
 * codigo, y quedan en la cache del navegador.
 *
 * Este archivo no usa ninguna API de chrome.*: lo usa el offscreen document de
 * la extension y tambien una pagina de prueba comun, con la misma logica.
 */
import { createEmbedder } from "./cm-embed.js";

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
    T.env.allowLocalModels = false;       // el modelo viene de Hugging Face
    return createEmbedder(T, { dtype, device: "wasm", progress_callback });
}
