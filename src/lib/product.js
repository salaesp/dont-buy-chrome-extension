/*
 * product.js — lógica pura, compartida entre content scripts, service worker,
 * popup, options y los tests. No toca el DOM ni chrome.* para poder testearse
 * de forma aislada.
 *
 * Se expone como `globalThis.DontBuyProduct` (para content scripts clásicos y
 * para importScripts en el service worker) y también como `module.exports`
 * (para los tests con node:test).
 */
(function (global) {
  "use strict";

  // Palabras vacías que no aportan a la identidad/familia de un producto.
  const STOPWORDS = new Set([
    "de", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o", "u",
    "con", "sin", "para", "por", "en", "del", "al", "the", "a", "an", "of",
    "and", "or", "for", "with", "to", "new", "nuevo", "nueva", "oferta",
    "comprar", "compra", "precio", "envio", "envío", "gratis", "original",
  ]);

  /** Minúsculas, sin acentos, sin signos, espacios colapsados. */
  function normalizeText(input) {
    if (!input) return "";
    return String(input)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // saca diacríticos
      .replace(/[^a-z0-9\s]/g, " ") // signos -> espacio
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Devuelve tokens significativos (sin stopwords ni números sueltos cortos). */
  function tokenize(input) {
    return normalizeText(input)
      .split(" ")
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  }

  /** Hash djb2 corto y estable en base36. Sirve para deduplicar entradas. */
  function shortHash(str) {
    let h = 5381;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h = (h * 33) ^ s.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  /** Clave única de un producto: dominio + título normalizado. */
  function makeKey(domain, title) {
    return shortHash(`${normalizeText(domain)}::${normalizeText(title)}`);
  }

  /**
   * Construye una "firma" canónica a partir de datos crudos del detector.
   * @param {{domain?:string,url?:string,title?:string,category?:string,
   *          priceText?:string,currency?:string,source?:string,
   *          confidence?:number}} raw
   */
  function buildSignature(raw) {
    const domain = raw.domain || "";
    const title = (raw.title || "").trim();
    const category = (raw.category || "").trim();
    return {
      key: makeKey(domain, title),
      domain,
      url: raw.url || "",
      title,
      titleNorm: normalizeText(title),
      tokens: tokenize(`${title} ${category}`),
      category,
      categoryNorm: normalizeText(category),
      priceText: raw.priceText || "",
      currency: raw.currency || "",
      source: raw.source || "",
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    };
  }

  /** Solapamiento de tokens entre dos arrays (índice de Jaccard simple). */
  function tokenOverlap(aTokens, bTokens) {
    if (!aTokens || !bTokens || !aTokens.length || !bTokens.length) return 0;
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  const FAMILY_THRESHOLD = 0.34; // ~1 de 3 tokens en común para considerar familia

  /**
   * Puntaje de parecido 0..1 entre una firma y una entrada guardada.
   *   1.0  -> mismo producto (misma key)
   *   ~0.6 -> misma categoría (familia fuerte aunque difieran los títulos)
   *   resto -> solapamiento de tokens (Jaccard)
   * Se queda con el mayor de los dos para no perder señal.
   */
  function scoreMatch(signature, entry) {
    if (!signature || !entry) return 0;
    if (signature.key && entry.key && signature.key === entry.key) return 1;
    let score = tokenOverlap(signature.tokens, entry.tokens);
    if (
      signature.categoryNorm &&
      entry.categoryNorm &&
      signature.categoryNorm === entry.categoryNorm
    ) {
      score = Math.max(score, 0.6);
    }
    return score;
  }

  /**
   * ¿La firma pertenece a la misma familia que una entrada guardada?
   * Coincide si el puntaje de parecido supera el umbral.
   */
  function isFamilyMatch(signature, entry, threshold = FAMILY_THRESHOLD) {
    return scoreMatch(signature, entry) >= threshold;
  }

  /**
   * Recorre una lista y devuelve la entrada MÁS parecida por encima del umbral.
   * @returns {{entry:object, score:number}|null}
   */
  function bestMatch(signature, list, threshold = FAMILY_THRESHOLD) {
    let best = null;
    for (const e of list || []) {
      const score = scoreMatch(signature, e);
      if (score >= threshold && (!best || score > best.score)) {
        best = { entry: e, score };
      }
    }
    return best;
  }

  /**
   * Evalúa una firma contra las listas guardadas.
   * @returns {{status:'allow'|'block'|'unknown', match?:object,
   *            reason?:'product'|'family', score?:number}}
   */
  function evaluate(signature, lists) {
    const blocklist = (lists && lists.blocklist) || [];
    const allowlist = (lists && lists.allowlist) || [];

    // 1) "Lo necesito" gana: si está permitido (exacto o por familia), no molesta.
    for (const e of allowlist) {
      if (e.key === signature.key) {
        return { status: "allow", match: e, reason: "product", score: 1 };
      }
    }
    const allowFam = bestMatch(
      signature,
      allowlist.filter((e) => e.scope === "family")
    );
    if (allowFam) {
      return {
        status: "allow",
        match: allowFam.entry,
        reason: "family",
        score: allowFam.score,
      };
    }

    // 2) "No lo necesito": bloqueo exacto o por el más parecido de la familia.
    for (const e of blocklist) {
      if (e.key === signature.key) {
        return { status: "block", match: e, reason: "product", score: 1 };
      }
    }
    const blockFam = bestMatch(signature, blocklist);
    if (blockFam) {
      return {
        status: "block",
        match: blockFam.entry,
        reason: "family",
        score: blockFam.score,
      };
    }

    return { status: "unknown" };
  }

  const api = {
    normalizeText,
    tokenize,
    shortHash,
    makeKey,
    buildSignature,
    tokenOverlap,
    scoreMatch,
    isFamilyMatch,
    bestMatch,
    evaluate,
    FAMILY_THRESHOLD,
  };

  global.DontBuyProduct = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : this);
