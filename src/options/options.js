/* options.js — ver y editar las listas guardadas. */
(function () {
  "use strict";

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
      const scopeTag = e.scope === "family" ? "Familia" : "Producto";
      meta.innerHTML =
        `<span class="tag">${scopeTag}</span>` +
        `<span class="tag">${escapeHtml(e.domain || "")}</span>` +
        (e.category ? `<span class="tag">${escapeHtml(e.category)}</span>` : "") +
        `${fmtDate(e.addedAt)}`;
      info.appendChild(name);
      info.appendChild(meta);

      const btn = document.createElement("button");
      btn.className = "remove";
      btn.title = "Quitar";
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

  async function load() {
    const res = await send({ type: "getState" });
    if (!res.ok) return;
    renderList("blocklist", res.blocklist || []);
    renderList("allowlist", res.allowlist || []);
  }

  document.getElementById("clear-all").addEventListener("click", async () => {
    if (!confirm("¿Vaciar tu lista de productos que no necesitás?")) return;
    await send({ type: "clearAll" });
    load();
  });

  // Refresca si cambia el storage en otra pestaña/navegador.
  chrome.storage.onChanged.addListener((_c, area) => {
    if (area === "sync") load();
  });

  load();
})();
