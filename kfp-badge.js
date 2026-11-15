/* kfp-badge.js — role + plan badge (top-left) on index.html and gold.html.
 * Staff (owner/admin/viewer): role pill only → admin.html. Members: plan → pricing.html.
 * Reads kfpPlan.info() (kfp-access.js) and listens to "kfp:plan", so it follows the member's
 * real plan from get_my_entitlements(). Hidden for guests (preview) and while loading.
 * Display only: the role / plan shown here never grants anything. */
(function () {
  "use strict";
  if (window.__kfpBadge) return;
  window.__kfpBadge = true;

  var ROLE = { owner: ["OWNER", "gold"], admin: ["ADMIN", "gold"], viewer: ["VIEWER", "silver"] };
  var PLAN = {
    free:    { html: '<span class="kfb-text free">FREE</span>', name: "Free" },
    plus:    { html: '<span class="kfb-text plus">PLUS</span>', name: "Finance Plus" },
    premium: { html: '<span class="kfb-pill gold"><span>PREMIUM</span></span>', name: "Finance Premium" }
  };
  var box = null, last = "";

  function ensureBox() {
    if (box) return box;
    box = document.createElement("div");
    box.id = "kfpBadge";
    box.hidden = true;
    (document.body || document.documentElement).appendChild(box);
    return box;
  }

  function render(info) {
    var show = info && (info.state === "ready" || info.state === "offline") && PLAN[info.plan];
    var key = show ? info.plan + "|" + (info.adminRole || "") : "";
    if (key === last) return;
    last = key;
    var b = ensureBox();
    if (!show) { b.hidden = true; b.innerHTML = ""; return; }
    var r = ROLE[info.adminRole], p = PLAN[info.plan];
    // staff: only the role pill (their plan is always unlimited Premium) → opens the admin console
    b.innerHTML = r
      ? '<a class="kfb-plan kfb-role" href="admin.html" aria-label="บทบาท ' + r[0] + ' · เปิดหน้า Admin"><span class="kfb-pill ' + r[1] + '"><span>' + r[0] + "</span></span></a>"
      : '<a class="kfb-plan" href="pricing.html" aria-label="แพ็กเกจปัจจุบัน ' + p.name + ' · ดูหรืออัปเกรดแพ็กเกจ">' + p.html + "</a>";
    b.hidden = false;
    b.style.animation = "none"; void b.offsetWidth; b.style.animation = "";   // replay the entrance when it changes
  }

  function current() {
    try { return window.kfpPlan && window.kfpPlan.info ? window.kfpPlan.info() : null; } catch (_) { return null; }
  }
  window.addEventListener("kfp:plan", function (e) { render(e.detail || current()); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { render(current()); });
  else render(current());
})();
