// Misma logica que el offscreen, pero servida con la CSP de la extension:
// script-src 'self' 'wasm-unsafe-eval'. Si el motor usa new Function o eval, aca
// revienta igual que en la extension, y se ve el error.
import * as T from "../vendor/transformers.min.js";
import { crearEmbedderLocal } from "../cm-embed-local.js";
const el = document.getElementById("log"); const L = []; const log = s => { L.push(s); el.textContent = L.join("\n"); };
const cos = (a, b) => { let n=0,na=0,nb=0; for (let i=0;i<a.length;i++){n+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];} return n/(Math.sqrt(na)*Math.sqrt(nb)||1); };
const violaciones = [];
document.addEventListener("securitypolicyviolation", e => violaciones.push(`${e.violatedDirective}: ${e.blockedURI || e.sample || ""}`));
window.__r = { estado: "corriendo" };
try {
  const ref = (await (await fetch("referencia.json")).json()).casos;
  const emb = await crearEmbedderLocal(T, new URL("../vendor/", location.href).href);
  const s = []; for (const c of ref) s.push(cos(await emb.embed(c.texto), c.vector));
  s.sort((a,b)=>a-b);
  log(`18 textos: peor coseno ${s[0].toFixed(6)}`);
  log(`violaciones de la politica de seguridad: ${violaciones.length ? violaciones.join(" | ") : "NINGUNA"}`);
  window.__r = { estado: "listo", peor: s[0], violaciones };
} catch (e) {
  log("ERROR: " + (e && e.stack || e)); log(`violaciones: ${violaciones.join(" | ") || "ninguna registrada"}`);
  window.__r = { estado: "error", error: String(e && e.message || e), violaciones };
}
