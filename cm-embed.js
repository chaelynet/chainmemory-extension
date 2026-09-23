/**
 * cm-embed.js — embedding de memorias calculado en el cliente.
 *
 * Produce el MISMO vector que el servidor (sentence-transformers,
 * all-MiniLM-L6-v2), para que las memorias nuevas, cuyo vector calcula el
 * cliente, sigan siendo comparables con las que ya existen, cuyo vector calculo
 * el servidor. Validado contra las 791 memorias reales: coseno 1.000000 en fp32 y
 * 0.999998 en el peor caso con fp16.
 *
 * Por que no se usa el pipeline de transformers.js, que seria lo obvio:
 *
 *   El servidor corta el texto en 256 tokens INCLUYENDO los especiales, y
 *   conserva el [SEP] del final: [CLS] + 254 tokens + [SEP]. El truncado de
 *   transformers.js se come ese [SEP]. En memorias largas —el 68% de las reales
 *   pasa los 256 tokens— eso cambia el vector lo suficiente como para que la
 *   busqueda devuelva otro resultado. Asi que los tokens se arman a mano.
 *
 * La libreria transformers.js se recibe como parametro en vez de importarse:
 * asi el mismo archivo corre en Node, en una pagina y dentro de la extension,
 * donde por Manifest V3 la libreria tiene que ir empaquetada y no puede
 * cargarse desde un CDN.
 *
 *   const T = await import(".../transformers.js");
 *   const emb = await createEmbedder(T, { dtype: "fp16" });
 *   const v = await emb.embed("texto de la memoria");   // Array de 384 numeros
 */

export const MODELO = "Xenova/all-MiniLM-L6-v2";
export const MAX_TOKENS = 256;   // el mismo corte que sentence_bert_config.json
export const DIM = 384;

export async function createEmbedder(T, { dtype = "fp16", device, progress_callback } = {}) {
    const opciones = { dtype };
    if (device) opciones.device = device;
    // La primera carga baja ~43 MB: quien llama puede mostrar el avance.
    if (progress_callback) opciones.progress_callback = progress_callback;

    const tokenizador = await T.AutoTokenizer.from_pretrained(MODELO, progress_callback ? { progress_callback } : undefined);
    const modelo = await T.AutoModel.from_pretrained(MODELO, opciones);

    // Los ids de [CLS] y [SEP] se sacan tokenizando un texto vacio, en vez de
    // escribirlos a mano: si el vocabulario cambiara, esto lo sigue.
    const vacio = Array.from((await tokenizador("")).input_ids.data).map(Number);
    const CLS = vacio[0];
    const SEP = vacio[vacio.length - 1];

    async function embed(texto) {
        const contenido = Array.from(
            (await tokenizador(String(texto ?? ""), { add_special_tokens: false })).input_ids.data
        ).map(Number);

        const ids = [CLS, ...contenido.slice(0, MAX_TOKENS - 2), SEP];
        const n = ids.length;
        const entrada = {
            input_ids:      new T.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, n]),
            attention_mask: new T.Tensor("int64", BigInt64Array.from(ids.map(() => 1n)), [1, n]),
            token_type_ids: new T.Tensor("int64", BigInt64Array.from(ids.map(() => 0n)), [1, n]),
        };
        const salida = await modelo(entrada);
        return promediarYNormalizar(salida.last_hidden_state, n);
    }

    return { embed, dtype, cls: CLS, sep: SEP };
}

// Mean pooling sobre todos los tokens (no hay padding: la secuencia es una sola)
// y normalizacion L2, que es lo que hace el modulo Normalize del modelo.
function promediarYNormalizar(estado, n) {
    const dim = estado.dims[2];
    const d = estado.data;
    const v = new Float64Array(dim);
    for (let t = 0; t < n; t++) {
        const base = t * dim;
        for (let k = 0; k < dim; k++) v[k] += Number(d[base + k]);
    }
    let norma = 0;
    for (let k = 0; k < dim; k++) { v[k] /= n; norma += v[k] * v[k]; }
    norma = Math.sqrt(norma) || 1;
    const out = new Array(dim);
    for (let k = 0; k < dim; k++) out[k] = v[k] / norma;
    return out;
}
