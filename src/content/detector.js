/*
 * detector.js — heurística genérica para decidir si la página actual muestra
 * un producto y, en ese caso, extraer una firma. No depende de selectores por
 * sitio: usa marcado estándar (JSON-LD schema.org, OpenGraph, microdata) y
 * señales de respaldo (precio + botón de compra).
 *
 * Expone `globalThis.DontBuyDetector.detect()` -> firma | null.
 */
(function (global) {
  "use strict";

  const Product = global.DontBuyProduct;

  function getMeta(prop) {
    const el =
      document.querySelector(`meta[property="${prop}"]`) ||
      document.querySelector(`meta[name="${prop}"]`);
    return el ? el.getAttribute("content") : "";
  }

  // ---- Fuente 1: JSON-LD (la más fiable) -----------------------------------
  function fromJsonLd() {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const s of scripts) {
      let data;
      try {
        data = JSON.parse(s.textContent);
      } catch (_) {
        continue;
      }
      const nodes = flattenGraph(data);
      for (const node of nodes) {
        if (isProductType(node["@type"])) {
          return readProductNode(node);
        }
      }
    }
    return null;
  }

  function flattenGraph(data) {
    const out = [];
    const visit = (d) => {
      if (!d || typeof d !== "object") return;
      if (Array.isArray(d)) {
        d.forEach(visit);
        return;
      }
      out.push(d);
      if (Array.isArray(d["@graph"])) d["@graph"].forEach(visit);
    };
    visit(data);
    return out;
  }

  function isProductType(type) {
    if (!type) return false;
    const list = Array.isArray(type) ? type : [type];
    return list.some((t) =>
      /^(product|individualproduct|productmodel|vehicle)$/i.test(String(t))
    );
  }

  function readProductNode(node) {
    const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
    const category = Array.isArray(node.category)
      ? node.category.join(" ")
      : node.category;
    return {
      title: textOf(node.name),
      category: textOf(category) || breadcrumbCategory(),
      priceText: offers ? textOf(offers.price) : "",
      currency: offers ? textOf(offers.priceCurrency) : "",
      source: "json-ld",
      confidence: 0.95,
    };
  }

  // ---- Fuente 2: OpenGraph --------------------------------------------------
  function fromOpenGraph() {
    const ogType = (getMeta("og:type") || "").toLowerCase();
    if (!/product/.test(ogType)) return null;
    const price =
      getMeta("product:price:amount") || getMeta("og:price:amount");
    const currency =
      getMeta("product:price:currency") || getMeta("og:price:currency");
    return {
      title: getMeta("og:title") || document.title,
      category: breadcrumbCategory(),
      priceText: price || "",
      currency: currency || "",
      source: "opengraph",
      confidence: 0.85,
    };
  }

  // ---- Fuente 3: Microdata --------------------------------------------------
  function fromMicrodata() {
    const scope = document.querySelector(
      '[itemtype*="schema.org/Product" i]'
    );
    if (!scope) return null;
    const name =
      getItemProp(scope, "name") ||
      getMeta("og:title") ||
      document.title;
    const price = getItemProp(scope, "price");
    return {
      title: name,
      category: getItemProp(scope, "category") || breadcrumbCategory(),
      priceText: price || "",
      currency: getItemProp(scope, "priceCurrency") || "",
      source: "microdata",
      confidence: 0.8,
    };
  }

  function getItemProp(scope, prop) {
    const el = scope.querySelector(`[itemprop="${prop}"]`);
    if (!el) return "";
    return (
      el.getAttribute("content") ||
      el.getAttribute("value") ||
      el.textContent ||
      ""
    ).trim();
  }

  // ---- Fuente 4: heurística de respaldo (precio + botón de compra) ---------
  const BUY_RE =
    /\b(agregar al carrito|añadir al carrito|add to (cart|bag|basket)|comprar ahora|buy now|comprar)\b/i;
  const PRICE_RE = /(?:US?\$|€|£|\bARS\b|\bUSD\b|\bEUR\b)\s?\d|[\$€£]\s?\d/;

  function fromHeuristics() {
    const bodyText = (document.body && document.body.innerText) || "";
    const hasBuy =
      BUY_RE.test(bodyText) ||
      Array.from(document.querySelectorAll("button, a, input[type=submit]"))
        .slice(0, 400)
        .some((b) => BUY_RE.test(b.textContent || b.value || ""));
    const priceMatch = bodyText.match(PRICE_RE);
    if (!hasBuy || !priceMatch) return null;
    return {
      title: getMeta("og:title") || document.title,
      category: breadcrumbCategory(),
      priceText: priceMatch[0].trim(),
      currency: "",
      source: "heuristic",
      confidence: 0.5,
    };
  }

  // ---- Categoría desde breadcrumbs -----------------------------------------
  function breadcrumbCategory() {
    // BreadcrumbList JSON-LD
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const s of scripts) {
      try {
        const nodes = flattenGraph(JSON.parse(s.textContent));
        for (const n of nodes) {
          if (/breadcrumblist/i.test(String(n["@type"])) && n.itemListElement) {
            const items = n.itemListElement
              .map((it) => textOf(it.name) || textOf(it.item && it.item.name))
              .filter(Boolean);
            // Saca el último (suele ser el producto) y la home.
            const mid = items.slice(1, -1);
            if (mid.length) return mid.join(" ");
          }
        }
      } catch (_) {
        /* ignore */
      }
    }
    // Breadcrumbs en el DOM
    const nav =
      document.querySelector('nav[aria-label*="bread" i]') ||
      document.querySelector('[class*="breadcrumb" i]') ||
      document.querySelector('ol[itemtype*="BreadcrumbList" i]');
    if (nav) {
      const parts = Array.from(nav.querySelectorAll("a, li"))
        .map((e) => e.textContent.trim())
        .filter((t) => t && t.length < 40);
      const mid = parts.slice(1, -1);
      if (mid.length) return mid.join(" ");
    }
    return "";
  }

  function textOf(v) {
    if (v == null) return "";
    if (typeof v === "object") return textOf(v.name || v["@value"] || "");
    return String(v).trim();
  }

  /** Corre las fuentes en orden de fiabilidad y devuelve una firma o null. */
  function detect() {
    const raw =
      fromJsonLd() || fromOpenGraph() || fromMicrodata() || fromHeuristics();
    if (!raw || !raw.title) return null;
    const signature = Product.buildSignature({
      ...raw,
      domain: location.hostname.replace(/^www\./, ""),
      url: location.href,
    });
    // Sin título normalizado no hay identidad útil.
    if (!signature.titleNorm) return null;
    return signature;
  }

  global.DontBuyDetector = { detect };
})(typeof self !== "undefined" ? self : this);
