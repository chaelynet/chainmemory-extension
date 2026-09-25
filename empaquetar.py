# -*- coding: utf-8 -*-
"""empaquetar.py — arma el .zip que se sube a la tienda de Chrome.

Usa una lista de lo que ENTRA, no de lo que se excluye: asi nada que no este
previsto termina en el paquete (las pruebas, el .git, respaldos, zips viejos).
Despues comprueba que todo lo que el manifest y las paginas cargan este adentro.

  python empaquetar.py
"""
import hashlib, io, json, os, re, sys, zipfile

RAIZ = os.path.dirname(os.path.abspath(__file__))
os.chdir(RAIZ)
version = json.load(io.open("manifest.json", encoding="utf-8"))["version"]
SALIDA = f"chainmemory-extension-v{version}.zip"

ARCHIVOS = [
    "LICENSE", "manifest.json",
    "background.js", "content.js", "content.css",
    "popup.html", "popup.js", "popup.css",
    "offscreen.html", "offscreen.js",
    "cm-wordlist.js", "cm-crypto.js", "cm-bip39.js", "cm-client.js",
    "cm-embed-local.js",
    "motor/motor.mjs", "motor/nucleo.mjs", "motor/ensamblador.mjs", "motor/onnx.mjs",
    "motor/tokenizador.mjs", "motor/tablas-unicode.mjs",
    "icons/icon16.png", "icons/icon48.png", "icons/icon128.png",
]

faltan = [f for f in ARCHIVOS if not os.path.isfile(f)]
if faltan:
    sys.exit("ABORTA: faltan archivos: " + ", ".join(faltan))

# ── Todo lo que se carga tiene que estar en el paquete ──────────────────────
m = json.load(io.open("manifest.json", encoding="utf-8"))
referidos = set()
referidos.update(m.get("icons", {}).values())
referidos.update(m.get("action", {}).get("default_icon", {}).values())
if m.get("action", {}).get("default_popup"): referidos.add(m["action"]["default_popup"])
if m.get("background", {}).get("service_worker"): referidos.add(m["background"]["service_worker"])
for cs in m.get("content_scripts", []):
    referidos.update(cs.get("js", [])); referidos.update(cs.get("css", []))
for html in [f for f in ARCHIVOS if f.endswith(".html")]:
    t = io.open(html, encoding="utf-8").read()
    referidos.update(re.findall(r'(?:src|href)="([^":#?]+\.(?:js|css|png))"', t))
for js in ["offscreen.js", "cm-embed-local.js"] + [f for f in ARCHIVOS if f.startswith("motor/")]:
    t = io.open(js, encoding="utf-8").read()
    referidos.update(os.path.normpath(os.path.join(os.path.dirname(js), p)).replace("\\", "/")
                     for p in re.findall(r'from\s+"(\.{1,2}/[^"]+)"', t))
referidos.add("offscreen.html")
sin_empaquetar = sorted(r for r in referidos if r not in ARCHIVOS)
if sin_empaquetar:
    sys.exit("ABORTA: se cargan y no estan en la lista: " + ", ".join(sin_empaquetar))

# ── Nada de prueba ni de desarrollo ─────────────────────────────────────────
for f in ARCHIVOS:
    if f.startswith(("pruebas/", ".git")) or f.endswith(".zip"):
        sys.exit("ABORTA: " + f + " no va a la tienda")

if os.path.exists(SALIDA):
    os.remove(SALIDA)
with zipfile.ZipFile(SALIDA, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in ARCHIVOS:
        z.write(f, f)

h = hashlib.sha256(open(SALIDA, "rb").read()).hexdigest()
tam = os.path.getsize(SALIDA)
sin_comprimir = sum(os.path.getsize(f) for f in ARCHIVOS)
print(f"{SALIDA}")
print(f"  archivos       : {len(ARCHIVOS)}")
print(f"  sin comprimir  : {sin_comprimir/1048576:.1f} MB")
print(f"  comprimido     : {tam/1048576:.1f} MB")
print(f"  sha256         : {h}")
print(f"  todo lo que se carga esta adentro; ninguna prueba incluida")
