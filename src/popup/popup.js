/* popup.js — estado rápido y toggle de activación. */
(function () {
  "use strict";

  const Product = window.DontBuyProduct;
  const enabledEl = document.getElementById("enabled");
  const blockCountEl = document.getElementById("block-count");
  const allowCountEl = document.getElementById("allow-count");
  const blockedTotalEl = document.getElementById("blocked-total");
  const siteHostEl = document.getElementById("site-host");
  const toggleSiteEl = document.getElementById("toggle-site");

  let currentHost = "";

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (res) =>
        resolve(res || { ok: false })
      );
    });
  }

  // Host de la pestaña activa (requiere activeTab, concedido al abrir el popup).
  function activeHost() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const url = tabs && tabs[0] && tabs[0].url;
          try {
            resolve(url ? new URL(url).hostname : "");
          } catch (_) {
            resolve("");
          }
        });
      } catch (_) {
        resolve("");
      }
    });
  }

  function renderSite(hosts) {
    const norm = Product ? Product.normalizeHost(currentHost) : currentHost;
    const enabled = Product
      ? Product.hostMatches(currentHost, hosts)
      : false;
    if (!norm) {
      siteHostEl.textContent = "—";
      toggleSiteEl.disabled = true;
      return;
    }
    siteHostEl.textContent = norm;
    toggleSiteEl.disabled = false;
    toggleSiteEl.textContent = enabled ? "Desactivar" : "Activar";
    toggleSiteEl.classList.toggle("on", enabled);
    toggleSiteEl.dataset.enabled = enabled ? "1" : "0";
  }

  async function render() {
    const res = await send({ type: "getState" });
    if (!res.ok) return;
    enabledEl.checked = !(res.settings && res.settings.enabled === false);
    blockCountEl.textContent = (res.blocklist || []).length;
    allowCountEl.textContent = (res.allowlist || []).length;
    blockedTotalEl.textContent = (res.stats && res.stats.blocked) || 0;
    renderSite(res.hosts || []);
  }

  enabledEl.addEventListener("change", async () => {
    await send({ type: "setEnabled", enabled: enabledEl.checked });
  });

  toggleSiteEl.addEventListener("click", async () => {
    const norm = Product ? Product.normalizeHost(currentHost) : currentHost;
    if (!norm) return;
    const enabled = toggleSiteEl.dataset.enabled === "1";
    const res = await send({
      type: enabled ? "removeHost" : "addHost",
      host: norm,
    });
    if (res.ok && res.data) renderSite(res.data.hosts || []);
  });

  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  (async () => {
    currentHost = await activeHost();
    render();
  })();
})();
