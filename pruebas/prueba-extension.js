// Prueba del vector dentro de la extension. No va en el paquete de la tienda.
//
// Recorre el camino que usa la pagina del chat al guardar una memoria sellada:
// chrome.runtime.sendMessage({action:'cm-embed'}) -> service worker -> offscreen
// -> modelo. Compara cada vector contra el que calculo el servidor para el mismo
// texto (referencia.json). Si coinciden, las memorias selladas que guarde la
// extension se van a poder encontrar igual que las demas.
const logEl = document.getElementById("log");
const L = [];
const log = (s, cls) => { L.push(cls ? `<span class="${cls}">${s}</span>` : s); logEl.innerHTML = L.join("\n"); };
const cos = (a, b) => { let n=0, na=0, nb=0; for (let i=0;i<a.length;i++){n+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];} return n/(Math.sqrt(na)*Math.sqrt(nb)||1); };

let porcentaje = -1;
chrome.runtime.onMessage.addListener((m) => {
  if (m && m.type === "cm-embed-progress" && m.progress !== porcentaje && m.progress % 10 === 0) {
    porcentaje = m.progress;
    log(`  descargando el modelo: ${m.progress}%`);
  }
});

(async () => {
  const fallas = [];
  try {
    log(`extension ${chrome.runtime.getManifest().version}`);

    const t0 = performance.now();
    const p = await chrome.runtime.sendMessage({ action: "cm-prepare" });
    const seg = ((performance.now() - t0) / 1000).toFixed(1);
    if (!p || !p.ok) { fallas.push("no se pudo preparar el modelo: " + (p && p.error)); log(`modelo: NO se pudo preparar (${p && p.error})`, "mal"); }
    else log(`modelo listo en ${seg} s`, "ok");

    const ref = (await (await fetch("referencia.json")).json()).casos;
    const sims = [];
    const t1 = performance.now();
    for (const c of ref) {
      const r = await chrome.runtime.sendMessage({ action: "cm-embed", text: c.texto });
      if (!r || !r.ok) { fallas.push("fallo un vector: " + (r && r.error)); continue; }
      sims.push(cos(r.vector, c.vector));
    }
    const ms = Math.round((performance.now() - t1) / ref.length);
    sims.sort((a, b) => a - b);
    if (sims.length) {
      const peor = sims[0];
      log(`${sims.length} de ${ref.length} textos contra el vector del servidor: peor coseno ${peor.toFixed(6)} (${ms} ms cada uno)`,
          peor >= 0.9999 ? "ok" : "mal");
      if (peor < 0.9999) fallas.push(`el peor coseno es ${peor.toFixed(6)}, se esperaba >= 0.9999`);
    }

    // Dos pedidos a la vez: el offscreen los tiene que encolar, no romperse.
    const [a, b] = await Promise.all([
      chrome.runtime.sendMessage({ action: "cm-embed", text: "primer pedido simultaneo" }),
      chrome.runtime.sendMessage({ action: "cm-embed", text: "segundo pedido simultaneo" }),
    ]);
    const simultaneos = a && a.ok && b && b.ok;
    log(`dos pedidos simultaneos: ${simultaneos ? "los dos respondieron" : "FALLO"}`, simultaneos ? "ok" : "mal");
    if (!simultaneos) fallas.push("los pedidos simultaneos fallaron");

    const vacio = await chrome.runtime.sendMessage({ action: "cm-embed", text: "" });
    log(`texto vacio: ${vacio && vacio.ok ? "vector de " + vacio.vector.length : "FALLO"}`, vacio && vacio.ok ? "ok" : "mal");

    // ¿De donde salio el modelo? Lo informa el offscreen, que es quien descarga.
    // Si el modelo ya estaba en la cache del navegador no hay descarga que ver:
    // en ese caso lo unico que se puede exigir es que no haya ido a un tercero.
    const aud = await chrome.runtime.sendMessage({ target: "offscreen", action: "cm-audit" });
    const origenes = (aud && aud.origenes) || [];
    const terceros = origenes.filter(o => !o.startsWith("chrome-extension://") && o !== "https://models.chainmemory.ai");
    const deChainMemory = origenes.includes("https://models.chainmemory.ai");
    log(`servidores a los que fue el offscreen: ${origenes.length ? origenes.join(", ") : "ninguno (todo desde la cache)"}`);
    log(`  el modelo vino de models.chainmemory.ai: ${deChainMemory ? "SI" : "no hubo descarga (cache)"}`, deChainMemory ? "ok" : null);
    log(`  pedidos a terceros: ${terceros.length ? terceros.join(", ") : "NINGUNO"}`, terceros.length ? "mal" : "ok");
    if (terceros.length) fallas.push("el offscreen fue a un tercero: " + terceros.join(", "));
  } catch (e) {
    fallas.push(String(e && e.stack || e));
  }
  log("");
  if (fallas.length) { log("FALLAS:", "mal"); fallas.forEach(f => log("  - " + f, "mal")); }
  else log("OK: el vector que calcula la extension es el mismo que el del servidor.", "ok");
})();
