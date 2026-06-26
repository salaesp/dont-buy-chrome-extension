/*
 * storage.js — única capa que toca chrome.storage.sync. La usa el service
 * worker (vía importScripts). Sincroniza con la cuenta de Google del navegador,
 * así la lista aparece en cualquier Chrome con la misma cuenta.
 *
 * Expone `globalThis.DontBuyStorage`.
 */
(function (global) {
  "use strict";

  const DEFAULTS = {
    blocklist: [],
    allowlist: [],
    settings: { enabled: true },
    stats: { blocked: 0 }, // cuántas veces el usuario dijo "no lo necesito"
  };

  function getAll() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (data) => resolve(data));
    });
  }

  function setPartial(partial) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(partial, () => resolve());
    });
  }

  function entryFromSignature(sig, scope) {
    return {
      key: sig.key,
      domain: sig.domain || "",
      title: sig.title || "",
      category: sig.category || "",
      categoryNorm: sig.categoryNorm || "",
      tokens: Array.isArray(sig.tokens) ? sig.tokens : [],
      scope: scope === "family" ? "family" : "product",
      addedAt: Date.now(),
    };
  }

  function upsert(list, entry) {
    const without = list.filter((e) => e.key !== entry.key);
    without.push(entry);
    return without;
  }

  async function addBlock(sig, scope) {
    const { blocklist, allowlist, stats } = await getAll();
    const entry = entryFromSignature(sig, scope);
    await setPartial({
      blocklist: upsert(blocklist, entry),
      // Si lo bloquea, ya no debería estar permitido.
      allowlist: allowlist.filter((e) => e.key !== entry.key),
      stats: { ...stats, blocked: (stats.blocked || 0) + 1 },
    });
    return getAll();
  }

  async function addAllow(sig, scope) {
    const { blocklist, allowlist } = await getAll();
    const entry = entryFromSignature(sig, scope);
    await setPartial({
      allowlist: upsert(allowlist, entry),
      blocklist: blocklist.filter((e) => e.key !== entry.key),
    });
    return getAll();
  }

  async function removeItem(listName, key) {
    const data = await getAll();
    if (listName !== "blocklist" && listName !== "allowlist") return data;
    await setPartial({
      [listName]: data[listName].filter((e) => e.key !== key),
    });
    return getAll();
  }

  async function setEnabled(enabled) {
    const { settings } = await getAll();
    await setPartial({ settings: { ...settings, enabled: !!enabled } });
    return getAll();
  }

  async function clearAll() {
    await setPartial({ blocklist: [], allowlist: [] });
    return getAll();
  }

  global.DontBuyStorage = {
    DEFAULTS,
    getAll,
    addBlock,
    addAllow,
    removeItem,
    setEnabled,
    clearAll,
  };
})(typeof self !== "undefined" ? self : this);
