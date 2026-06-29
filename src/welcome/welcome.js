/* welcome.js — localiza la pantalla de bienvenida y cierra al confirmar. */
(function () {
  "use strict";

  function msg(key) {
    try {
      return (chrome.i18n && chrome.i18n.getMessage(key)) || key;
    } catch (_) {
      return key;
    }
  }

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const m = msg(el.getAttribute("data-i18n"));
    if (m) el.textContent = m;
  });

  const close = document.getElementById("close");
  if (close) {
    close.addEventListener("click", () => {
      window.close();
    });
  }
})();
