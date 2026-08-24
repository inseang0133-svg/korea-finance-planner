/*
  iOS PWA persistence helper
  - Keeps a backup of this app's LocalStorage in IndexedDB.
  - Restores missing LocalStorage values after an iOS standalone/PWA restart.
  - Does not replace or change the gold portfolio logic.
*/
(() => {
  "use strict";

  const DB_NAME = "kfp_pwa_persistence_v2";
  const STORE = "localStorageBackup";
  const SNAPSHOT_KEY = "__all_local_storage__";
  const RESTORED_FLAG = "__kfp_pwa_restored__";
  const SNAPSHOT_MS = 1000;
  const DELETED_KEYS = "__kfp_deleted_keys_v1";

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
  }

  function readSnapshot(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("IndexedDB read failed"));
    });
  }

  function writeSnapshot(db, snapshot) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(snapshot, SNAPSHOT_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted"));
    });
  }

  // Supabase Auth owns its own persisted session.
  // Do NOT snapshot/restore Supabase auth keys in the iOS PWA backup.
  // Otherwise an old snapshot can race with Supabase getSession() on a
  // newly-opened standalone PWA and make different pages see different sessions.
  function isAuthStorageKey(key) {
    return typeof key === "string" && (
      key.startsWith("sb-") ||
      key === "supabase.auth.token" ||
      key.includes("supabase.auth")
    );
  }

  function collectLocalStorage() {
    const data = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null && !isAuthStorageKey(key)) {
          data[key] = localStorage.getItem(key);
        }
      }
    } catch (_) {}
    return data;
  }

  function hasLocalStorageData() {
    try { return localStorage.length > 0; } catch (_) { return false; }
  }

  function restoreMissing(snapshot) {
    let restored = 0;
    if (!snapshot || typeof snapshot !== "object") return restored;
    try {
      let tombstones = {};
      try {
        const raw = localStorage.getItem(DELETED_KEYS);
        tombstones = raw ? JSON.parse(raw) : {};
      } catch (_) {}
      try {
        const snapshotDeleted = snapshot?.[DELETED_KEYS];
        const x = typeof snapshotDeleted === "string" ? JSON.parse(snapshotDeleted || "{}") : (snapshotDeleted || {});
        if (x && typeof x === "object" && !Array.isArray(x)) tombstones = { ...x, ...tombstones };
      } catch (_) {}
      for (const [key, value] of Object.entries(snapshot)) {
        // Supabase Auth owns these keys; never restore them from our PWA snapshot.
        if (isAuthStorageKey(key)) continue;
        // Explicitly deleted data must never be restored from an older snapshot.
        if (tombstones && Object.prototype.hasOwnProperty.call(tombstones, key)) continue;
        if (localStorage.getItem(key) === null) {
          localStorage.setItem(key, value);
          restored++;
        }
      }
    } catch (_) {}
    return restored;
  }

  async function run() {
    let db;
    try {
      db = await openDB();
      const snapshot = await readSnapshot(db);

      // If iOS started the standalone app with an empty/partial LocalStorage,
      // restore the saved values first, then reload once so gold.js reads them normally.
      if (snapshot && typeof snapshot === "object") {
        const wasRestored = sessionStorage.getItem(RESTORED_FLAG) === "1";
        const before = collectLocalStorage();
        const restored = restoreMissing(snapshot);
        const now = collectLocalStorage();
        const missingBefore = Object.keys(snapshot).some(k => !(k in before));
        const changed = restored > 0 && missingBefore;

        if (changed && !wasRestored) {
          try { sessionStorage.setItem(RESTORED_FLAG, "1"); } catch (_) {}
          location.reload();
          return;
        }

        if (wasRestored) {
          try { sessionStorage.removeItem(RESTORED_FLAG); } catch (_) {}
        }

        // Keep the newest current LocalStorage as the backup.
        if (Object.keys(now).length) await writeSnapshot(db, now);
      }

      const save = () => writeSnapshot(db, collectLocalStorage()).catch(() => {});
      window.__kfpPwaPersist = save;

      // LocalStorage changes in the same window do not fire the storage event,
      // so use a lightweight snapshot timer plus lifecycle flushes.
      save();
      setInterval(save, SNAPSHOT_MS);
      window.addEventListener("pagehide", save, {capture:true});
      window.addEventListener("beforeunload", save, {capture:true});
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") save();
      });
    } catch (_) {
      // If IndexedDB is unavailable, leave the original LocalStorage behavior untouched.
    }
  }

  // Expose the initialization promise so the Cloud login layer can wait
  // until PWA LocalStorage restoration is finished before applying Cloud data.
  window.__kfpPwaReady = run();
})();
