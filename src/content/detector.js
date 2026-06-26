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
    /\b(agregar al carrito|añadir al carrito|add to (cart|bag|basket)|comprar ahora|buy now|comprar|pre-?order|pre-?ordenar|reserve|reservar|order now|order yours|finalizar compra)\b/i;
  const PRICE_RE = /(?:US?\$|€|£|\bARS\b|\bUSD\b|\bEUR\b)\s?\d|[\$€£]\s?\d/;

  function fromHeuristics() {
    const bodyText = (document.body && document.body.innerText) || "";
    // Botones de compra REALES (controles, no texto suelto del body).
    const buyControls = Array.from(
      document.querySelectorAll("button, a, input[type=submit]")
    )
      .slice(0, 800)
      .filter((b) => BUY_RE.test(b.textContent || b.value || ""));
    // Una ficha de producto tiene 1-2 botones de compra. Una home o un
    // listado con carruseles tiene muchos: ahí NO es una ficha.
    if (buyControls.length < 1 || buyControls.length > 3) return null;

    const priceMatch = bodyText.match(PRICE_RE);
    if (!priceMatch) return null;

    // Título: exigimos un <h1> propio de la ficha. Sin él, document.title es
    // demasiado genérico (home/landing) y dispara falsos positivos.
    const h1 = document.querySelector("h1");
    const title = (h1 && h1.textContent.trim()) || "";
    if (!title) return null;

    return {
      title,
      category: breadcrumbCategory(),
      priceText: priceMatch[0].trim(),
      currency: "",
      source: "heuristic",
      confidence: 0.5,
    };
  }

  // ---- Fuente 5: estructura (tarjeta con título + precio + botón) ----------
  // Muchas tiendas modernas (Next/React) no traen JSON-LD ni og:type product y
  // usan CTAs propios ("I want one!", "Get yours"). En vez del texto del botón,
  // detectamos el patrón visual de una ficha: una tarjeta que contiene a la vez
  // un encabezado, un precio "suelto" (elemento corto) y un botón.

  // Texto del encabezado SIN badges (toma solo los nodos de texto directos,
  // así "Pebble Round 2 NEW" -> "Pebble Round 2").
  function headingText(h) {
    let t = "";
    for (const n of h.childNodes) {
      if (n.nodeType === 3) t += n.textContent;
    }
    t = t.replace(/\s+/g, " ").trim();
    return t || h.textContent.replace(/\s+/g, " ").trim();
  }

  // Busca un precio en un elemento "hoja" y corto (no un párrafo que lo menciona).
  function findPriceLeaf(root) {
    const els = root.querySelectorAll("div, span, p, b, strong, ins");
    for (const el of els) {
      if (el.children.length) continue; // solo hojas
      const t = (el.textContent || "").trim();
      if (t.length <= 14 && PRICE_RE.test(t)) return t;
    }
    return "";
  }

  function fromStructured() {
    const buttons = Array.from(
      document.querySelectorAll("button, input[type=submit], a[role='button']")
    ).slice(0, 400);

    const cards = new Set();
    const candidates = [];
    for (const btn of buttons) {
      // Sube hasta una tarjeta que tenga encabezado y precio.
      let node = btn.parentElement;
      let card = null;
      for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
        if (node.querySelector("h1, h2, h3, h4") && findPriceLeaf(node)) {
          card = node;
          break;
        }
      }
      if (!card || cards.has(card)) continue;
      cards.add(card);
      const h = card.querySelector("h1, h2, h3, h4");
      const title = h ? headingText(h) : "";
      const priceText = findPriceLeaf(card);
      if (title && priceText) candidates.push({ title, priceText });
    }

    if (!candidates.length) return null;
    // Demasiadas tarjetas = home/listado (p. ej. Amazon home). No es una ficha.
    if (cards.size > 5) return null;

    const best = candidates[0];
    return {
      title: best.title,
      category: breadcrumbCategory(),
      priceText: best.priceText,
      currency: "",
      source: "structured",
      confidence: 0.6,
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

  // Buscadores / agregadores: tienen precios y botones "comprar" en sus
  // resultados, pero NO son fichas de producto. Acá nunca usamos la heurística.
  const SEARCH_HOSTS =
    /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|startpage|brave|baidu|yandex|ask|qwant|search\.marginalia)\./i;

  function isSearchEngine() {
    return SEARCH_HOSTS.test(location.hostname);
  }

  /** Corre las fuentes en orden de fiabilidad y devuelve una firma o null. */
  function detect() {
    // Reglas por tienda (Amazon/eBay/MercadoLibre) primero; si no aplican,
    // caemos a las fuentes genéricas. En buscadores saltamos la heurística
    // (solo confiamos en marcado explícito de producto, que un SERP no trae).
    const sites = global.DontBuySites;
    const onSearch = isSearchEngine();
    // En tiendas conocidas (Amazon/eBay/MELI) confiamos SOLO en su regla: si no
    // reconoce una ficha (es un listado, el carrito, la home), no adivinamos con
    // los detectores genéricos, que ahí dan falsos positivos.
    const knownStore = !!(sites && sites.handles && sites.handles());
    const raw = knownStore
      ? sites.detect()
      : (sites && sites.detect()) ||
        fromJsonLd() ||
        fromOpenGraph() ||
        fromMicrodata() ||
        (onSearch ? null : fromStructured()) ||
        (onSearch ? null : fromHeuristics());
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

  // ---- Carrito --------------------------------------------------------------
  // El carrito es el momento de mayor impulso. No es una ficha (varios ítems),
  // así que tiene su propio camino: detectamos la página y extraemos títulos.
  const CART_URL_RE =
    /(?:^|\/)(?:cart|carrito|carro|basket|bag|cesta|checkout)(?:\/|$|\?|#)|gz\/cart/i;
  const CART_HEAD_RE =
    /\b(carrito|carro de compras|tu carrito|cart|shopping cart|cesta|bolsa de compras|basket|tu compra)\b/i;

  function looksLikeCart() {
    if (CART_URL_RE.test(location.pathname + location.search)) return true;
    const h = document.querySelector("h1, h2");
    return !!(h && CART_HEAD_RE.test(h.textContent || ""));
  }

  // Selectores de título de ítem, del más específico al más genérico. Usamos el
  // primero que devuelva algo.
  const CART_ITEM_SELECTORS = [
    '[data-testid*="cart" i] a[href], [data-testid*="item" i] a[href]',
    '[class*="cart-item" i] a, [class*="cartItem" i] a, .cart-item a',
    'li[class*="item" i] a[href], [class*="line-item" i] a[href]',
    'a[class*="title" i], a[class*="name" i]',
    '[itemprop="name"]',
  ];

  function cartItemTitles() {
    const titles = new Set();
    for (const sel of CART_ITEM_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      for (const n of nodes) {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length >= 12 && t.length <= 140) titles.add(t);
      }
      if (titles.size) break;
    }
    return Array.from(titles).slice(0, 30);
  }

  function detectCart() {
    const domain = location.hostname.replace(/^www\./, "");
    const sites = global.DontBuySites;
    const knownStore = !!(sites && sites.handles && sites.handles());

    // En tiendas conocidas usamos SOLO su regla de carrito (selectores precisos).
    // Si no reconoce un carrito ahí, no adivinamos (evita contar basura).
    if (knownStore) {
      const c = sites.detectCart ? sites.detectCart() : null;
      if (!c || !c.items || !c.items.length) return null;
      const items = c.items.map((it) =>
        Product.buildSignature({ title: it.title, domain, url: location.href })
      );
      return { isCart: true, items };
    }

    if (!looksLikeCart()) return null;
    const items = cartItemTitles().map((title) =>
      Product.buildSignature({ title, domain, url: location.href })
    );
    return { isCart: true, items };
  }

  global.DontBuyDetector = { detect, detectCart };
})(typeof self !== "undefined" ? self : this);
