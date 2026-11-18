/* PLANNER icons — custom SVG set (assets/icons/planner-icons.svg) instead of emoji.
 * Load in <head> before other scripts:
 *   window.PI(name, extraClass) → '<svg class="pi">…</svg>' markup for new UI code
 *   Display layer: known emoji in rendered UI text are swapped for the matching icon (buttons, headings, chips…).
 *   Only what is shown changes — stored data (e.g. an allocation card's emoji), input values, <option> values
 *   and every calculation stay exactly as they were. Unknown emoji are left alone. */
(function () {
  "use strict";
  if (window.PI) return;
  var U = "assets/icons/planner-icons.svg", NS = "http://www.w3.org/2000/svg", XL = "http://www.w3.org/1999/xlink";
  window.PI = function (n, c) { return '<svg class="pi' + (c ? " " + c : "") + '" aria-hidden="true" focusable="false"><use href="' + U + "#pi-" + n + '"/></svg>'; };

  var MAP = {
    "🏠": "home", "🏡": "home", "🪙": "gold", "🥇": "medal", "🥈": "medal", "🥉": "medal", "🏆": "medal", "🏅": "medal",
    "💳": "card", "👤": "user", "👥": "user", "➕": "plus", "➖": "minus", "🧾": "receipt", "📝": "edit", "✏": "edit", "✎": "edit",
    "💸": "expense", "👛": "expense", "🗂": "attendance", "📅": "calendar", "📆": "calendar", "🗓": "calendar",
    "💵": "salary", "💰": "salary", "💴": "salary", "🔄": "refresh", "↻": "refresh", "↺": "refresh", "♻": "refresh",
    "📊": "chart", "📈": "trend", "📉": "trend", "🥧": "pie", "📁": "download", "📥": "download", "📤": "upload",
    "⚙": "sliders", "🔧": "sliders", "⚖": "sliders", "🔒": "lock", "🔐": "lock", "⛔": "lock", "💎": "crown", "👑": "crown",
    "🔁": "transfer", "⇄": "transfer", "🏪": "store", "🛒": "cart", "🎯": "target", "🌐": "globe",
    "❌": "close", "✕": "close", "✖": "close", "✅": "check", "✔": "check", "🗑": "trash", "🧹": "trash", "🗄": "archive", "📦": "archive",
    "🔔": "bell", "⏰": "bell", "✨": "sparkle", "🎉": "sparkle", "🧠": "sparkle", "🛡": "shield", "🚪": "logout", "💱": "swap",
    "🏦": "bank", "🏛": "bank", "📨": "mail", "✉": "mail", "📧": "mail", "⏳": "hourglass", "⌛": "hourglass", "⏱": "clock", "🕐": "clock",
    "🏁": "flag", "🚩": "flag", "🎌": "flag", "🧮": "calculator", "🔢": "calculator", "📋": "list", "📜": "list", "ℹ": "info", "⚠": "warning",
    "💾": "save", "📌": "pin", "📍": "pin", "☁": "cloud", "🔗": "link", "📰": "news", "⛶": "expand", "🎁": "gift", "🔎": "search", "🔍": "search",
    "👀": "eye", "🧩": "grid", "🔑": "key", "📴": "offline", "⏸": "pause", "▶": "play", "🏭": "briefcase", "💼": "briefcase", "🏷": "tag",
    "🌙": "moon", "💤": "moon", "⭐": "star", "🌟": "star", "✈": "send", "🍜": "bowl", "🍚": "bowl", "🚌": "bus", "🎧": "headphones",
    "⬇": "download", "⬆": "upload", "↩": "refresh", "✓": "check", "✗": "close", "☑": "check", "⭕": "dot", "🔃": "refresh", "📲": "download", "🖨": "list", "🗃": "archive", "💬": "chat", "📣": "megaphone", "📢": "megaphone", "🎊": "sparkle", "🪪": "card", "🧧": "gift", "🔓": "lock",
    "🟢": "dot", "🔴": "dot", "🟡": "dot", "⚪": "dot", "🟠": "dot"
  };
  var TONE = { "🟢": "pi-up", "🔴": "pi-down", "🟡": "pi-warn", "🟠": "pi-warn", "⚪": "pi-off" };
  var keys = Object.keys(MAP).sort(function (a, b) { return b.length - a.length; });
  var RE = new RegExp("(" + keys.map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + ")️?", "g");
  var TEST = new RegExp(RE.source);
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, TITLE: 1 };

  var css = document.createElement("style");
  css.id = "pi-style";
  css.textContent = ".pi{width:24px;height:24px;flex:0 0 auto;display:inline-block;vertical-align:middle;overflow:visible}" +
    ".pi-e{width:1.15em;height:1.15em;vertical-align:-.2em;margin:0 .05em}" +
    ".pi-up{color:#45d99a}.pi-down{color:#ff6b7a}.pi-warn{color:#ffb84d}.pi-off{color:#8b8678}" +
    "button .pi-e,a .pi-e{--pi-duo:.22}";
  (document.head || document.documentElement).appendChild(css);

  function svgFor(e) {
    var s = document.createElementNS(NS, "svg"), u = document.createElementNS(NS, "use"), base = e.replace(/️/g, "");
    s.setAttribute("class", "pi pi-e" + (TONE[base] ? " " + TONE[base] : ""));
    s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    u.setAttribute("href", U + "#pi-" + MAP[base]); u.setAttributeNS(XL, "xlink:href", U + "#pi-" + MAP[base]);
    s.appendChild(u); return s;
  }
  function skipped(p) {
    for (var n = p; n && n.nodeType === 1; n = n.parentNode) {
      if (SKIP[n.nodeName] || n.namespaceURI === NS || n.isContentEditable || (n.hasAttribute && n.hasAttribute("data-keep-emoji"))) return true;
    }
    return false;
  }
  function swapText(t) {
    var p = t.parentNode, s = t.nodeValue;
    if (!p || !s || !TEST.test(s)) return;
    if (p.nodeName === "OPTION" || p.nodeName === "SELECT") {          // options can't hold SVG → just drop the emoji
      t.nodeValue = s.replace(RE, "").replace(/^\s+/, ""); return;
    }
    if (skipped(p)) return;
    var f = document.createDocumentFragment(), last = 0, m; RE.lastIndex = 0;
    while ((m = RE.exec(s))) {
      if (m.index > last) f.appendChild(document.createTextNode(s.slice(last, m.index)));
      f.appendChild(svgFor(m[1])); last = RE.lastIndex;
    }
    if (last < s.length) f.appendChild(document.createTextNode(s.slice(last)));
    p.replaceChild(f, t);
  }
  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) { swapText(root); return; }
    if (root.nodeType !== 1 || SKIP[root.nodeName] || root.namespaceURI === NS) return;
    if (!TEST.test(root.textContent || "")) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), list = [], n;
    while ((n = w.nextNode())) if (TEST.test(n.nodeValue)) list.push(n);
    list.forEach(swapText);
  }
  window.plannerIconize = scan;

  var queue = [], pending = false;
  function flush() { pending = false; var q = queue; queue = []; q.forEach(scan); }
  var mo = new MutationObserver(function (ms) {
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (m.type === "characterData") queue.push(m.target);
      else for (var j = 0; j < m.addedNodes.length; j++) queue.push(m.addedNodes[j]);
    }
    if (!pending && queue.length) { pending = true; (window.queueMicrotask || setTimeout)(flush); }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  if (document.body) scan(document.body);
  document.addEventListener("DOMContentLoaded", function () { scan(document.body); });
})();
