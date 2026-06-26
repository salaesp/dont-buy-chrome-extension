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
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647;
      width: 360px; max-width: calc(100vw - 32px);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color: #1a1a1a;
      background: #ffffff;
      border: 1px solid #e4e4e7;
      border-radius: 14px;
      box-shadow: 0 12px 32px rgba(0,0,0,.18);
      overflow: hidden;
      animation: db-in .18s ease-out;
    }
    @keyframes db-in { from { opacity: 0; transform: translate(-50%,-8px); } to { opacity: 1; transform: translateX(-50%); } }
    .bar { height: 6px; }
    .bar.unknown { background: #f59e0b; }
    .bar.block { background: #ef4444; }
    .bar.block-family { background: #a855f7; }
    .bar.cart { background: #0ea5e9; }
    .bar.cart-flagged { background: #ef4444; }
    .flag { font-size: 12px; color: #7f1d1d; margin: 0 0 12px; padding: 8px 10px;
      background: #fef2f2; border: 1px solid #fee2e2; border-radius: 9px; }
    .flag b { color: #b91c1c; font-weight: 600; }
    .flag ul { margin: 6px 0 0; padding-left: 16px; }
    .flag li { margin: 2px 0; word-break: break-word; }
    .like { font-size: 12px; color: #71717a; margin: 0 0 12px; padding: 8px 10px;
      background: #faf5ff; border: 1px solid #f0e6fb; border-radius: 9px; }
    .like b { color: #7e22ce; font-weight: 600; word-break: break-word; }
    .like .pct { color: #a1a1aa; }
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
    // status block, coincidencia exacta del mismo producto.
    block: {
      icon: "🛑",
      title: "Ya dijiste que NO lo necesitás",
      msg: "Marcaste exactamente este producto como innecesario. ¿De verdad cambió algo?",
    },
    // status block, parecido a algo ya descartado (familia).
    "block-family": {
      icon: "👀",
      title: "Se parece a algo que ya descartaste",
      msg: "No es idéntico, pero es muy parecido a un producto que marcaste como innecesario.",
    },
  };

  let hostEl = null;

  // Overlay de pantalla completa (blur de toda la página) para "block".
  let overlayEl = null;

  function clearOverlay() {
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
  }

  // Saca solo el cartel de esquina (no el overlay de blur).
  function removeCard() {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = null;
  }

  // Saca todo: cartel + overlay (p. ej. al cambiar de página en SPA).
  function remove() {
    removeCard();
    clearOverlay();
  }

  /**
   * "block": difumina TODA la página con un overlay y muestra un cartel
   * centrado. Independiente del layout de cada sitio. Acciones:
   *   - "Lo necesito": lo permite y revela la página.
   *   - "No lo necesito": lo reafirma y revela (sigue descartado para la próxima).
   *   - tocar el fondo / "Ver igual": revela sin cambiar las listas.
   * @param {'block'} status
   * @param {object} signature
   * @param {{match?:object, reason?:string, score?:number}} info
   * @param {{onNeed:(scope:string)=>void, onSkip:(scope:string)=>void}} handlers
   */
  function showBlockOverlay(status, signature, info, handlers) {
    clearOverlay();
    info = info || {};
    handlers = handlers || {};
    const isFamily = info.reason === "family";
    const copy = (isFamily && COPY["block-family"]) || COPY.block;
    const matchTitle =
      isFamily && info.match && info.match.title ? info.match.title : "";
    const pct =
      typeof info.score === "number" ? Math.round(info.score * 100) : null;

    overlayEl = document.createElement("div");
    overlayEl.id = HOST_ID + "-overlay";
    const shadow = overlayEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .scrim {
        position: fixed; inset: 0; z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        padding: 24px; box-sizing: border-box;
        background: rgba(17,17,17,.45);
        -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
        animation: db-fade .18s ease-out;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        cursor: pointer;
      }
      @keyframes db-fade { from { opacity: 0; } to { opacity: 1; } }
      .card {
        cursor: auto; width: 380px; max-width: calc(100vw - 48px);
        background: #fff; border-radius: 16px; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,.35); text-align: center;
        animation: db-pop .18s ease-out;
      }
      @keyframes db-pop { from { transform: scale(.96); opacity: .6; } to { transform: none; opacity: 1; } }
      .bar { height: 6px; background: ${isFamily ? "#a855f7" : "#ef4444"}; }
      .body { padding: 22px 22px 20px; color: #1a1a1a; }
      .icon { font-size: 34px; line-height: 1; }
      .title { font-size: 18px; font-weight: 700; margin: 10px 0 6px; }
      .msg { font-size: 14px; line-height: 1.5; color: #52525b; margin: 0 0 14px; }
      .prod { font-size: 13px; color: #3f3f46; font-weight: 600; word-break: break-word; margin: 0 0 4px; }
      .like { font-size: 12.5px; color: #7e22ce; margin: 0 0 14px; }
      .like .pct { color: #a1a1aa; }
      .row { display: flex; gap: 8px; }
      button { flex: 1; cursor: pointer; border-radius: 10px; padding: 11px 10px;
        font-size: 14px; font-weight: 600; border: 1px solid transparent; }
      button:hover { filter: brightness(.97); }
      .need { background: #f4f4f5; color: #18181b; border-color: #e4e4e7; }
      .skip { background: #ef4444; color: #fff; }
      .opts { display: flex; align-items: center; justify-content: center; gap: 6px;
        margin: 12px 0 0; font-size: 12px; color: #71717a; }
      .opts input { accent-color: #ef4444; }
      .reveal { background: none; border: none; color: #a1a1aa; font-size: 12px;
        cursor: pointer; margin-top: 12px; text-decoration: underline; }
    `;
    shadow.appendChild(style);

    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = `
      <div class="card">
        <div class="bar"></div>
        <div class="body">
          <div class="icon">${copy.icon}</div>
          <p class="title">${copy.title}</p>
          <p class="msg">${copy.msg}</p>
          <p class="prod">${escapeHtml(signature.title)}</p>
          ${
            matchTitle
              ? `<p class="like">Se parece a: <b>${escapeHtml(matchTitle)}</b>${
                  pct != null ? ` <span class="pct">(${pct}%)</span>` : ""
                }</p>`
              : ""
          }
          <label class="opts">
            <input type="checkbox" class="fam" />
            Aplicar a toda la familia (${escapeHtml(
              signature.category || "productos similares"
            )})
          </label>
          <div class="row" style="margin-top:14px">
            <button class="need">Lo necesito</button>
            <button class="skip">No lo necesito</button>
          </div>
          <button class="reveal">Ver igual</button>
        </div>
      </div>
    `;
    shadow.appendChild(scrim);

    const fam = shadow.querySelector(".fam");
    shadow.querySelector(".need").addEventListener("click", () => {
      if (handlers.onNeed) handlers.onNeed(fam.checked ? "family" : "product");
      clearOverlay();
    });
    shadow.querySelector(".skip").addEventListener("click", () => {
      if (handlers.onSkip) handlers.onSkip(fam.checked ? "family" : "product");
      clearOverlay();
    });
    shadow.querySelector(".reveal").addEventListener("click", clearOverlay);
    // Tocar el fondo (fuera de la tarjeta) también revela.
    scrim.addEventListener("click", (e) => {
      if (e.target === scrim) clearOverlay();
    });

    (document.documentElement || document.body).appendChild(overlayEl);
  }

  /**
   * @param {'unknown'|'block'} status
   * @param {object} signature
   * @param {{match?:object, reason?:string, score?:number}} info
   * @param {{onNeed:(scope:string)=>void, onSkip:(scope:string)=>void}} handlers
   */
  function show(status, signature, info, handlers) {
    remove();
    info = info || {};
    // Una coincidencia por familia (parecido, no idéntico) usa otro copy.
    const isFamily = status === "block" && info.reason === "family";
    const copy = (isFamily && COPY["block-family"]) || COPY[status] || COPY.unknown;
    // El producto previo que disparó la coincidencia (si lo hay).
    const matchTitle =
      isFamily && info.match && info.match.title ? info.match.title : "";
    const pct =
      typeof info.score === "number" ? Math.round(info.score * 100) : null;

    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    const shadow = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLES;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const barClass = isFamily ? "block-family" : status;
    wrap.innerHTML = `
      <div class="bar ${barClass}"></div>
      <button class="close" title="Cerrar">×</button>
      <div class="body">
        <p class="title">${copy.icon} ${copy.title}</p>
        <p class="msg">${copy.msg}</p>
        ${
          matchTitle
            ? `<p class="like">Se parece a: <b>${escapeHtml(matchTitle)}</b>${
                pct != null ? ` <span class="pct">(${pct}% de parecido)</span>` : ""
              }</p>`
            : ""
        }
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
    // "Lo necesito" = lo permite -> revela (saca cinta + blur).
    shadow.querySelector(".need").addEventListener("click", () => {
      handlers.onNeed(famCheckbox.checked ? "family" : "product");
      clearOverlay();
      removeCard();
    });
    // "No lo necesito" = lo reafirma -> mantiene tapado, solo cierra el cartel.
    shadow.querySelector(".skip").addEventListener("click", () => {
      handlers.onSkip(famCheckbox.checked ? "family" : "product");
      removeCard();
    });
    // Cerrar el cartel NO revela el precio (sigue tapado).
    shadow.querySelector(".close").addEventListener("click", removeCard);

    // Lo colgamos de <html> para sobrevivir a re-render del <body>.
    (document.documentElement || document.body).appendChild(hostEl);
  }

  /**
   * Cartel del carrito: freno suave siempre + resalte de ítems ya descartados.
   * @param {number} total  cantidad de ítems detectados en el carrito
   * @param {Array<{title:string}>} flagged  ítems que ya estaban en "no necesito"
   * @param {{onClose?:()=>void}} handlers
   */
  function showCart(total, flagged, handlers) {
    remove();
    handlers = handlers || {};
    const hasFlag = flagged && flagged.length;

    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    const shadow = hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const items = total
      ? `${total} producto${total === 1 ? "" : "s"}`
      : "lo que tenés";
    wrap.innerHTML = `
      <div class="bar ${hasFlag ? "cart-flagged" : "cart"}"></div>
      <button class="close" title="Cerrar">×</button>
      <div class="body">
        <p class="title">🧘 Pará un segundo</p>
        <p class="msg">Estás en el carrito con ${items}. ¿De verdad necesitás todo antes de pagar?</p>
        ${
          hasFlag
            ? `<div class="flag">⚠️ Ya habías dicho que <b>NO</b> necesitabas:
                <ul>${flagged
                  .slice(0, 6)
                  .map((f) => `<li>${escapeHtml(f.title)}</li>`)
                  .join("")}</ul></div>`
            : ""
        }
        <div class="row" style="margin-top:4px">
          <button class="need">Lo pensé, sigo</button>
        </div>
      </div>
    `;
    shadow.appendChild(wrap);

    shadow.querySelector(".need").addEventListener("click", () => {
      if (handlers.onClose) handlers.onClose();
      remove();
    });
    shadow.querySelector(".close").addEventListener("click", () => {
      if (handlers.onClose) handlers.onClose();
      remove();
    });

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

  global.DontBuyBanner = {
    show,
    showCart,
    showBlockOverlay,
    clearOverlay,
    remove,
  };
})(typeof self !== "undefined" ? self : this);
