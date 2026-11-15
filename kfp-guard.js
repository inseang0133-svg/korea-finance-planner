/* kfp-guard.js — page behaviour shared by every page (load early, in <head>).
 *  • no pinch / double-tap / focus zoom and no sideways page scroll: pages scroll up and down only
 *    (inner tables that scroll sideways still do)
 *  • desktop: no right-click menu (except in text fields, so paste still works) and the usual
 *    developer-tools shortcuts are blocked.
 * NOTE: this only discourages casual "Inspect". Anyone can still open the browser's developer tools
 * from its menu. Security never relies on it: every permission is checked by the database (RLS / RPC)
 * and the Edge Functions. */
(function () {
  "use strict";
  if (window.__kfpGuard) return;
  window.__kfpGuard = true;
  var d = document;

  // ---- one viewport for every page: no zoom (also stops iOS zooming into small inputs) ----
  var VP = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";
  var m = d.querySelector('meta[name="viewport"]');
  if (!m) { m = d.createElement("meta"); m.name = "viewport"; (d.head || d.documentElement).appendChild(m); }
  m.setAttribute("content", VP);

  // ---- vertical scrolling only ----
  var st = d.createElement("style");
  st.id = "kfpGuardCss";
  st.textContent =
    "html{overflow-x:hidden;touch-action:pan-x pan-y;-webkit-text-size-adjust:100%;text-size-adjust:100%;overscroll-behavior-x:none}" +
    "body{overflow-x:clip;max-width:100%}" +
    "@media (hover:none) and (pointer:coarse){input,select,textarea{font-size:16px!important}}";
  (d.head || d.documentElement).appendChild(st);

  // iOS Safari ignores user-scalable=no for pinch: cancel its gesture events
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (t) {
    d.addEventListener(t, function (e) { e.preventDefault(); }, { passive: false });
  });
  // two-finger pinch that reaches the page as touchmove
  d.addEventListener("touchmove", function (e) { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  // trackpad pinch / Ctrl + mouse wheel
  window.addEventListener("wheel", function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

  // ---- right-click + developer-tools shortcuts ----
  function editable(t) {
    return !!(t && t.closest && t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]'));
  }
  d.addEventListener("contextmenu", function (e) { if (!editable(e.target)) e.preventDefault(); });
  d.addEventListener("keydown", function (e) {
    // e.code, not e.key: on a Mac, Option changes e.key ("i" → "ˆ")
    var c = String(e.code || ""), k = String(e.key || "").toLowerCase(), mod = e.ctrlKey || e.metaKey;
    var dev = c === "KeyI" || c === "KeyJ" || c === "KeyC";
    var block =
      c === "F12" || k === "f12" ||
      (mod && e.shiftKey && dev) ||                                       // Ctrl+Shift+I/J/C
      (e.metaKey && e.altKey && (dev || c === "KeyU")) ||                 // ⌘⌥I/J/C/U (Mac)
      (mod && !e.shiftKey && !e.altKey && c === "KeyU") ||                // view source
      (mod && (c === "Equal" || c === "Minus" || c === "Digit0" || c === "NumpadAdd" || c === "NumpadSubtract"));   // keyboard zoom
    if (block) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();
