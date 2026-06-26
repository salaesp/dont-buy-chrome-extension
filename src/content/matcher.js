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

    if (verdict.status === "allow") {
      sendVerdict("none");
      return; // ya dijo que lo necesita
    }

    shown = true;
    const info = {
      match: verdict.match,
      reason: verdict.reason,
      score: verdict.score,
    };
    const handlers = {
      onNeed: (scope) => {
        send({ type: "addAllow", signature: stripForStorage(signature), scope });
      },
      onSkip: (scope) => {
        send({ type: "addBlock", signature: stripForStorage(signature), scope });
        // No lo necesitás => salí de la página (volvé atrás si se puede).
        goBack();
      },
    };

    // "block" (ya descartado o parecido): blur de TODA la página + cartel
    // centrado. Robusto entre sitios (no depende del layout). "unknown"
    // (producto nuevo) usa el cartel suave arriba-centrado.
    if (verdict.status === "block") {
      Banner.showBlockOverlay(verdict.status, signature, info, handlers);
      sendVerdict("block");
    } else {
      Banner.show(verdict.status, signature, info, handlers);
      sendVerdict("none"); // "unknown" no es algo que descartaste
    }
  }

  // Vuelve a la página anterior. Si no hay historial (entraste directo),
  // cae a cerrar la pestaña no es posible desde content script, así que
  // como mínimo no rompe nada.
  function goBack() {
    try {
      if (history.length > 1) history.back();
    } catch (_) {
      /* ignore */
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
