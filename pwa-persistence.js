/*
  iOS PWA persistence helper
  - Keeps a backup of this app's LocalStorage in IndexedDB.
  - Restores missing LocalStorage values after an iOS standalone/PWA restart.
  - Does not replace or change the gold portfolio logic.
*/
(() => {
  "use strict";

  const DB_NAME = "kfp_pwa_persistence_v1";
  const STORE = "localStorageBackup";
  const SNAPSHOT_KEY = "__all_local_storage__";
  const RESTORED_FLAG = "__kfp_pwa_restored__";
  const SNAPSHOT_MS = 1000;

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
      const req = indexedDB.open(DB_NAME, 1);
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

  function collectLocalStorage() {
    const data = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null) data[key] = localStorage.getItem(key);
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
      try { tombstones = JSON.parse(localStorage.getItem("kfp_deleted_keys_v1") || "{}"); } catch (_) {}
      for (const [key, value] of Object.entries(snapshot)) {
        // Never resurrect a finance key explicitly marked deleted by the current app.
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

  run();
})();
