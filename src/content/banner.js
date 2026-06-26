/*
 * banner.js — UI del aviso. Se inyecta en un Shadow DOM para que el CSS del
 * sitio no lo afecte ni lo afectemos al sitio. Expone:
 *   globalThis.DontBuyBanner.show(status, signature, handlers)
 *   globalThis.DontBuyBanner.remove()
 */
(function (global) {
  "use strict";

  const HOST_ID = "dont-buy-host";

  const STYLES = `
    :host { all: initial; }
    .wrap {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      width: 340px; max-width: calc(100vw - 32px);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color: #1a1a1a;
      background: #ffffff;
      border: 1px solid #e4e4e7;
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0,0,0,.18);
      overflow: hidden;
      animation: db-in .18s ease-out;
    }
    @keyframes db-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
    .bar { height: 6px; }
    .bar.unknown { background: #f59e0b; }
    .bar.block { background: #ef4444; }
    .body { padding: 14px 16px 16px; }
    .title { font-size: 15px; font-weight: 700; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
    .msg { font-size: 13px; line-height: 1.45; color: #52525b; margin: 0 0 12px; }
    .prod { font-size: 12px; color: #71717a; margin: 0 0 12px; word-break: break-word; }
    .prod b { color: #3f3f46; font-weight: 600; }
    .row { display: flex; gap: 8px; }
    button {
      flex: 1; cursor: pointer; border-radius: 9px; padding: 9px 10px;
      font-size: 13px; font-weight: 600; border: 1px solid transparent;
      transition: filter .12s ease;
    }
    button:hover { filter: brightness(.96); }
    .need { background: #f4f4f5; color: #18181b; border-color: #e4e4e7; }
    .skip { background: #ef4444; color: #fff; }
    .close {
      position: absolute; top: 8px; right: 10px; background: transparent;
      border: none; flex: none; width: 24px; height: 24px; padding: 0;
      font-size: 18px; line-height: 1; color: #a1a1aa; cursor: pointer;
    }
    .opts { display: flex; align-items: center; gap: 6px; margin: 10px 0 0; font-size: 12px; color: #71717a; }
    .opts input { accent-color: #ef4444; }
  `;

  const COPY = {
    unknown: {
      icon: "🤔",
      title: "¿Seguro que lo necesitás?",
      msg: "Estás viendo un producto que todavía no marcaste. Tomate un segundo antes de comprar.",
    },
    block: {
      icon: "🛑",
      title: "Ya dijiste que NO lo necesitás",
      msg: "Marcaste esto (o algo de la misma familia) como innecesario. ¿De verdad cambió algo?",
    },
  };

  let hostEl = null;

  function remove() {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = null;
  }

  /**
   * @param {'unknown'|'block'} status
   * @param {object} signature
   * @param {{onNeed:(scope:string)=>void, onSkip:()=>void}} handlers
   */
  function show(status, signature, handlers) {
    remove();
    const copy = COPY[status] || COPY.unknown;

    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    const shadow = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLES;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
      <div class="bar ${status}"></div>
      <button class="close" title="Cerrar">×</button>
      <div class="body">
        <p class="title">${copy.icon} ${copy.title}</p>
        <p class="msg">${copy.msg}</p>
        <p class="prod"><b>${escapeHtml(signature.title)}</b>${
      signature.priceText
        ? ` · ${escapeHtml(signature.currency)} ${escapeHtml(
            signature.priceText
          )}`
        : ""
    }</p>
        <label class="opts">
          <input type="checkbox" class="fam" />
          Aplicar a toda la familia (${escapeHtml(
            signature.category || "productos similares"
          )})
        </label>
        <div class="row" style="margin-top:12px">
          <button class="need">Lo necesito</button>
          <button class="skip">No lo necesito</button>
        </div>
      </div>
    `;
    shadow.appendChild(wrap);

    const famCheckbox = shadow.querySelector(".fam");
    shadow.querySelector(".need").addEventListener("click", () => {
      handlers.onNeed(famCheckbox.checked ? "family" : "product");
      remove();
    });
    shadow.querySelector(".skip").addEventListener("click", () => {
      handlers.onSkip(famCheckbox.checked ? "family" : "product");
      remove();
    });
    shadow.querySelector(".close").addEventListener("click", remove);

    // Lo colgamos de <html> para sobrevivir a re-render del <body>.
    (document.documentElement || document.body).appendChild(hostEl);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c])
    );
  }

  global.DontBuyBanner = { show, remove };
})(typeof self !== "undefined" ? self : this);
