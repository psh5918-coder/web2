(() => {
  'use strict';

  // These local documents share a tab, but file URLs cannot rely on web storage.
  const prefix = 'fuel-viewer:' + new URL('.', location.href).href + '\n';
  if (performance.getEntriesByType('navigation')[0]?.type === 'reload' && window.name.startsWith(prefix)) {
    window.name = '';
  }
  let state = {};
  if (window.name.startsWith(prefix)) {
    try {
      state = JSON.parse(window.name.slice(prefix.length));
    } catch {
      window.name = '';
    }
  }
  globalThis.FuelSession = {
    get(menu) { return state[menu]; },
    save(menu, selection) {
      state[menu] = selection;
      window.name = prefix + JSON.stringify(state);
    }
  };
})();
