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

  /** Normaliza un host: minúsculas, sin "www.", sin espacios. */
  function normalizeHost(h) {
    return String(h || "")
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");
  }

  /**
   * ¿El host actual está habilitado según la lista blanca?
   * Una entrada coincide si el host es igual, es un subdominio, o la entrada
   * es un "trozo" contenido (p. ej. "amazon." matchea "amazon.com.ar").
   * Lista vacía => no corre en ningún lado (hay que agregar sitios).
   */
  function hostMatches(hostname, list) {
    const host = normalizeHost(hostname);
    if (!host || !Array.isArray(list)) return false;
    return list.some((raw) => {
      const e = normalizeHost(raw);
      if (!e) return false;
      return host === e || host.endsWith("." + e) || host.indexOf(e) !== -1;
    });
  }

  /** Resuelve la moneda: arg explícito o símbolo en el texto. "$" solo => "". */
  function resolveCurrency(priceText, currency) {
    if (currency) return String(currency).toUpperCase().trim();
    const t = String(priceText || "");
    if (/US\s*\$|\bUSD\b/i.test(t)) return "USD";
    if (/€|\bEUR\b/i.test(t)) return "EUR";
    if (/£|\bGBP\b/i.test(t)) return "GBP";
    if (/\bARS\b/i.test(t)) return "ARS";
    return ""; // "$" solo es ambiguo (USD/ARS/MXN): no adivinamos
  }

  /**
   * Parsea un precio de texto a centavos enteros + moneda.
   * Decimal EU/US: el separador que aparece ÚLTIMO es el decimal; el otro son
   * miles y se borra. Un único separador seguido de 3 dígitos se asume miles.
   * @returns {{amount:number, currency:string} | null}
   */
  function parsePrice(priceText, currency) {
    const cleaned = String(priceText || "").replace(/[^\d.,-]/g, "");
    if (!/\d/.test(cleaned)) return null;
    const lastDot = cleaned.lastIndexOf(".");
    const lastComma = cleaned.lastIndexOf(",");
    let numeric;
    if (lastDot === -1 && lastComma === -1) {
      numeric = cleaned;
    } else if ((lastDot === -1) !== (lastComma === -1)) {
      // un solo tipo de separador: ¿decimal o miles?
      const sep = lastDot === -1 ? "," : ".";
      const after = cleaned.slice(cleaned.lastIndexOf(sep) + 1);
      numeric =
        after.length === 3
          ? cleaned.split(sep).join("") // miles
          : cleaned.replace(sep, "."); // decimal
    } else {
      // ambos presentes: el último es el decimal, el otro son miles
      const decSep = lastDot > lastComma ? "." : ",";
      const thouSep = decSep === "." ? "," : ".";
      numeric = cleaned.split(thouSep).join("").replace(decSep, ".");
    }
    const value = parseFloat(numeric);
    if (!isFinite(value)) return null;
    return {
      amount: Math.round(value * 100),
      currency: resolveCurrency(priceText, currency),
    };
  }

  /** Formatea centavos a "11.99 USD" (o "11.99" si no hay moneda). */
  function formatMoney(cents, currency) {
    const s = ((Number(cents) || 0) / 100).toFixed(2);
    return currency ? `${s} ${currency}` : s;
  }

  /**
   * Agrega un punto al historial de precios SOLO si cambió respecto del último
   * (mismo amount+currency => devuelve el mismo array, evita escrituras). Trunca
   * a los últimos `cap`.
   */
  function appendPriceHistory(history, point, cap = 10) {
    const list = Array.isArray(history) ? history : [];
    if (!point || typeof point.amount !== "number") return list;
    const last = list[list.length - 1];
    if (last && last.amount === point.amount && last.currency === point.currency) {
      return list;
    }
    const next = list.concat([point]);
    return next.length > cap ? next.slice(next.length - cap) : next;
  }

  /**
   * Precio más barato visto, comparando SOLO dentro de la moneda del último
   * punto (no mezcla monedas). @returns {{amount,currency,url}|null}
   */
  function cheapestSeen(history) {
    const list = Array.isArray(history) ? history : [];
    if (!list.length) return null;
    const cur = list[list.length - 1].currency;
    let best = null;
    for (const p of list) {
      if (p.currency !== cur || typeof p.amount !== "number") continue;
      if (!best || p.amount < best.amount) best = p;
    }
    return best
      ? { amount: best.amount, currency: best.currency, url: best.url || "" }
      : null;
  }

  const api = {
    normalizeText,
    tokenize,
    normalizeHost,
    hostMatches,
    shortHash,
    makeKey,
    buildSignature,
    tokenOverlap,
    scoreMatch,
    isFamilyMatch,
    bestMatch,
    evaluate,
    parsePrice,
    formatMoney,
    appendPriceHistory,
    cheapestSeen,
    FAMILY_THRESHOLD,
  };

  global.DontBuyProduct = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : this);
