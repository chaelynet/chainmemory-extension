// Prueba del verificador de descargas del modelo (crearFetchVerificado), sin red:
// un fetch falso sirve los archivos reales o versiones alteradas.
//   node pruebas/prueba-fetch-verificado.mjs <carpeta con Xenova/all-MiniLM-L6-v2/v1>
import fs from "node:fs";
import path from "node:path";
import { crearFetchVerificado, MODELOS_BASE, HASHES_MODELO } from "../cm-embed-local.js";

const raiz = process.argv[2];
if (!raiz) { console.error("falta la carpeta de los modelos"); process.exit(2); }

let fallas = 0;
const ok = (cond, texto) => { console.log(`${cond ? "OK  " : "MAL "} ${texto}`); if (!cond) fallas++; };
const rechaza = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

// fetch falso: sirve del disco, y registra cada pedido que llega a la "red".
let pedidos = [];
function fetchFalso({ alterar = null } = {}) {
    return async (recurso, init) => {
        const url = String(recurso);
        pedidos.push({ url, rango: init && init.headers ? new Headers(init.headers).get("Range") : null });
        if (!url.startsWith(MODELOS_BASE)) return new Response("otro servidor", { status: 200 });
        const ruta = url.slice(MODELOS_BASE.length);
        const f = path.join(raiz, ruta);
        if (!fs.existsSync(f)) return new Response(null, { status: 404 });
        let datos = fs.readFileSync(f);
        if (alterar && ruta.endsWith(alterar)) { datos = Buffer.from(datos); datos[datos.length >> 1] ^= 1; }
        if (init && init.headers && new Headers(init.headers).get("Range") === "bytes=0-0") {
            return new Response(datos.subarray(0, 1), { status: 206, headers: { "content-range": `bytes 0-0/${datos.length}` } });
        }
        return new Response(datos, { status: 200, headers: { "content-length": String(datos.length) } });
    };
}

// 1. los 4 archivos buenos pasan, byte por byte iguales
{
    const avances = [];
    const f = crearFetchVerificado(fetchFalso(), { progress_callback: (p) => avances.push(p) });
    for (const ruta of Object.keys(HASHES_MODELO)) {
        const r = await f(MODELOS_BASE + ruta, { headers: new Headers() });
        const recibido = Buffer.from(await r.arrayBuffer());
        ok(r.status === 200 && recibido.equals(fs.readFileSync(path.join(raiz, ruta))), `archivo bueno entregado igual: ${ruta.split("/").pop()}`);
    }
    const onnx = avances.filter((a) => a.file === "onnx/model_fp16.onnx");
    ok(onnx.length > 0 && onnx.at(-1).progress === 100 && onnx.every((a) => a.status === "progress"),
       `avance del .onnx informado (${onnx.length} avisos, termina en 100)`);
}

// 2. un byte cambiado en cada archivo: se rechaza
for (const ruta of Object.keys(HASHES_MODELO)) {
    const nombre = ruta.split("/").pop();
    const f = crearFetchVerificado(fetchFalso({ alterar: nombre }));
    const e = await rechaza(f(MODELOS_BASE + ruta, { headers: new Headers() }));
    ok(e && e.includes("no coincide con el hash"), `un byte cambiado en ${nombre}: rechazado`);
}

// 3. otro servidor: rechazado sin salir a la red
{
    pedidos = [];
    const f = crearFetchVerificado(fetchFalso());
    const e = await rechaza(f("https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json"));
    ok(e && e.includes("descarga bloqueada") && pedidos.length === 0, "otro servidor: bloqueado sin pedido");
    const e2 = await rechaza(f("https://models.chainmemory.ai.evil.example/x"));
    ok(e2 && pedidos.length === 0, "dominio que empieza igual pero es otro: bloqueado");
}

// 4. archivo que no esta en la lista: 404 sin salir a la red
{
    pedidos = [];
    const f = crearFetchVerificado(fetchFalso());
    const r = await f(MODELOS_BASE + "Xenova/all-MiniLM-L6-v2/v1/onnx/model.onnx");
    ok(r.status === 404 && pedidos.length === 0, "archivo fuera de la lista (model.onnx): 404 sin pedido");
    const r2 = await f(MODELOS_BASE + "Xenova/all-MiniLM-L6-v2/v1/constructor");
    const r3 = await f(MODELOS_BASE + "Xenova/all-MiniLM-L6-v2/v1/config.json");
    ok(r3.status === 404, "config.json (lo usaba transformers.js, el motor propio no): 404");
    ok(r2.status === 404, "nombre raro (constructor): 404");
}

// 5. ya no hay excepcion para el sondeo de 1 byte (era de transformers.js): un
//    pedido con Range de un archivo de la lista se baja entero y se verifica igual
{
    pedidos = [];
    const f = crearFetchVerificado(fetchFalso());
    const h = new Headers(); h.set("Range", "bytes=0-0");
    const e = await rechaza(f(MODELOS_BASE + "Xenova/all-MiniLM-L6-v2/v1/onnx/model_fp16.onnx", { method: "GET", headers: h }));
    ok(e && e.includes("no coincide con el hash"), "pedido parcial (Range): no se acepta sin verificar");
}

// 6. archivos propios de la extension: pasan directo
{
    pedidos = [];
    const f = crearFetchVerificado(async (u) => { pedidos.push({ url: String(u) }); return new Response("wasm"); });
    const r = await f("chrome-extension://abc/vendor/ort-wasm-simd-threaded.wasm");
    ok((await r.text()) === "wasm" && pedidos.length === 1, "archivo de la extension (chrome-extension://): pasa");
}

// 7. errores del servidor se devuelven como estan (transformers.js los maneja)
{
    const f = crearFetchVerificado(async () => new Response(null, { status: 503 }));
    const r = await f(MODELOS_BASE + "Xenova/all-MiniLM-L6-v2/v1/tokenizer.json");
    ok(r.status === 503, "error 503 del servidor: se devuelve tal cual");
}

console.log(fallas ? `\n${fallas} FALLAS` : "\nOK: todas las pruebas del verificador pasan");
process.exit(fallas ? 1 : 0);
