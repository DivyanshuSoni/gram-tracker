/* Gram Tracker — on-device storage (IndexedDB). Everything stays on this phone. */
const DB = (() => {
  const NAME = 'gram-tracker', STORES = ['foods', 'recipes', 'vessels', 'days', 'meta'];
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!('indexedDB' in self)) return rej(new Error('no-indexeddb'));
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => { const d = r.result; STORES.forEach(s => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('blocked'));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  function run(stores, mode, fn) {
    return open().then(d => new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let req;
      try { req = fn(t); } catch (e) { rej(e); return; }
      t.oncomplete = () => res(req && 'result' in req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('aborted'));
    }));
  }
  return {
    STORES,
    all: s => run(s, 'readonly', t => t.objectStore(s).getAll()),
    get: (s, id) => run(s, 'readonly', t => t.objectStore(s).get(id)),
    put: (s, obj) => run(s, 'readwrite', t => t.objectStore(s).put(obj)),
    del: (s, id) => run(s, 'readwrite', t => t.objectStore(s).delete(id)),
    /* Replace everything (restore from backup) in one transaction: all or nothing. */
    replaceAll: data => run(STORES, 'readwrite', t => {
      STORES.forEach(n => { const st = t.objectStore(n); st.clear(); (data[n] || []).forEach(o => st.put(o)); });
    }),
    clearAll: () => run(STORES, 'readwrite', t => { STORES.forEach(n => t.objectStore(n).clear()); }),
  };
})();
