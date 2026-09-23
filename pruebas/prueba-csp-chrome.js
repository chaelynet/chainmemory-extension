// Simula lo unico que transformers.js mira para saber si esta en una extension:
// chrome.runtime.id como string. Script clasico: corre antes que los modulos.
window.chrome = window.chrome || {};
window.chrome.runtime = { id: "simulacion-de-extension" };
