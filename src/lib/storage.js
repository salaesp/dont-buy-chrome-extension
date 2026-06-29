/*
 * storage.js — única capa que toca chrome.storage.sync. La usa el service
 * worker (vía importScripts). Sincroniza con la cuenta de Google del navegador,
 * así la lista aparece en cualquier Chrome con la misma cuenta.
 *
 * chrome.storage.sync tiene un límite de ~8 KB POR ITEM. Por eso NO guardamos
 * la lista entera bajo una sola clave (revienta al sumar productos), sino UNA
 * CLAVE POR PRODUCTO: "b:<key>" (blocklist) y "a:<key>" (allowlist). Cada
 * entrada queda muy por debajo del límite. Sólo guardamos lo mínimo; los
 * tokens y la categoría normalizada se recalculan al leer (son derivables).
 *
 * Expone `globalThis.DontBuyStorage`.
 */
(function (global) {
  "use strict";

  const BLOCK_PREFIX = "b:";
  const ALLOW_PREFIX = "a:";
  const SETTINGS_KEY = "settings";
  const STATS_KEY = "stats";
  const HOSTS_KEY = "hosts";
  const DISMISSED_KEY = "dismissed";
  const SCHEMA_KEY = "schemaVersion";
  const SCHEMA_VERSION = 2;

  // Cooldown anti-fatiga: vive en chrome.storage.local (por dispositivo, sin
  // límite de escrituras) — un mapa {key: lastShownAt}.
  const COOLDOWN_KEY = "cooldown";
  const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 horas

  // `hosts` = sitios donde corre (semilla + autodescubiertos al encontrar
  // productos). `dismissed` = sitios que el usuario desactivó (no corre ni se
  // vuelve a autoagregar). La extensión corre en todos lados SALVO los dismissed.
  const DEFAULT_HOSTS = ["amazon.", "ebay.", "mercadolibre.", "mercadolivre."];

  const DEFAULTS = {
    settings: { enabled: true },
    // blocked = cuántas veces dijo "no lo necesito"; saved = ahorro acumulado
    // por moneda en centavos {USD: 1199, ...}.
    stats: { blocked: 0, saved: {} },
    hosts: DEFAULT_HOSTS.slice(),
    dismissed: [],
  };

  // Normaliza el objeto stats para que siempre tenga blocked y saved.
  function normStats(s) {
    const st = s && typeof s === "object" ? s : {};
    return {
      blocked: st.blocked || 0,
      saved: st.saved && typeof st.saved === "object" ? st.saved : {},
    };
  }

  function syncGet(query) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(query, (data) => resolve(data || {}));
    });
  }

  function syncSet(partial) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.set(partial, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  function syncRemove(keys) {
    return new Promise((resolve) => {
      chrome.storage.sync.remove(keys, () => resolve());
    });
  }

  // Entrada mínima a guardar. Sin tokens ni categoryNorm (se recalculan).
  function entryFromSignature(sig, scope) {
    return {
      key: sig.key,
      domain: sig.domain || "",
      title: sig.title || "",
      category: sig.category || "",
      scope: scope === "family" ? "family" : "product",
      addedAt: Date.now(),
      price: typeof sig.price === "number" ? sig.price : null, // centavos
      currency: sig.currency || "",
    };
  }

  // Reconstruye tokens/categoryNorm a partir de título + categoría.
  function rehydrate(e) {
    const P = global.DontBuyProduct;
    if (P && P.buildSignature) {
      const sig = P.buildSignature({
        domain: e.domain,
        title: e.title,
        category: e.category,
      });
      return {
        ...e,
        categoryNorm: sig.categoryNorm,
        tokens: sig.tokens,
        titleNorm: sig.titleNorm,
      };
    }
    return { ...e, categoryNorm: e.categoryNorm || "", tokens: e.tokens || [] };
  }

  function bySortedTime(a, b) {
    return (a.addedAt || 0) - (b.addedAt || 0);
  }

  async function getAll() {
    const data = await syncGet(null); // todas las claves
    const blocklist = [];
    const allowlist = [];

    for (const k of Object.keys(data)) {
      if (k.startsWith(BLOCK_PREFIX)) blocklist.push(rehydrate(data[k]));
      else if (k.startsWith(ALLOW_PREFIX)) allowlist.push(rehydrate(data[k]));
    }

    // Compatibilidad: formato viejo (arrays bajo "blocklist"/"allowlist").
    if (Array.isArray(data.blocklist)) {
      for (const e of data.blocklist) blocklist.push(rehydrate(e));
    }
    if (Array.isArray(data.allowlist)) {
      for (const e of data.allowlist) allowlist.push(rehydrate(e));
    }

    blocklist.sort(bySortedTime);
    allowlist.sort(bySortedTime);

    return {
      blocklist,
      allowlist,
      settings: data.settings || { ...DEFAULTS.settings },
      stats: normStats(data.stats),
      hosts: Array.isArray(data.hosts) ? data.hosts : DEFAULT_HOSTS.slice(),
      dismissed: Array.isArray(data.dismissed) ? data.dismissed : [],
    };
  }

  async function getSmall() {
    const data = await syncGet([
      SETTINGS_KEY,
      STATS_KEY,
      HOSTS_KEY,
      DISMISSED_KEY,
    ]);
    return {
      settings: data.settings || { ...DEFAULTS.settings },
      stats: normStats(data.stats),
      hosts: Array.isArray(data.hosts) ? data.hosts : DEFAULT_HOSTS.slice(),
      dismissed: Array.isArray(data.dismissed) ? data.dismissed : [],
    };
  }

  // Normaliza igual que product.js para no duplicar hosts.
  function normHost(h) {
    return String(h || "")
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");
  }

  // Activar un sitio: lo suma a `hosts` y lo saca de `dismissed`.
  async function addHost(host) {
    const h = normHost(host);
    if (!h) return getAll();
    const { hosts, dismissed } = await getSmall();
    const partial = {};
    if (!hosts.map(normHost).includes(h)) partial[HOSTS_KEY] = [...hosts, h];
    const nextDismissed = dismissed.filter((x) => normHost(x) !== h);
    if (nextDismissed.length !== dismissed.length) {
      partial[DISMISSED_KEY] = nextDismissed;
    }
    if (Object.keys(partial).length) await syncSet(partial);
    return getAll();
  }

  // Desactivar un sitio: lo saca de `hosts` y lo recuerda en `dismissed`
  // (para no volver a autoagregarlo).
  async function removeHost(host) {
    const h = normHost(host);
    if (!h) return getAll();
    const { hosts, dismissed } = await getSmall();
    const partial = {
      [HOSTS_KEY]: hosts.filter((x) => normHost(x) !== h),
    };
    if (!dismissed.map(normHost).includes(h)) {
      partial[DISMISSED_KEY] = [...dismissed, h];
    }
    await syncSet(partial);
    return getAll();
  }

  async function addBlock(sig, scope) {
    const entry = entryFromSignature(sig, scope);
    const k = BLOCK_PREFIX + entry.key;
    const existing = await syncGet(k);
    const partial = { [k]: entry };
    // Dedupe: solo contamos y sumamos ahorro la PRIMERA vez que se descarta
    // (re-afirmar no debe inflar las stats).
    if (!existing[k]) {
      const stats = normStats((await getSmall()).stats);
      const saved = { ...stats.saved };
      if (typeof sig.price === "number" && sig.price > 0) {
        const cur = sig.currency || "";
        saved[cur] = (saved[cur] || 0) + sig.price;
      }
      partial[STATS_KEY] = { blocked: (stats.blocked || 0) + 1, saved };
    }
    await syncSet(partial);
    // Si lo bloquea, ya no debería estar permitido.
    await syncRemove(ALLOW_PREFIX + entry.key);
    return getAll();
  }

  async function addAllow(sig, scope) {
    const entry = entryFromSignature(sig, scope);
    await syncSet({ [ALLOW_PREFIX + entry.key]: entry });
    await syncRemove(BLOCK_PREFIX + entry.key);
    return getAll();
  }

  async function removeItem(listName, key) {
    const prefix =
      listName === "blocklist"
        ? BLOCK_PREFIX
        : listName === "allowlist"
        ? ALLOW_PREFIX
        : null;
    if (!prefix) return getAll();
    await syncRemove(prefix + key);
    return getAll();
  }

  async function setEnabled(enabled) {
    const { settings } = await getSmall();
    await syncSet({ [SETTINGS_KEY]: { ...settings, enabled: !!enabled } });
    return getAll();
  }

  async function clearAll() {
    const data = await syncGet(null);
    const keys = Object.keys(data).filter(
      (k) => k.startsWith(BLOCK_PREFIX) || k.startsWith(ALLOW_PREFIX)
    );
    keys.push("blocklist", "allowlist"); // limpia formato viejo también
    await syncRemove(keys);
    return getAll();
  }

  // Migra el formato viejo (arrays) al nuevo (una clave por producto) y borra
  // las claves viejas. Idempotente: si no hay nada viejo, no hace nada.
  async function migrateLegacy() {
    const data = await syncGet(["blocklist", "allowlist"]);
    const partial = {};
    const slim = (e) => ({
      key: e.key,
      domain: e.domain || "",
      title: e.title || "",
      category: e.category || "",
      scope: e.scope === "family" ? "family" : "product",
      addedAt: e.addedAt || Date.now(),
    });
    if (Array.isArray(data.blocklist)) {
      for (const e of data.blocklist) {
        if (e && e.key) partial[BLOCK_PREFIX + e.key] = slim(e);
      }
    }
    if (Array.isArray(data.allowlist)) {
      for (const e of data.allowlist) {
        if (e && e.key) partial[ALLOW_PREFIX + e.key] = slim(e);
      }
    }
    if (!Object.keys(partial).length) return;
    // Guarda de a uno para no pasar el límite total en un solo set grande.
    for (const k of Object.keys(partial)) {
      try {
        await syncSet({ [k]: partial[k] });
      } catch (_) {
        /* ignora entradas problemáticas */
      }
    }
    await syncRemove(["blocklist", "allowlist"]);
  }

  // Versionado de esquema: idempotente y forward-safe (nunca baja de versión).
  // v2 agrega campos de precio/ahorro/historial, todos aditivos y nullable, así
  // que no requiere reescribir entradas: solo migra el formato viejo y sella.
  async function migrate() {
    const data = await syncGet([SCHEMA_KEY]);
    const v = typeof data[SCHEMA_KEY] === "number" ? data[SCHEMA_KEY] : 0;
    if (v >= SCHEMA_VERSION) return;
    if (v < 1) await migrateLegacy();
    await syncSet({ [SCHEMA_KEY]: SCHEMA_VERSION });
  }

  function localGet(query) {
    return new Promise((resolve) => {
      chrome.storage.local.get(query, (data) => resolve(data || {}));
    });
  }

  function localSet(partial) {
    return new Promise((resolve) => {
      chrome.storage.local.set(partial, () => resolve());
    });
  }

  // ¿El overlay de este producto está en cooldown (mostrado hace < 2h)?
  async function shouldCooldown(key) {
    if (!key) return false;
    const data = await localGet([COOLDOWN_KEY]);
    const map = data[COOLDOWN_KEY] || {};
    const t = map[key];
    return typeof t === "number" && Date.now() - t < COOLDOWN_MS;
  }

  // Marca que se mostró el overlay de este producto (y poda vencidos).
  async function markShown(key) {
    if (!key) return;
    const data = await localGet([COOLDOWN_KEY]);
    const map = data[COOLDOWN_KEY] || {};
    const now = Date.now();
    for (const k of Object.keys(map)) {
      if (now - map[k] >= COOLDOWN_MS) delete map[k];
    }
    map[key] = now;
    await localSet({ [COOLDOWN_KEY]: map });
  }

  // Registra un precio visto para un producto de la allowlist ("lo quiero").
  // Solo escribe si el precio cambió (evita el límite de escrituras de sync).
  async function recordView(sig) {
    const P = global.DontBuyProduct;
    if (!sig || !sig.key || !P || typeof sig.price !== "number") return;
    const k = ALLOW_PREFIX + sig.key;
    const data = await syncGet(k);
    const entry = data[k];
    if (!entry) return; // historial solo para lo que SÍ querés
    const prevHistory = entry.history || [];
    const point = {
      amount: sig.price,
      currency: sig.currency || "",
      url: String(sig.url || "").slice(0, 200), // sin query, acotado
      at: Date.now(),
    };
    const history = P.appendPriceHistory(prevHistory, point);
    if (history === prevHistory) return; // precio sin cambios: no escribimos
    await syncSet({
      [k]: { ...entry, price: sig.price, currency: sig.currency || "", history },
    });
  }

  global.DontBuyStorage = {
    DEFAULTS,
    SCHEMA_VERSION,
    getAll,
    addBlock,
    addAllow,
    removeItem,
    setEnabled,
    addHost,
    removeHost,
    clearAll,
    migrateLegacy,
    migrate,
    shouldCooldown,
    markShown,
    recordView,
  };
})(typeof self !== "undefined" ? self : this);
