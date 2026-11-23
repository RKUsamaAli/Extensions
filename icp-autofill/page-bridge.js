// Runs in the page's own JS world so it can reach the site's jQuery /
// bootstrap-select, and see the site's alert() popups for the log.
(() => {
  document.addEventListener("icp-autofill:refresh-select", (ev) => {
    const id = ev.detail && ev.detail.id;
    const name = ev.detail && ev.detail.name;
    const sel = (id && document.getElementById(id)) || (name && document.querySelector('select[name="' + name + '"]'));
    if (!sel) return;
    try {
      const $ = window.jQuery;
      if ($ && $.fn && $.fn.selectpicker) {
        $(sel).selectpicker("val", sel.value);
        $(sel).selectpicker("refresh");
      }
      if ($) $(sel).trigger("change");
    } catch (_) {}
  });

  // Relay validation popups (e.g. "Debe introducir…") to CitaMate's log, then show them as usual.
  const origAlert = window.alert;
  window.alert = function (message) {
    try {
      document.dispatchEvent(new CustomEvent("citamate:alert", { detail: { message: String(message) } }));
    } catch (_) {}
    return origAlert.apply(this, arguments);
  };
})();
