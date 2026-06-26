/*
 * sites.js — reglas específicas por tienda (Amazon, eBay, MercadoLibre, Steam).
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
        category:
          breadcrumbFrom([
            "#wayfinding-breadcrumbs_feature_div ul li a",
            "#wayfinding-breadcrumbs_container ul li a",
          ]) ||
          // Páginas sin breadcrumb (p. ej. dispositivos propios de Amazon):
          // caemos al "departamento" del nav superior.
          text("#nav-subnav a.nav-a"),
        priceText,
        currency: text(".a-price-symbol"),
        source: "site:amazon",
        confidence: 0.98,
      };
    },
    // Carrito de Amazon: cada ítem es .sc-list-item[data-asin]; el título limpio
    // está en .a-truncate-full (texto offscreen, sin "…" de truncado).
    cart() {
      const box = document.querySelector("#sc-active-cart, #activeCartViewForm");
      if (!box) return null;
      const seen = new Set();
      const items = [];
      box.querySelectorAll(".sc-list-item[data-asin]").forEach((it) => {
        const t =
          firstText(
            [".sc-product-title .a-truncate-full", ".sc-product-title"],
            it
          ) || "";
        if (t && t.length >= 4 && !seen.has(t)) {
          seen.add(t);
          items.push({ title: t });
        }
      });
      return items.length ? { items } : null;
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
    // Carrito de MELI: títulos limpios en a.poly-component__title, dentro de la
    // lista de tarjetas. El scope evita confundir recomendaciones/listados.
    cart() {
      const list = document.querySelector(
        '[data-testid="card-list"], .cl-cards-list, .cl-grouped-items__container'
      );
      if (!list) return null;
      const seen = new Set();
      const items = [];
      list.querySelectorAll(".poly-component__title").forEach((n) => {
        const t = n.textContent.replace(/\s+/g, " ").trim();
        if (t.length >= 6 && !seen.has(t)) {
          seen.add(t);
          items.push({ title: t });
        }
      });
      return items.length ? { items } : null;
    },
  };

  // ---- Steam ----------------------------------------------------------------
  // Steam muestra precios y botones "Add to Cart" en casi toda la tienda (home,
  // listados, tags, wishlist, descubrimiento). Por eso SOLO tratamos como ficha
  // las páginas de juego/DLC (/app/<id>/). El resto devuelve null y, al ser
  // tienda conocida, el detector genérico no adivina ahí.
  const steam = {
    test: (h) => /(^|\.)steampowered\./i.test(h),
    detect() {
      if (!/\/app\/\d+/.test(location.pathname)) return null;
      const title = firstText(["#appHubAppName", ".apphub_AppName"]);
      if (!title) return null;
      // Precio de la edición estándar: primer bloque de compra. (Juego gratis
      // o "próximamente" => sin precio; igual vale como ficha por el título.)
      const priceRoot =
        document.querySelector(".game_area_purchase_game") || document;
      const priceText = firstText(
        [".discount_final_price", ".game_purchase_price"],
        priceRoot
      );
      // Categoría: géneros declarados (Action, Indie) o las migas de la tienda.
      const genres = Array.from(
        document.querySelectorAll('#genresAndManufacturer a[href*="/genre/" i]')
      )
        .map((a) => a.textContent.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ");
      return {
        title,
        category: genres || breadcrumbFrom([".breadcrumbs a"]),
        priceText,
        currency: "",
        source: "site:steam",
        confidence: 0.98,
      };
    },
    // Carrito de Steam (React, clases hasheadas): cada ítem tiene un botón
    // "Remove"; las "Recommendations For You" de abajo no. Subimos desde cada
    // "Remove" hasta la tarjeta y tomamos el título del alt de la imagen de
    // cabecera (limpio). Anclar en role/texto/alt sobrevive a los rebuilds.
    cart() {
      if (!/\/cart/i.test(location.pathname)) return null;
      const seen = new Set();
      const items = [];
      const removes = Array.from(
        document.querySelectorAll('[role="button"]')
      ).filter((b) => (b.textContent || "").trim() === "Remove");
      for (const btn of removes) {
        let node = btn;
        let title = "";
        for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
          const img = node.querySelector("img[alt]");
          const alt = img && img.getAttribute("alt").trim();
          if (alt) {
            title = alt;
            break;
          }
        }
        if (title && title.length >= 2 && !seen.has(title)) {
          seen.add(title);
          items.push({ title });
        }
      }
      return items.length ? { items } : null;
    },
  };

  const RULES = [amazon, ebay, mercadolibre, steam];

  /** ¿Hay una regla específica para este host? (tienda conocida) */
  function handles(host) {
    return RULES.some((rule) => rule.test(host || location.hostname));
  }

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

  /** Aplica la regla de carrito de la tienda actual, si la tiene. */
  function detectCart() {
    const host = location.hostname;
    for (const rule of RULES) {
      if (rule.test(host) && typeof rule.cart === "function") {
        try {
          return rule.cart();
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }

  global.DontBuySites = { detect, detectCart, handles, RULES };
})(typeof self !== "undefined" ? self : this);
