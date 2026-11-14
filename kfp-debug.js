/* Korea Finance Planner · on-screen diagnostics for pages that render blank on a device we can't inspect.
 * Off by default. Turn on with ?debug=1 in the URL (only for that load). Shows nothing sensitive:
 * no tokens, no e-mails, no data — only errors and layout state of the page. */
(function () {
  "use strict";
  if (!/[?&]debug=1(&|$)/.test(location.search)) return;
  var errs = [];
  window.addEventListener("error", function (e) {
    errs.push("error: " + (e.message || (e.target && (e.target.src || e.target.href)) || "?") + (e.filename ? " @" + e.filename.split("/").pop() + ":" + e.lineno : ""));
  }, true);
  window.addEventListener("unhandledrejection", function (e) { errs.push("promise: " + String(e.reason && (e.reason.message || e.reason)).slice(0, 160)); });
  document.addEventListener("securitypolicyviolation", function (e) { errs.push("csp: " + e.violatedDirective + " " + String(e.blockedURI).slice(0, 80)); });

  function st(sel) {
    var el = document.querySelector(sel);
    if (!el) return sel + ": (none)";
    var c = getComputedStyle(el), r = el.getBoundingClientRect();
    return sel + ": hidden=" + el.hidden + " display=" + c.display + " vis=" + c.visibility + " op=" + c.opacity +
      " pos=" + c.position + " z=" + c.zIndex + " rect=" + Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height);
  }
  function chain(x, y) {
    var el = document.elementFromPoint(x, y), out = [];
    for (var i = 0; el && i < 5; i++, el = el.parentElement) {
      var c = getComputedStyle(el);
      out.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "") + "[" + c.position + "," + c.backgroundColor + "]");
    }
    return out.join(" < ");
  }
  function show() {
    var w = innerWidth, h = innerHeight;
    var lines = [
      "UA: " + navigator.userAgent.slice(0, 140),
      "view " + w + "x" + h + " scrollY=" + Math.round(scrollY) + " docH=" + document.documentElement.scrollHeight,
      st("#gate"), st("#app"), st(".ad-top"), st("#view-overview"), st("#kfpAuthRoot"), st("#kfpAuthPanel"), st("#kfpGateFallback"), st("#drawer"), st("#cf"),
      "top-left → " + chain(40, 90),
      "center → " + chain(w / 2, h / 2),
      "html attrs: " + [].map.call(document.documentElement.attributes, function (a) { return a.name + "=" + a.value; }).join(" ").slice(0, 200),
      "errors (" + errs.length + "):"
    ].concat(errs.slice(0, 12));
    var box = document.getElementById("kfpDebugBox") || document.createElement("pre");
    box.id = "kfpDebugBox";
    box.textContent = lines.join("\n");
    box.style.cssText = "position:fixed;left:6px;right:6px;bottom:6px;max-height:70vh;overflow:auto;z-index:2147483647;margin:0;padding:10px;" +
      "font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;color:#0f0;background:rgba(0,0,0,.92);border:1px solid #0f0;border-radius:10px";
    if (!box.parentNode) document.documentElement.appendChild(box);
  }
  window.addEventListener("load", function () { setTimeout(show, 3500); setTimeout(show, 9000); });
})();
