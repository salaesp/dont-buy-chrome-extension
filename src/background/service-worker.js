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
    hosts: data.hosts,
  };
}

// Badge POR PESTAÑA: marca "✕" rojo solo si el producto que estás viendo en
// esa tab es uno que ya descartaste. Vacío en el resto.
async function setTabBadge(tabId, status) {
  if (tabId == null) return;
  try {
    const text = status === "block" ? "✕" : "";
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#ef4444" });
    }
  } catch (_) {
    /* la tab pudo cerrarse */
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
        case "addHost":
          sendResponse({ ok: true, data: await Storage.addHost(message.host) });
          break;
        case "removeHost":
          sendResponse({
            ok: true,
            data: await Storage.removeHost(message.host),
          });
          break;
        case "pageVerdict":
          await setTabBadge(sender && sender.tab && sender.tab.id, message.status);
          sendResponse({ ok: true });
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

async function init() {
  try {
    await Storage.migrateLegacy();
  } catch (_) {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// Al navegar, limpia el badge de esa tab; el content script lo vuelve a poner
// si corresponde.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") setTabBadge(tabId, "none");
});
