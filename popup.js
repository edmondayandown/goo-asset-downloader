/* Google Images GIF Grabber — popup logic: live state, selectable thumbnail
 * grid, bulk download, ZIP packing, copy links, auto-scroll control.
 * Records here are already verified GIFs with their original full-size URLs. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const GG = globalThis.GG;

  let tabId = null;
  let records = [];
  let stats = { scanned: 0, gifs: 0, ignored: 0, checking: 0 };
  const selected = new Set();
  const knownKeys = new Set();
  let pollTimer = null;
  let zipBusy = false;
  let lastKeys = '';

  /* ---------------- tab / state access ---------------- */

  async function getTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch (e) {
      return null;
    }
  }

  async function fetchState() {
    if (tabId == null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'GGG_GET' });
    } catch (e) {
      return null;
    }
  }

  async function injectContent() {
    try { await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ['content.css'] }); } catch (e) {}
    try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['lib/gg-core.js', 'content.js'] }); } catch (e) {}
  }

  /* ---------------- rendering ---------------- */

  function showEmpty(text, showRetry) {
    $('#empty').classList.remove('hidden');
    $('#main').classList.add('hidden');
    $('#emptyText').textContent = text;
    $('#retryBtn').classList.toggle('hidden', !showRetry);
  }

  function showMain() {
    $('#empty').classList.add('hidden');
    $('#main').classList.remove('hidden');
  }

  function updateTermField(term) {
    const el = $('#term');
    if (document.activeElement !== el) el.value = term || '';
  }

  function syncSelection() {
    const alive = new Set(records.map((r) => r.key));
    for (const k of Array.from(selected)) if (!alive.has(k)) selected.delete(k);
    for (const k of Array.from(knownKeys)) if (!alive.has(k)) knownKeys.delete(k);
    for (const r of records) {
      if (!knownKeys.has(r.key)) {
        knownKeys.add(r.key);
        selected.add(r.key);
      }
    }
  }

  function renderGrid() {
    const grid = $('#grid');
    grid.innerHTML = '';
    if (!records.length) {
      grid.innerHTML = '<div class="grid-empty">No real GIFs found yet — scroll the results a little, or press Rescan.<br>Static JPG / PNG / WebP images are ignored automatically.</div>';
    } else {
      for (const r of records) {
        const cell = document.createElement('label');
        cell.className = 'cell' + (selected.has(r.key) ? '' : ' off');
        cell.title = r.page || r.full || '';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = r.thumb || r.full || '';
        img.alt = '';
        img.onerror = () => { img.style.visibility = 'hidden'; };
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(r.key);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(r.key);
          else selected.delete(r.key);
          cell.classList.toggle('off', !cb.checked);
          updateButtons();
        });
        cell.append(img, cb);
        grid.append(cell);
      }
    }
    updateButtons();
  }

  function renderGridIfChanged() {
    const keys = records.map((r) => r.key).join('|') + '#' + records.length;
    if (keys === lastKeys) return;
    lastKeys = keys;
    syncSelection();
    renderGrid();
  }

  function updateButtons() {
    const bits = [records.length + ' GIF' + (records.length === 1 ? '' : 's')];
    if (stats.ignored) bits.push(stats.ignored + ' ignored');
    if (stats.checking) bits.push(stats.checking + ' checking…');
    $('#countLabel').textContent = bits.join(' · ');
    $('#dlLabel').textContent = zipBusy ? 'Working…' : 'Download' + (selected.size ? ' ' + selected.size : '');
    $('#dlBtn').disabled = zipBusy;
    $('#zipBtn').disabled = zipBusy;
  }

  function renderAuto(state) {
    const t = $('#autoToggle');
    const seg = $('#modeSeg');
    t.checked = !!state.running;
    seg.classList.toggle('disabled', !!state.running);
    if (!state.running) {
      const want = state.mode === 'collect' ? 'collect' : 'grab';
      const radio = document.querySelector('input[name=mode][value="' + want + '"]');
      if (radio) radio.checked = true;
    }
    const s = $('#autoStatus');
    if (state.running) s.textContent = 'Working — ' + (state.found || 0) + ' GIFs so far · you can close this popup';
    else s.textContent = 'Off';
  }

  function showProgress(v) {
    const box = $('#progress');
    if (!v || v.phase === 'idle') {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const labelMap = {
      verifying: 'Checking images — finding the GIFs…',
      downloading: 'Downloading…',
      done: 'Complete',
      cancelled: 'Stopped'
    };
    $('#phaseLabel').textContent = labelMap[v.phase] || v.phase;
    const total = v.total || 0;
    const done = v.done || 0;
    $('#counter').textContent = total ? done + '/' + total : '';
    $('#fill').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    $('#fill').classList.toggle('ok', v.phase === 'done');
    $('#fill').classList.toggle('err', v.phase === 'cancelled');
    const bits = [];
    if (v.current) bits.push(v.current);
    if (v.ignored) bits.push(v.ignored + ' non-GIF ignored');
    if (v.skipped) bits.push(v.skipped + ' skipped');
    if (v.errors) bits.push(v.errors + ' failed');
    $('#subLabel').textContent = bits.join(' · ');
    if (v.phase === 'done' || v.phase === 'cancelled') {
      setTimeout(() => box.classList.add('hidden'), 5000);
    }
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t.__t);
    t.__t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  /* ---------------- actions ---------------- */

  function currentTermInput() {
    return $('#term').value || '';
  }

  async function downloadSelected() {
    const items = records.filter((r) => selected.has(r.key));
    if (!items.length) {
      toast('Nothing selected');
      return;
    }
    try {
      await chrome.runtime.sendMessage({ type: 'GGG_BULK', records: items, term: currentTermInput(), auto: false });
      toast('Queued ' + items.length + ' download' + (items.length === 1 ? '' : 's'));
    } catch (e) {
      toast('Failed to queue downloads');
    }
  }

  function numberNames(term, k) {
    if (k === 1) return [term + '.gif'];
    const names = [];
    for (let i = 0; i < k; i++) names.push(term + '_' + (i + 1) + '.gif');
    return names;
  }

  async function doZip() {
    if (zipBusy) return;
    const items = records.filter((r) => selected.has(r.key));
    if (!items.length) {
      toast('Nothing selected');
      return;
    }
    if (items.length > 120 && !confirm('Packing ' + items.length + ' GIFs can use a lot of memory. Continue?')) return;
    zipBusy = true;
    updateButtons();
    const term = GG.sanitizeTerm(currentTermInput() || 'google_gifs');
    try {
      showProgress({ phase: 'downloading', done: 0, total: items.length });
      const names = numberNames(term, items.length);
      const zip = new MiniZip();
      for (let i = 0; i < items.length; i++) {
        const resp = await fetch(items[i].full);
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + names[i]);
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (!GG.isGifBytes(buf)) throw new Error('No longer a GIF: ' + names[i]);
        zip.add(names[i], buf);
        showProgress({ phase: 'downloading', done: i + 1, total: items.length, current: names[i] });
      }
      const blob = zip.finish();
      const blobUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({ url: blobUrl, filename: term + '.zip', conflictAction: 'uniquify', saveAs: false });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 90000);
      showProgress({ phase: 'done', done: items.length, total: items.length });
      toast('Saved ' + term + '.zip');
    } catch (e) {
      toast('ZIP failed: ' + (e && e.message ? e.message : e));
      showProgress(null);
    } finally {
      zipBusy = false;
      updateButtons();
    }
  }

  async function copyLinks() {
    const items = records.filter((r) => selected.has(r.key));
    if (!items.length) {
      toast('Nothing selected');
      return;
    }
    try {
      await navigator.clipboard.writeText(items.map((r) => r.full).join('\n'));
      toast('Copied ' + items.length + ' link' + (items.length === 1 ? '' : 's'));
    } catch (e) {
      toast('Copy failed');
    }
  }

  /* ---------------- refresh loop ---------------- */

  async function refresh() {
    const st = await fetchState();
    if (!st) {
      const tab = await getTab();
      const host = tab && tab.url ? String(tab.url).replace(/^[a-z]+:\/\//i, '').split('/')[0].toLowerCase() : '';
      const onGoogle = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2,3})?$/.test(host);
      if (onGoogle) {
        showEmpty('GIF Grabber could not read this page. Reload the page, then click the icon again.', true);
      } else {
        showEmpty('Open a Google Images search (e.g. google.com/search?q=cats&udm=2), then click the GIF Grabber icon.', false);
      }
      return;
    }
    if (!st.active) {
      showEmpty('This is not an Images results page. Run a search and click the “Images” tab, then click the GIF Grabber icon.', false);
      return;
    }
    records = st.records || [];
    stats = st.stats || { scanned: 0, gifs: 0, ignored: 0, checking: 0 };
    showMain();
    updateTermField(st.term);
    renderGridIfChanged();
    renderAuto(st.scroll || { running: false, found: 0, mode: 'grab' });
  }

  /* ---------------- init ---------------- */

  async function init() {
    const tab = await getTab();
    tabId = tab ? tab.id : null;

    const store = await chrome.storage.local.get({ skipDupes: true });
    $('#skipDupes').checked = store.skipDupes;
    $('#skipDupes').addEventListener('change', (e) => {
      chrome.storage.local.set({ skipDupes: e.target.checked });
    });

    $('#dlBtn').addEventListener('click', downloadSelected);
    $('#zipBtn').addEventListener('click', doZip);
    $('#copyBtn').addEventListener('click', copyLinks);
    $('#rescanBtn').addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'GGG_RESCAN' });
        toast('Rescanned');
      } catch (e) {
        toast('Cannot reach this page');
      }
      refresh();
    });
    $('#retryBtn').addEventListener('click', async () => {
      await injectContent();
      setTimeout(refresh, 600);
    });
    $('#allBtn').addEventListener('click', () => {
      for (const r of records) selected.add(r.key);
      renderGrid();
    });
    $('#noneBtn').addEventListener('click', () => {
      selected.clear();
      renderGrid();
    });

    let termTimer = null;
    $('#term').addEventListener('input', (e) => {
      clearTimeout(termTimer);
      termTimer = setTimeout(() => {
        try {
          chrome.tabs.sendMessage(tabId, { type: 'GGG_SET_TERM', term: e.target.value });
        } catch (err) { /* page gone */ }
      }, 350);
    });

    $('#autoToggle').addEventListener('change', async (e) => {
      const on = e.target.checked;
      try {
        if (on) {
          const mode = (document.querySelector('input[name=mode]:checked') || {}).value || 'grab';
          try {
            await chrome.tabs.sendMessage(tabId, { type: 'GGG_SET_TERM', term: $('#term').value });
          } catch (err) { /* ignore */ }
          await chrome.tabs.sendMessage(tabId, { type: 'GGG_SCROLL_START', mode: mode });
        } else {
          await chrome.tabs.sendMessage(tabId, { type: 'GGG_SCROLL_STOP' });
        }
      } catch (err) {
        toast('Cannot control auto-scroll here');
        e.target.checked = false;
      }
      refresh();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes.ggg_progress) showProgress(changes.ggg_progress.newValue);
    });

    await refresh();
    pollTimer = setInterval(refresh, 900);
    window.addEventListener('unload', () => clearInterval(pollTimer));
  }

  init();
})();
