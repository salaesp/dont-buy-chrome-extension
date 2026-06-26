/*
 * sites.js — reglas específicas por tienda (Amazon, eBay, MercadoLibre).
 * Corren ANTES que la heurística genérica del detector: son más fiables para
 * saber que estamos en una ficha de producto y para extraer título, precio y
 * categoría limpios. Si la regla no reconoce la página (no es producto),
 * devuelve null y el detector cae a las fuentes genéricas.
 *
 * Expone `globalThis.DontBuySites.detect()` -> raw | null
 * (mismo formato que las fuentes de detector.js: {title, category, priceText,
 *  currency, source, confidence}).
 */
(function (global) {
  "use strict";

  function text(sel, root) {
    const el = (root || document).querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function firstText(selectors, root) {
    for (const sel of selectors) {
      const t = text(sel, root);
      if (t) return t;
    }
    return "";
  }

  // Junta las migas del medio (saca "Inicio/Home" y el propio producto).
  function breadcrumbFrom(selectors) {
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      if (!nodes.length) continue;
      const parts = Array.from(nodes)
        .map((n) => n.textContent.replace(/\s+/g, " ").trim())
        .filter((t) => t && t.length < 40 && !/^(inicio|home|ebay)$/i.test(t));
      if (parts.length) return parts.slice(0, 4).join(" ");
    }
    return "";
  }

  // ---- Amazon ---------------------------------------------------------------
  const amazon = {
    test: (h) => /(^|\.)amazon\./i.test(h),
    detect() {
      const title = text("#productTitle");
      const isProduct =
        !!title || /\/(dp|gp\/product)\//.test(location.pathname);
      if (!isProduct) return null;
      const priceText = firstText([
        "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
        "#corePrice_feature_div .a-price .a-offscreen",
        "#corePrice_feature_div .a-offscreen",
        "span.a-price span.a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
      ]);
      return {
        title: title || text("h1 #title") || document.title,
        category: breadcrumbFrom([
          "#wayfinding-breadcrumbs_feature_div ul li a",
        ]),
        priceText,
        currency: text(".a-price-symbol"),
        source: "site:amazon",
        confidence: 0.98,
      };
    },
  };

  // ---- eBay -----------------------------------------------------------------
  const ebay = {
    test: (h) => /(^|\.)ebay\./i.test(h),
    detect() {
      const title =
        firstText([
          ".x-item-title__mainTitle .ux-textspans",
          ".x-item-title__mainTitle",
          "h1.x-item-title__mainTitle",
        ]) || text("#itemTitle").replace(/^Detalles acerca de\s*/i, "");
      const isProduct = !!title || /\/itm\//.test(location.pathname);
      if (!isProduct) return null;
      return {
        title: title || document.title,
        category: breadcrumbFrom([
          ".breadcrumbs li a",
          "nav[aria-label*='bread' i] a",
          "[class*='brw-breadcrumb'] a",
        ]),
        priceText: firstText([
          ".x-price-primary .ux-textspans",
          "[data-testid='x-price-primary'] .ux-textspans",
          "#prcIsum",
          "[itemprop='price']",
        ]),
        currency: "",
        source: "site:ebay",
        confidence: 0.98,
      };
    },
  };

  // ---- MercadoLibre / MercadoLivre ------------------------------------------
  const mercadolibre = {
    test: (h) => /(^|\.)mercado(libre|livre)\./i.test(h),
    detect() {
      const title = firstText([".ui-pdp-title", "h1.ui-pdp-title"]);
      const isProduct =
        !!title || /\/p\/ML|articulo\.|produto\./i.test(location.href);
      if (!isProduct) return null;
      // Precio: símbolo + parte entera (la fracción decimal suele ir aparte).
      const container =
        document.querySelector(".ui-pdp-price__main-container") ||
        document.querySelector(".ui-pdp-price") ||
        document;
      const symbol = text(".andes-money-amount__currency-symbol", container);
      const fraction = text(".andes-money-amount__fraction", container);
      const priceText = [symbol, fraction].filter(Boolean).join(" ").trim();
      return {
        title: title || document.title,
        category: breadcrumbFrom([
          ".andes-breadcrumb__item",
          ".andes-breadcrumb a",
        ]),
        priceText,
        currency: symbol,
        source: "site:mercadolibre",
        confidence: 0.98,
      };
    },
  };

  const RULES = [amazon, ebay, mercadolibre];

  /** Aplica la regla de la tienda actual, si hay alguna. */
  function detect() {
    const host = location.hostname;
    for (const rule of RULES) {
      if (rule.test(host)) {
        try {
          return rule.detect();
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }

  global.DontBuySites = { detect, RULES };
})(typeof self !== "undefined" ? self : this);
