/*
 * service-worker.js — back-end de la extensión (MV3). Es el único contexto que
 * accede a chrome.storage.sync. El content script, el popup y la página de
 * opciones se comunican con él por mensajes.
 *
 * Service worker clásico: cargamos la lógica compartida con importScripts.
 * Las rutas absolutas (con "/") se resuelven desde la raíz de la extensión.
 */
importScripts("/src/lib/product.js", "/src/lib/storage.js");

const Storage = self.DontBuyStorage;

// Estado que necesita el content script para evaluar la página.
async function getState() {
  const data = await Storage.getAll();
  return {
    ok: true,
    blocklist: data.blocklist,
    allowlist: data.allowlist,
    settings: data.settings,
    stats: data.stats,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message && message.type) {
        case "getState":
          sendResponse(await getState());
          break;
        case "addBlock":
          await Storage.addBlock(message.signature, message.scope);
          sendResponse({ ok: true });
          break;
        case "addAllow":
          await Storage.addAllow(message.signature, message.scope);
          sendResponse({ ok: true });
          break;
        case "removeItem":
          sendResponse({
            ok: true,
            data: await Storage.removeItem(message.list, message.key),
          });
          break;
        case "setEnabled":
          sendResponse({
            ok: true,
            data: await Storage.setEnabled(message.enabled),
          });
          break;
        case "clearAll":
          sendResponse({ ok: true, data: await Storage.clearAll() });
          break;
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  // Indica respuesta asíncrona.
  return true;
});

// Mantiene el badge con la cantidad de productos "no necesito".
async function refreshBadge() {
  try {
    const { blocklist } = await Storage.getAll();
    const n = blocklist.length;
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  } catch (_) {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.blocklist) refreshBadge();
});
