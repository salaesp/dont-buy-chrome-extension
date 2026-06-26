/*
 * banner.js — UI del aviso. Se inyecta en un Shadow DOM para que el CSS del
 * sitio no lo afecte ni lo afectemos al sitio. Expone:
 *   globalThis.DontBuyBanner.show(status, signature, handlers)
 *   globalThis.DontBuyBanner.remove()
 */
(function (global) {
  "use strict";

  const HOST_ID = "dont-buy-host";

  // i18n: traduce según el idioma del navegador (en/es). Cae a la clave.
  function t(key, subs) {
    try {
      return (
        (global.chrome &&
          chrome.i18n &&
          chrome.i18n.getMessage(key, subs)) ||
        key
      );
    } catch (_) {
      return key;
    }
  }

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
    /* Primera visita: cae desde el techo (arranca despacio, acelera) y rebota
       sobre un piso imaginario. Ease-in al caer, ease-out al rebotar. */
    .wrap.bounce { animation: db-drop .95s both; }
    @keyframes db-drop {
      0%   { opacity: 0; transform: translate(-50%, -360px); animation-timing-function: cubic-bezier(.5,.04,.7,.2); }
      8%   { opacity: 1; }
      55%  { transform: translate(-50%, 0); animation-timing-function: cubic-bezier(.2,.7,.4,1); }
      70%  { transform: translate(-50%, -26px); animation-timing-function: cubic-bezier(.6,.04,.8,.2); }
      82%  { transform: translate(-50%, 0); animation-timing-function: cubic-bezier(.2,.7,.4,1); }
      90%  { transform: translate(-50%, -9px); animation-timing-function: cubic-bezier(.6,.04,.8,.2); }
      96%  { transform: translate(-50%, 0); animation-timing-function: cubic-bezier(.2,.7,.4,1); }
      98%  { transform: translate(-50%, -3px); }
      100% { transform: translate(-50%, 0); }
    }
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
    unknown: { icon: "🤔", title: t("unkTitle"), msg: t("unkMsg") },
    // status block, coincidencia exacta del mismo producto.
    block: { icon: "🛑", title: t("blockTitle"), msg: t("blockMsg") },
    // status block, parecido a algo ya descartado (familia).
    "block-family": {
      icon: "👀",
      title: t("familyTitle"),
      msg: t("familyMsg"),
    },
  };

  let hostEl = null;

  // Overlay de pantalla completa (blur de toda la página) para "block".
  let overlayEl = null;

  // Barra recordatoria arriba de todo (empuja el contenido hacia abajo).
  let topBarEl = null;
  let prevHtmlMarginTop = null;

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

  function clearTopBar() {
    if (topBarEl && topBarEl.parentNode) {
      topBarEl.parentNode.removeChild(topBarEl);
    }
    topBarEl = null;
    if (prevHtmlMarginTop !== null) {
      document.documentElement.style.marginTop = prevHtmlMarginTop;
      prevHtmlMarginTop = null;
    }
  }

  // Barra fija arriba de todo + empuja la página hacia abajo (margin en <html>).
  // Solo recordatorio, sin acciones. Se va al cambiar de página.
  function showTopReminder() {
    clearTopBar();
    const BAR_H = 40;
    topBarEl = document.createElement("div");
    topBarEl.setAttribute("data-dont-buy-bar", "1");
    const shadow = topBarEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .bar {
        position: fixed; top: 0; left: 0; right: 0; height: ${BAR_H}px;
        z-index: 2147483647;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        background: #ef4444; color: #fff;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        font-size: 13px; font-weight: 600; padding: 0 12px; box-sizing: border-box;
        box-shadow: 0 2px 10px rgba(0,0,0,.2);
        animation: db-bar .2s ease-out;
      }
      @keyframes db-bar { from { transform: translateY(-100%); } to { transform: none; } }
    `;
    shadow.appendChild(style);
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.textContent = "🛑 " + t("reminderBar");
    shadow.appendChild(bar);

    prevHtmlMarginTop = document.documentElement.style.marginTop || "";
    document.documentElement.style.marginTop = BAR_H + "px";
    (document.documentElement || document.body).appendChild(topBarEl);
  }

  // Saca todo: cartel + overlay + barra (p. ej. al cambiar de página en SPA).
  function remove() {
    removeCard();
    clearOverlay();
    clearTopBar();
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
   * @param {{confirmed?:boolean}} [opts]  si confirmed, abre ya en estado tapado
   */
  function showBlockOverlay(status, signature, info, handlers, opts) {
    clearOverlay();
    info = info || {};
    handlers = handlers || {};
    opts = opts || {};
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
              ? `<p class="like">${t("likeTo")} <b>${escapeHtml(
                  matchTitle
                )}</b>${
                  pct != null ? ` <span class="pct">(${pct}%)</span>` : ""
                }</p>`
              : ""
          }
          <label class="opts">
            <input type="checkbox" class="fam" />
            ${t("applyFamily", [
              escapeHtml(signature.category || t("similarProducts")),
            ])}
          </label>
          <div class="row" style="margin-top:14px">
            <button class="need">${t("needIt")}</button>
            <button class="skip">${t("dontNeedIt")}</button>
          </div>
          <button class="reveal">${t("seeAnyway")}</button>
        </div>
      </div>
    `;
    shadow.appendChild(scrim);

    const fam = shadow.querySelector(".fam");

    // Estado "tapado": oculta los botones de decisión y deja solo "Ver igual".
    function applyCovered() {
      const body = shadow.querySelector(".body");
      body.querySelector(".title").textContent = t("coveredTitle");
      body.querySelector(".msg").textContent = t("coveredMsg");
      const optsEl = body.querySelector(".opts");
      const rowEl = body.querySelector(".row");
      if (optsEl) optsEl.style.display = "none";
      if (rowEl) rowEl.style.display = "none";
    }

    // "Lo necesito": lo permite y revela la página.
    shadow.querySelector(".need").addEventListener("click", () => {
      if (handlers.onNeed) handlers.onNeed(fam.checked ? "family" : "product");
      clearOverlay();
    });
    // "No lo necesito": lo reafirma y DEJA la página tapada (no revela). El
    // único escape consciente queda en "Ver igual".
    shadow.querySelector(".skip").addEventListener("click", () => {
      if (handlers.onSkip) handlers.onSkip(fam.checked ? "family" : "product");
      applyCovered();
    });
    // "Ver igual": escape explícito (revela sin cambiar las listas).
    // "Ver igual": revela la página pero deja una barra recordatoria arriba.
    shadow.querySelector(".reveal").addEventListener("click", () => {
      clearOverlay();
      showTopReminder();
    });
    // Nota: tocar el fondo NO revela; la página queda tapada a propósito.

    (document.documentElement || document.body).appendChild(overlayEl);

    // Abre ya tapado (cuando recién marcaste "no lo necesito" en el banner suave).
    if (opts.confirmed) applyCovered();
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
    // Primera visita (producto nuevo) cae rebotando desde el techo.
    wrap.className = status === "unknown" ? "wrap bounce" : "wrap";
    const barClass = isFamily ? "block-family" : status;
    wrap.innerHTML = `
      <div class="bar ${barClass}"></div>
      <button class="close" title="${t("close")}">×</button>
      <div class="body">
        <p class="title">${copy.icon} ${copy.title}</p>
        <p class="msg">${copy.msg}</p>
        ${
          matchTitle
            ? `<p class="like">${t("likeTo")} <b>${escapeHtml(matchTitle)}</b>${
                pct != null ? ` <span class="pct">(${pct}%)</span>` : ""
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
          ${t("applyFamily", [
            escapeHtml(signature.category || t("similarProducts")),
          ])}
        </label>
        <div class="row" style="margin-top:12px">
          <button class="need">${t("needIt")}</button>
          <button class="skip">${t("dontNeedIt")}</button>
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
      ? t(total === 1 ? "cartItemOne" : "cartItemMany", [String(total)])
      : t("cartItemsFallback");
    wrap.innerHTML = `
      <div class="bar ${hasFlag ? "cart-flagged" : "cart"}"></div>
      <button class="close" title="${t("close")}">×</button>
      <div class="body">
        <p class="title">🧘 ${t("cartTitle")}</p>
        <p class="msg">${t("cartMsg", [items])}</p>
        ${
          hasFlag
            ? `<div class="flag">⚠️ ${t("cartFlagged")}
                <ul>${flagged
                  .slice(0, 6)
                  .map((f) => `<li>${escapeHtml(f.title)}</li>`)
                  .join("")}</ul></div>`
            : ""
        }
        <div class="row" style="margin-top:4px">
          <button class="need">${t("cartThought")}</button>
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
