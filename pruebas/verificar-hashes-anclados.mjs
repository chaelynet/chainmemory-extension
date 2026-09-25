// Comprueba que los hashes escritos en la extension (cm-embed-local.js) son los
// anclados en la cadena de ChainMemory, y que el servidor sirve eso mismo.
//   node pruebas/verificar-hashes-anclados.mjs
// Sin dependencias: lee la cadena con una llamada JSON-RPC directa.
import crypto from "node:crypto";
import { MODELOS_BASE, HASHES_MODELO, SHA256SUMS_ANCLADO } from "../cm-embed-local.js";

const RPC = "https://rpc.chainmemory.ai";
const CONTRATO = "0xa7A8BA51950255b3e223a6745597C67009Fe7875";
const RUTA = "Xenova/all-MiniLM-L6-v2/v1/";
// keccak256("cm:model:Xenova/all-MiniLM-L6-v2"). Node no trae keccak, asi que va
// fijo; lo calculo anclar-modelo.js con ethers al anclar.
const PROJECT_ID = "a47a7b5fbe14daeca53067e77b0419e9eec55e62efa369f639d97946067c3062";

let fallas = 0;
const ok = (cond, texto) => { console.log(`${cond ? "OK  " : "MAL "} ${texto}`); if (!cond) fallas++; };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function rpc(method, params) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
}

// 1. la cadena
const chainId = parseInt(await rpc("eth_chainId", []), 16);
ok(chainId === 202604, `cadena ${chainId}`);
// getAnchorById(103): selector 0x32bf361b -> (projectId, version, stateHash, anchoredAt, anchoredBy)
const res = (await rpc("eth_call", [{ to: CONTRATO, data: "0x32bf361b" + (103).toString(16).padStart(64, "0") }, "latest"])).slice(2);
const palabras = res.match(/.{64}/g) || [];
ok(palabras[0] === PROJECT_ID, `anclaje 103 es del modelo (projectId ${palabras[0]?.slice(0, 16)}…)`);
ok(parseInt(palabras[1], 16) === 1, `version anclada ${parseInt(palabras[1], 16)}`);
ok(palabras[2] === SHA256SUMS_ANCLADO, `hash anclado ${palabras[2]?.slice(0, 16)}… = SHA256SUMS_ANCLADO de la extension`);

// 2. el servidor sirve el SHA256SUMS anclado
const sums = Buffer.from(await (await fetch(MODELOS_BASE + RUTA + "SHA256SUMS", { cache: "no-store" })).arrayBuffer());
ok(sha256(sums) === SHA256SUMS_ANCLADO, `SHA256SUMS servido tiene el hash anclado`);

// 3. cada hash escrito en la extension esta en ese SHA256SUMS
const lista = Object.fromEntries(sums.toString("utf8").trim().split("\n").map((l) => {
    const [h, f] = l.split(/ [ *]/); return [RUTA + f.trim(), h];
}));
for (const [ruta, h] of Object.entries(HASHES_MODELO)) {
    ok(lista[ruta] === h, `${ruta.slice(RUTA.length)}: hash de la extension = hash anclado`);
}

console.log(fallas ? `\n${fallas} FALLAS` : "\nOK: la extension verifica contra exactamente lo anclado en la cadena");
process.exit(fallas ? 1 : 0);
