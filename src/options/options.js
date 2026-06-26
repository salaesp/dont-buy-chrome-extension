/* options.js — ver y editar las listas guardadas. */
(function () {
  "use strict";

  function msg(key) {
    try {
      return (chrome.i18n && chrome.i18n.getMessage(key)) || key;
    } catch (_) {
      return key;
    }
  }
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const m = msg(el.getAttribute("data-i18n"));
      if (m) el.textContent = m;
    });
  }

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (res) =>
        resolve(res || { ok: false })
      );
    });
  }

  function fmtDate(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleDateString();
    } catch (_) {
      return "";
    }
  }

  function renderList(listName, entries) {
    const ul = document.getElementById(listName);
    const empty = document.getElementById(
      listName === "blocklist" ? "block-empty" : "allow-empty"
    );
    const count = document.getElementById(
      listName === "blocklist" ? "block-count" : "allow-count"
    );
    ul.innerHTML = "";
    count.textContent = entries.length;
    empty.classList.toggle("hidden", entries.length > 0);

    for (const e of entries) {
      const li = document.createElement("li");
      li.className = "item";

      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = e.title || "(sin título)";
      const meta = document.createElement("div");
      meta.className = "meta";
      const scopeTag = e.scope === "family" ? msg("scopeFamily") : msg("scopeProduct");
      meta.innerHTML =
        `<span class="tag">${escapeHtml(scopeTag)}</span>` +
        `<span class="tag">${escapeHtml(e.domain || "")}</span>` +
        (e.category ? `<span class="tag">${escapeHtml(e.category)}</span>` : "") +
        `${fmtDate(e.addedAt)}`;
      info.appendChild(name);
      info.appendChild(meta);

      const btn = document.createElement("button");
      btn.className = "remove";
      btn.title = msg("removeTitle");
      btn.textContent = "×";
      btn.addEventListener("click", async () => {
        await send({ type: "removeItem", list: listName, key: e.key });
        load();
      });

      li.appendChild(info);
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function renderDismissed(dismissed) {
    const ul = document.getElementById("dismissedlist");
    const empty = document.getElementById("dismissed-empty");
    const count = document.getElementById("dismissed-count");
    ul.innerHTML = "";
    count.textContent = dismissed.length;
    empty.classList.toggle("hidden", dismissed.length > 0);

    for (const h of dismissed) {
      const li = document.createElement("li");
      li.className = "item";
      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = h;
      info.appendChild(name);

      const btn = document.createElement("button");
      btn.className = "reactivate";
      btn.textContent = msg("activate");
      btn.addEventListener("click", async () => {
        const res = await send({ type: "addHost", host: h });
        if (res.ok && res.data) renderDismissed(res.data.dismissed || []);
      });

      li.appendChild(info);
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  async function load() {
    const res = await send({ type: "getState" });
    if (!res.ok) return;
    renderList("blocklist", res.blocklist || []);
    renderList("allowlist", res.allowlist || []);
    renderDismissed(res.dismissed || []);
  }

  document.getElementById("clear-all").addEventListener("click", async () => {
    if (!confirm(msg("confirmClear"))) return;
    await send({ type: "clearAll" });
    load();
  });

  applyI18n();

  // Refresca si cambia el storage en otra pestaña/navegador.
  chrome.storage.onChanged.addListener((_c, area) => {
    if (area === "sync") load();
  });

  load();
})();
