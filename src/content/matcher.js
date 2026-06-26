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

  async function run() {
    const signature = Detector.detect();
    if (!signature) return; // no es una ficha de producto

    const res = await send({ type: "getState" });
    if (!res || !res.ok) return;
    if (res.settings && res.settings.enabled === false) return;

    const verdict = Product.evaluate(signature, {
      blocklist: res.blocklist,
      allowlist: res.allowlist,
    });

    if (verdict.status === "allow") return; // ya dijo que lo necesita

    Banner.show(verdict.status, signature, {
      onNeed: (scope) => {
        send({ type: "addAllow", signature: stripForStorage(signature), scope });
      },
      onSkip: (scope) => {
        send({ type: "addBlock", signature: stripForStorage(signature), scope });
      },
    });
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

  // Muchas tiendas son SPA: el producto cambia sin recargar. Re-evaluamos al
  // detectar cambios de URL.
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      Banner.remove();
      run();
    }
  });
  observer.observe(document, { subtree: true, childList: true });

  run();
})();
