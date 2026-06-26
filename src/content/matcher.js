/*
 * matcher.js — punto de entrada del content script. Orquesta:
 *   1. detectar producto (detector.js)
 *   2. pedir las listas al service worker
 *   3. evaluar estado (product.js) y mostrar el banner (banner.js)
 *   4. mandar la decisión del usuario de vuelta al service worker
 *
 * Es el último archivo del array de content_scripts, así que las globales
 * DontBuyProduct / DontBuyDetector / DontBuyBanner ya existen.
 */
(function () {
  "use strict";

  const Product = self.DontBuyProduct;
  const Detector = self.DontBuyDetector;
  const Banner = self.DontBuyBanner;

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  // Le avisa al service worker qué mostrar en el badge de ESTA pestaña.
  // "block" => ✕ (el producto actual lo descartaste); "none" => limpio.
  let lastSent = null;
  function sendVerdict(status) {
    if (status === lastSent) return;
    lastSent = status;
    send({ type: "pageVerdict", status });
  }

  // Producto evaluado en esta pestaña (lo consulta el popup para ofrecer
  // "quitar de la lista"). null si la página no es una ficha.
  let lastProduct = null;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "getCurrentProduct") {
      if (lastProduct && lastProduct.status !== "unknown") {
        sendResponse({
          ok: true,
          key: lastProduct.key,
          title: lastProduct.title,
          list: lastProduct.status === "block" ? "blocklist" : "allowlist",
        });
      } else {
        sendResponse({ ok: false });
      }
    }
    // respuesta síncrona
  });

  async function run() {
    const res = await send({ type: "getState" });
    if (!res || !res.ok) return;
    if (res.settings && res.settings.enabled === false) {
      sendVerdict("none");
      return;
    }
    // Corre en todos lados SALVO los sitios que desactivaste.
    if (Product.hostMatches(location.hostname, res.dismissed)) {
      sendVerdict("none");
      return;
    }

    const signature = Detector.detect();
    const cart = signature ? null : Detector.detectCart();
    if (!signature && !cart) {
      sendVerdict("none");
      return; // ni ficha ni carrito
    }

    // Encontró producto/carrito: autoregistra el sitio en la lista (si no
    // estaba) para que aparezca en el popup y lo puedas desactivar.
    if (!Product.hostMatches(location.hostname, res.hosts)) {
      send({
        type: "addHost",
        host: Product.normalizeHost(location.hostname),
      });
    }

    // Carrito: freno suave siempre + resalte de lo ya descartado.
    if (cart) {
      const flagged = [];
      for (const item of cart.items) {
        const v = Product.evaluate(item, {
          blocklist: res.blocklist,
          allowlist: res.allowlist,
        });
        if (v.status === "block") flagged.push({ title: item.title });
      }
      shown = true;
      Banner.showCart(cart.items.length, flagged, {});
      sendVerdict(flagged.length ? "block" : "none");
      return;
    }

    const verdict = Product.evaluate(signature, {
      blocklist: res.blocklist,
      allowlist: res.allowlist,
    });

    // Recordamos el producto + su lista para el popup.
    lastProduct = {
      key: (verdict.match && verdict.match.key) || signature.key,
      title: signature.title,
      status: verdict.status,
    };

    if (verdict.status === "allow") {
      sendVerdict("allow"); // ✓ ya dijo que lo quiere
      return;
    }

    shown = true;
    const info = {
      match: verdict.match,
      reason: verdict.reason,
      score: verdict.score,
    };
    const onNeed = (scope) => {
      send({ type: "addAllow", signature: stripForStorage(signature), scope });
      lastProduct = { key: signature.key, title: signature.title, status: "allow" };
      sendVerdict("allow"); // ✓ acaba de decir que lo quiere
    };
    const addBlock = (scope) => {
      send({ type: "addBlock", signature: stripForStorage(signature), scope });
    };

    // "block" (ya descartado o parecido): blur de TODA la página + cartel
    // centrado. Robusto entre sitios (no depende del layout). "unknown"
    // (producto nuevo) usa el cartel suave arriba-centrado.
    if (verdict.status === "block") {
      // onSkip solo reafirma; el banner deja la página tapada por su cuenta.
      Banner.showBlockOverlay(verdict.status, signature, info, {
        onNeed,
        onSkip: addBlock,
      });
      sendVerdict("block");
    } else {
      // Primera vez ("unknown"): si dice "no lo necesito", lo guarda y abre el
      // MISMO cartel tapado que cuando ya estaba descartado.
      Banner.show(verdict.status, signature, info, {
        onNeed,
        onSkip: (scope) => {
          addBlock(scope);
          Banner.showBlockOverlay(
            "block",
            signature,
            { reason: scope === "family" ? "family" : "product" },
            { onNeed },
            { confirmed: true }
          );
          sendVerdict("block");
        },
      });
      sendVerdict("none"); // "unknown" no es algo que descartaste
    }
  }

  // Solo guardamos lo necesario (respeta el límite de chrome.storage.sync).
  function stripForStorage(sig) {
    return {
      key: sig.key,
      domain: sig.domain,
      title: sig.title,
      category: sig.category,
      categoryNorm: sig.categoryNorm,
      tokens: sig.tokens,
    };
  }

  // Evita correr dos veces en simultáneo y deja de reintentar cuando ya
  // mostramos algo.
  let shown = false;
  async function tick() {
    if (shown) return;
    await run();
  }

  // Muchas tiendas son SPA: el producto cambia sin recargar. Re-evaluamos al
  // detectar cambios de URL.
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      shown = false;
      Banner.remove();
      tick();
    }
  });
  observer.observe(document, { subtree: true, childList: true });

  // SPAs (Next/React) hidratan después de document_idle: el botón de compra y
  // el precio pueden no existir en el primer intento. Reintentamos un rato.
  tick();
  let tries = 0;
  const retry = setInterval(() => {
    if (shown || ++tries > 8) {
      clearInterval(retry);
      return;
    }
    tick();
  }, 700);
})();
