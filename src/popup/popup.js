/* popup.js — estado rápido y toggle de activación. */
(function () {
  "use strict";

  const enabledEl = document.getElementById("enabled");
  const blockCountEl = document.getElementById("block-count");
  const allowCountEl = document.getElementById("allow-count");
  const blockedTotalEl = document.getElementById("blocked-total");

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (res) =>
        resolve(res || { ok: false })
      );
    });
  }

  async function render() {
    const res = await send({ type: "getState" });
    if (!res.ok) return;
    enabledEl.checked = !(res.settings && res.settings.enabled === false);
    blockCountEl.textContent = (res.blocklist || []).length;
    allowCountEl.textContent = (res.allowlist || []).length;
    blockedTotalEl.textContent = (res.stats && res.stats.blocked) || 0;
  }

  enabledEl.addEventListener("change", async () => {
    await send({ type: "setEnabled", enabled: enabledEl.checked });
  });

  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  render();
})();
