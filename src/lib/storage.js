/*
 * storage.js — capa de almacenamiento. La usa el service worker (importScripts).
 *
 * Modelo HÍBRIDO para los productos (sortean los topes de sync):
 *   - chrome.storage.local = fuente de verdad, ilimitada (permiso
 *     unlimitedStorage). Una clave por producto: "b:<key>" / "a:<key>".
 *   - chrome.storage.sync = ESPEJO de los SYNC_MIRROR_MAX más recientes, para
 *     que las listas sigan al usuario entre navegadores. sync tiene 3 topes
 *     (512 items, 8 KB/item, 100 KB total), por eso no guardamos todo ahí.
 * Las preferencias chicas (settings, stats, hosts, dismissed, schemaVersion)
 * viven en sync (deben ser cross-device y entran de sobra).
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
  const SCHEMA_VERSION = 4;

  // Cuántos productos (los más recientes) espejamos en sync para cross-device.
  // 300 * ~250 bytes ≈ 75 KB: cómodo bajo los 100 KB / 512 items de sync.
  const SYNC_MIRROR_MAX = 300;

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

  function localRemove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
  }

  function isProductKey(k) {
    return k.startsWith(BLOCK_PREFIX) || k.startsWith(ALLOW_PREFIX);
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

  // Espejo de sync = los SYNC_MIRROR_MAX productos más recientes de local.
  // Setea solo los que cambian y borra de sync los que se cayeron del top-N.
  // Ignora errores de cuota (el local es la fuente de verdad).
  async function reconcileSyncMirror() {
    const local = await localGet(null);
    const products = Object.keys(local)
      .filter(isProductKey)
      .map((k) => [k, local[k]]);
    products.sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0));
    const keep = products.slice(0, SYNC_MIRROR_MAX);
    const keepKeys = new Set(keep.map(([k]) => k));

    const sync = await syncGet(null);
    const toRemove = Object.keys(sync).filter(
      (k) => isProductKey(k) && !keepKeys.has(k)
    );
    if (toRemove.length) await syncRemove(toRemove);

    for (const [k, entry] of keep) {
      if (JSON.stringify(sync[k]) !== JSON.stringify(entry)) {
        try {
          await syncSet({ [k]: entry });
        } catch (_) {
          /* cuota llena: el local ya tiene el dato */
        }
      }
    }
  }

  async function getAll() {
    const [local, sync] = await Promise.all([localGet(null), syncGet(null)]);
    const block = {};
    const allow = {};

    // Local manda. Lo que esté solo en sync (dispositivo nuevo) se siembra en
    // local para hidratarlo.
    for (const k of Object.keys(local)) {
      if (k.startsWith(BLOCK_PREFIX)) block[k] = local[k];
      else if (k.startsWith(ALLOW_PREFIX)) allow[k] = local[k];
    }
    const seed = {};
    for (const k of Object.keys(sync)) {
      if (k.startsWith(BLOCK_PREFIX) && !block[k]) block[k] = seed[k] = sync[k];
      else if (k.startsWith(ALLOW_PREFIX) && !allow[k]) allow[k] = seed[k] = sync[k];
    }
    if (Object.keys(seed).length) {
      try {
        await localSet(seed);
      } catch (_) {
        /* ignore */
      }
    }

    const blocklist = Object.values(block).map(rehydrate);
    const allowlist = Object.values(allow).map(rehydrate);

    // Compatibilidad: formato viejo (arrays bajo "blocklist"/"allowlist").
    if (Array.isArray(sync.blocklist)) {
      for (const e of sync.blocklist) blocklist.push(rehydrate(e));
    }
    if (Array.isArray(sync.allowlist)) {
      for (const e of sync.allowlist) allowlist.push(rehydrate(e));
    }

    blocklist.sort(bySortedTime);
    allowlist.sort(bySortedTime);

    return {
      blocklist,
      allowlist,
      settings: sync.settings || { ...DEFAULTS.settings },
      stats: normStats(sync.stats),
      hosts: Array.isArray(sync.hosts) ? sync.hosts : DEFAULT_HOSTS.slice(),
      dismissed: Array.isArray(sync.dismissed) ? sync.dismissed : [],
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
    const bk = BLOCK_PREFIX + entry.key;
    const existing = await localGet(bk);
    await localSet({ [bk]: entry });
    await localRemove(ALLOW_PREFIX + entry.key);
    // Dedupe: solo contamos y sumamos ahorro la PRIMERA vez (re-afirmar no infla).
    if (!existing[bk]) {
      const stats = normStats((await getSmall()).stats);
      const saved = { ...stats.saved };
      if (typeof sig.price === "number" && sig.price > 0) {
        const cur = sig.currency || "";
        saved[cur] = (saved[cur] || 0) + sig.price;
      }
      await syncSet({ [STATS_KEY]: { blocked: (stats.blocked || 0) + 1, saved } });
    }
    await syncRemove(ALLOW_PREFIX + entry.key);
    await reconcileSyncMirror();
    return getAll();
  }

  async function addAllow(sig, scope) {
    const entry = entryFromSignature(sig, scope);
    await localSet({ [ALLOW_PREFIX + entry.key]: entry });
    await localRemove(BLOCK_PREFIX + entry.key);
    await syncRemove(BLOCK_PREFIX + entry.key);
    await reconcileSyncMirror();
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
    await localRemove(prefix + key);
    await syncRemove(prefix + key);
    return getAll();
  }

  async function setEnabled(enabled) {
    const { settings } = await getSmall();
    await syncSet({ [SETTINGS_KEY]: { ...settings, enabled: !!enabled } });
    return getAll();
  }

  async function clearAll() {
    const [local, sync] = await Promise.all([localGet(null), syncGet(null)]);
    const lk = Object.keys(local).filter(isProductKey);
    const sk = Object.keys(sync).filter(isProductKey);
    if (lk.length) await localRemove(lk);
    await syncRemove([...sk, "blocklist", "allowlist"]); // + formato viejo
    return getAll();
  }

  // Migra el formato viejo (arrays) a una clave por producto (en sync) y borra
  // las claves viejas. Idempotente. La copia sync->local la hace migrate (v<4).
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
  async function migrate() {
    const data = await syncGet([SCHEMA_KEY]);
    const v = typeof data[SCHEMA_KEY] === "number" ? data[SCHEMA_KEY] : 0;
    if (v >= SCHEMA_VERSION) return;
    if (v < 1) await migrateLegacy();
    // v3: el cooldown se keyaba mal (por el match) y se armaba al marcar, lo que
    // suprimía el recordatorio. Limpiamos el mapa para arrancar de cero.
    if (v < 3) await localRemove(COOLDOWN_KEY);
    // v4: storage híbrido. Copiamos los productos que estaban en sync a local
    // (nueva fuente de verdad). sync queda como espejo de los recientes.
    if (v < 4) {
      const sync = await syncGet(null);
      const seed = {};
      for (const k of Object.keys(sync)) {
        if (isProductKey(k)) seed[k] = sync[k];
      }
      if (Object.keys(seed).length) {
        try {
          await localSet(seed);
        } catch (_) {
          /* ignore */
        }
      }
    }
    await syncSet({ [SCHEMA_KEY]: SCHEMA_VERSION });
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
  // Escribe en local (fuente de verdad) y, si el producto está en el espejo de
  // sync, lo actualiza ahí también. Solo si el precio cambió.
  async function recordView(sig) {
    const P = global.DontBuyProduct;
    if (!sig || !sig.key || !P || typeof sig.price !== "number") return;
    const k = ALLOW_PREFIX + sig.key;
    const data = await localGet(k);
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
    const updated = {
      ...entry,
      price: sig.price,
      currency: sig.currency || "",
      history,
    };
    await localSet({ [k]: updated });
    const sdata = await syncGet(k);
    if (sdata[k]) {
      try {
        await syncSet({ [k]: updated });
      } catch (_) {
        /* cuota: alcanza con el local */
      }
    }
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
