/* popup.js — estado rápido y toggle de activación. */
(function () {
  "use strict";

  const Product = window.DontBuyProduct;

  function msg(key) {
    try {
      return (chrome.i18n && chrome.i18n.getMessage(key)) || key;
    } catch (_) {
      return key;
    }
  }
  // Aplica las traducciones a los textos estáticos marcados con data-i18n.
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const m = msg(el.getAttribute("data-i18n"));
      if (m) el.textContent = m;
    });
  }

  const enabledEl = document.getElementById("enabled");
  const blockCountEl = document.getElementById("block-count");
  const allowCountEl = document.getElementById("allow-count");
  const blockedTotalEl = document.getElementById("blocked-total");
  const siteHostEl = document.getElementById("site-host");
  const toggleSiteEl = document.getElementById("toggle-site");

  const productRowEl = document.getElementById("product-row");
  const removeFromListEl = document.getElementById("remove-from-list");
  const savedRowEl = document.getElementById("saved-row");
  const savedTotalEl = document.getElementById("saved-total");

  let currentHost = "";
  let currentTabId = null;
  let currentProduct = null; // { key, list } del producto de la pestaña

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (res) =>
        resolve(res || { ok: false })
      );
    });
  }

  // Pestaña activa: host + id (requiere activeTab, concedido al abrir popup).
  function activeTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          resolve((tabs && tabs[0]) || null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  // Pregunta al content script si el producto de la pestaña está en una lista.
  function fetchCurrentProduct() {
    return new Promise((resolve) => {
      if (currentTabId == null) return resolve(null);
      try {
        chrome.tabs.sendMessage(
          currentTabId,
          { type: "getCurrentProduct" },
          (res) => {
            if (chrome.runtime.lastError || !res || !res.ok) return resolve(null);
            resolve(res);
          }
        );
      } catch (_) {
        resolve(null);
      }
    });
  }

  function renderProduct() {
    if (!currentProduct) {
      productRowEl.classList.add("hidden");
      return;
    }
    productRowEl.classList.remove("hidden");
    removeFromListEl.textContent = msg(
      currentProduct.list === "blocklist" ? "removeFromDont" : "removeFromNeed"
    );
  }

  // Activo POR DEFECTO en todos lados: el sitio solo está apagado si está en
  // la lista de desactivados.
  function renderSite(dismissed) {
    const norm = Product ? Product.normalizeHost(currentHost) : currentHost;
    if (!norm) {
      siteHostEl.textContent = "—";
      toggleSiteEl.disabled = true;
      return;
    }
    const off = Product ? Product.hostMatches(currentHost, dismissed) : false;
    siteHostEl.textContent = norm;
    toggleSiteEl.disabled = false;
    toggleSiteEl.textContent = off ? msg("activate") : msg("deactivate");
    toggleSiteEl.classList.toggle("on", !off); // rojo cuando está activo
    toggleSiteEl.dataset.off = off ? "1" : "0";
  }

  // Ahorro acumulado por moneda ("$120.00 USD · €40.00 EUR"). Oculto si no hay.
  function renderSaved(saved) {
    const entries = Object.entries(saved || {}).filter(([, c]) => c > 0);
    if (!entries.length || !Product) {
      savedRowEl.hidden = true;
      return;
    }
    const unknown = msg("currencyUnknown");
    savedTotalEl.textContent = entries
      .map(([cur, c]) => Product.formatMoney(c, cur || unknown))
      .join(" · ");
    savedRowEl.hidden = false;
  }

  async function render() {
    const res = await send({ type: "getState" });
    if (!res.ok) return;
    enabledEl.checked = !(res.settings && res.settings.enabled === false);
    blockCountEl.textContent = (res.blocklist || []).length;
    allowCountEl.textContent = (res.allowlist || []).length;
    blockedTotalEl.textContent = (res.stats && res.stats.blocked) || 0;
    renderSaved(res.stats && res.stats.saved);
    renderSite(res.dismissed || []);
  }

  enabledEl.addEventListener("change", async () => {
    await send({ type: "setEnabled", enabled: enabledEl.checked });
  });

  toggleSiteEl.addEventListener("click", async () => {
    const norm = Product ? Product.normalizeHost(currentHost) : currentHost;
    if (!norm) return;
    const off = toggleSiteEl.dataset.off === "1";
    // off => "Activar" (addHost lo saca de dismissed); si no, "Desactivar".
    const res = await send({
      type: off ? "addHost" : "removeHost",
      host: norm,
    });
    if (res.ok && res.data) renderSite(res.data.dismissed || []);
  });

  removeFromListEl.addEventListener("click", async () => {
    if (!currentProduct) return;
    await send({
      type: "removeItem",
      list: currentProduct.list,
      key: currentProduct.key,
    });
    currentProduct = null;
    renderProduct();
    render(); // refresca contadores
  });

  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  applyI18n();
  (async () => {
    const tab = await activeTab();
    currentTabId = tab && tab.id;
    try {
      currentHost = tab && tab.url ? new URL(tab.url).hostname : "";
    } catch (_) {
      currentHost = "";
    }
    render();
    currentProduct = await fetchCurrentProduct();
    renderProduct();
  })();
})();
