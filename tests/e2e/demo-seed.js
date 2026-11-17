/* Guests opening index.html are now sent to the Product Showcase (showcase.html).
 * The pre-showcase e2e suites test the live demo app as a guest, so every context they create
 * opens it the way the showcase's "ลองแอปจริง" link does (sessionStorage kfp_demo=1).
 * phase19 does NOT load this file: it tests the routing itself. */
const pw = require("playwright");
const SEED = () => { try { sessionStorage.setItem("kfp_demo", "1"); } catch (_) {} };
const origLaunch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = async (...a) => {
  const browser = await origLaunch(...a);
  const newContext = browser.newContext.bind(browser), newPage = browser.newPage.bind(browser);
  browser.newContext = async (...o) => { const ctx = await newContext(...o); await ctx.addInitScript(SEED); return ctx; };
  browser.newPage = async (...o) => { const p = await newPage(...o); await p.context().addInitScript(SEED); return p; };
  return browser;
};
