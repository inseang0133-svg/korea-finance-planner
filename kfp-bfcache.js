/* Back from Stripe (Checkout / Portal) with the browser's back button: Safari restores the page
 * from its back-forward cache with buttons still showing "กำลังเปิด Stripe…". Reload once so the
 * page re-reads the real plan and every button is usable again. */
window.addEventListener("pageshow", function (e) { if (e.persisted) location.reload(); });
