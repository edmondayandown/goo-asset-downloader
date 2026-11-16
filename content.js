/* Google Images GIF Grabber — content script.
 * Scans Google Images results, collects every result's ORIGINAL image URL
 * (via /imgres links and direct image nodes), asks the background worker to
 * verify which ones are real animated GIFs (byte check), and only then adds
 * hover download buttons. Non-GIF images are simply ignored.
 * Also runs the auto-scroll engine and the on-page HUD. */
(function () {
  'use strict';
  const GG = globalThis.GG;
  if (!GG || !GG.isGoogleHost(location.hostname)) return;
  if (window.__GIGG_ACTIVE__) return;
  window.__GIGG_ACTIVE__ = true;

  /* ============ page lifecycle (Images tab can appear via soft nav) ============ */

  let app = null;          // everything lives here; null when not on an Images page
  let pageWatcherTimer = null;

  function startApp() {
    if (app) return;
    app = {
      records: new Map(),      // key -> record
      pending: new Map(),      // key -> record stub awaiting verification
      verifyTimer: null,
      termOverride: '',
      sig: pageSig(),
      scrollState: { running: false, mode: 'grab', stopFlag: false },
      hud: null,
      hudHideTimer: null,
      badgeTimer: null,
      lastBadge: -1,
      scanTimer: null,
      mo: null,
      showMoreClicked: 0
    };
    scan();
    scheduleVerify();
    app.mo = new MutationObserver(scheduleScan);
    app.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopApp() {
    if (!app) return;
    try { if (app.mo) app.mo.disconnect(); } catch (e) { /* gone */ }
    clearTimeout(app.verifyTimer);
    clearTimeout(app.scanTimer);
    clearTimeout(app.hudHideTimer);
    if (app.hud && app.hud.el && app.hud.el.isConnected) app.hud.el.remove();
    document.querySelectorAll('button.ggg-btn').forEach((b) => b.remove());
    document.querySelectorAll('.ggg-card').forEach((c) => c.classList.remove('ggg-card'));
    app = null;
    updateBadgeCount(true);
  }

  function pageSig() {
    try {
      const u = new URL(location.href);
      return (u.searchParams.get('q') || '') + '|' + (u.searchParams.get('udm') || '') + '|' + (u.searchParams.get('tbm') || '');
    } catch (e) {
      return '';
    }
  }

  pageWatcherTimer = setInterval(() => {
    const onImages = GG.isImagesResultsPage(location.href);
    if (onImages && !app) startApp();
    if (app) {
      const sig = pageSig();
      if (sig !== app.sig) {
        // different search / different tab type -> fresh start
        app.sig = sig;
        app.records.clear();
        app.pending.clear();
        app.termOverride = '';
        app.lastBadge = -1;
        document.querySelectorAll('button.ggg-btn').forEach((b) => b.remove());
        document.querySelectorAll('.ggg-card').forEach((c) => c.classList.remove('ggg-card'));
        scan();
        scheduleVerify();
      }
    }
  }, 800);

  /* ============ records ============ */

  const MAX_RECORDS = 500;

  /** Google-owned image hosts never host result originals — skip them (unless .gif). */
  function isContentImageUrl(u) {
    try {
      const url = new URL(u, location.href);
      if (!/^https?:$/i.test(url.protocol)) return false;
      const h = url.hostname.toLowerCase();
      const owned = /(^|\.)(gstatic\.com|googleusercontent\.com|google\.com|google\.[a-z]{2,3}(\.[a-z]{2,3})?)$/.test(h);
      if (owned && !GG.looksLikeGifUrl(url.href)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function ensureRecord(full, thumb, page) {
    if (!full) return null;
    const key = 'r:' + GG.fnv1a(full);
    let rec = app.records.get(key);
    if (!rec) {
      if (app.records.size >= MAX_RECORDS) return null;
      rec = { key: key, full: full, thumb: thumb || '', page: page || '', gif: null, title: 'gif' };
      app.records.set(key, rec);
      app.pending.set(key, rec);
      scheduleVerify();
      onVerifiedChanged();
    } else if (!rec.thumb && thumb) {
      rec.thumb = thumb;
    }
    return rec;
  }

  function firstTileThumb(anchor) {
    const imgs = anchor.querySelectorAll('img[src]');
    for (const im of imgs) {
      const s = im.getAttribute('src') || '';
      if (/gstatic\.com|googleusercontent\.com/i.test(s) && !GG.looksLikeGifUrl(s)) {
        const alt = im.getAttribute('alt') || '';
        return { url: s, alt: alt };
      }
    }
    return null;
  }

  function scan() {
    if (!app) return;

    // Strategy A: result tiles that link through /imgres?imgurl=...
    const tiles = document.querySelectorAll('a[href*="imgres"]');
    for (const a of tiles) {
      const parsed = GG.parseImgresHref(a.getAttribute('href') || '', location.origin);
      if (!parsed) continue;
      const t = firstTileThumb(a);
      ensureRecord(parsed.full, t ? t.url : '', parsed.page);
    }

    // Strategy B: direct image nodes with non-Google hosts (e.g. the side-panel
    // preview of an opened result, or tiles that embed the original URL).
    const imgs = document.querySelectorAll('img[src]');
    for (const im of imgs) {
      const raw = GG.normalizeImageUrl(im.getAttribute('src') || '');
      if (!raw || !isContentImageUrl(raw)) continue;
      ensureRecord(raw, raw, '');
    }

    attachVerifiedButtons();
  }

  /* ============ GIF verification (byte check via background) ============ */

  function scheduleVerify() {
    if (!app || app.verifyTimer) return;
    app.verifyTimer = setTimeout(() => {
      app.verifyTimer = null;
      flushVerify();
    }, 550);
  }

  async function flushVerify() {
    if (!app || !app.pending.size) return;
    const batch = Array.from(app.pending.values()).slice(0, 40).map((r) => ({
      key: r.key, full: r.full, thumb: r.thumb
    }));
    for (const it of batch) app.pending.delete(it.key);
    let results = null;
    try {
      results = await chrome.runtime.sendMessage({ type: 'GGG_VERIFY', items: batch });
    } catch (e) {
      results = null;
    }
    if (!app) return;
    if (results && results.ok && results.results) {
      for (const it of batch) {
        const r = results.results[it.key];
        const rec = app.records.get(it.key);
        if (!rec) continue;
        if (!r) { app.pending.set(it.key, rec); continue; } // lost in flight -> retry
        rec.gif = !!r.gif;
      }
      attachVerifiedButtons();
      onVerifiedChanged();
      scheduleVerify();
    } else {
      // worker unavailable (asleep?) -> retry soon
      for (const it of batch) {
        const rec = app.records.get(it.key);
        if (rec && rec.gif === null) app.pending.set(it.key, rec);
      }
      setTimeout(() => { if (app) scheduleVerify(); }, 2500);
    }
  }

  function verifiedGifs() {
    if (!app) return [];
    const out = [];
    for (const r of app.records.values()) {
      if (r.gif === true && r.full) out.push(r);
    }
    return out;
  }

  function onVerifiedChanged() {
    if (!app || app.badgeTimer) return;
    app.badgeTimer = setTimeout(() => {
      app.badgeTimer = null;
      updateBadgeCount(false);
    }, 350);
  }

  function updateBadgeCount(force) {
    const n = app ? verifiedGifs().length : 0;
    if (!force && n === (app ? app.lastBadge : 0)) return;
    if (app) app.lastBadge = n;
    try {
      const p = chrome.runtime.sendMessage({ type: 'GGG_COUNT', count: n });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* sw asleep */ }
  }

  /* ============ hover download buttons ============ */

  function findCard(el) {
    const a = el.closest && el.closest('a[href]');
    let card = a || el;
    for (let i = 0; i < 3 && card; i++) {
      const p = card.parentElement;
      if (!p || p === document.body) break;
      const cr = card.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      if (!pr.width || !cr.width) break;
      if (pr.width - cr.width > 24 || pr.height - cr.height > 24) break;
      card = p;
    }
    return card;
  }

  const BTN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>';

  function attachVerifiedButtons() {
    if (!app) return;
    const gifs = new Map();
    for (const r of verifiedGifs()) gifs.set(r.key, r);
    if (!gifs.size) return;

    const tiles = document.querySelectorAll('a[href*="imgres"], img[src]');
    for (const el of tiles) {
      let rec = null;
      let host = el;
      if (el.tagName === 'A') {
        const parsed = GG.parseImgresHref(el.getAttribute('href') || '', location.origin);
        if (parsed) rec = gifs.get('r:' + GG.fnv1a(parsed.full));
      } else {
        const raw = GG.normalizeImageUrl(el.getAttribute('src') || '');
        if (raw && isContentImageUrl(raw)) rec = gifs.get('r:' + GG.fnv1a(raw));
        else continue;
      }
      if (!rec) continue;
      const card = findCard(host) || host;
      if (!card || card === document.body) continue;
      if (card.querySelector(':scope > button.ggg-btn')) continue;
      card.classList.add('ggg-card');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ggg-btn';
      btn.title = 'Download original GIF';
      btn.setAttribute('aria-label', 'Download original GIF');
      btn.innerHTML = BTN_SVG;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.classList.contains('ggg-busy')) return;
        btn.classList.add('ggg-busy');
        let res = null;
        try {
          res = await chrome.runtime.sendMessage({
            type: 'GGG_ONE',
            record: Object.assign({}, rec, { term: currentTerm() })
          });
        } catch (err) { res = null; }
        btn.classList.remove('ggg-busy');
        btn.classList.add(res && res.ok ? 'ggg-ok' : 'ggg-err');
        btn.title = res && res.ok ? ('Saved as ' + res.name) : ('Failed: ' + ((res && res.error) || 'unknown'));
        setTimeout(() => btn.classList.remove('ggg-ok', 'ggg-err'), 1400);
      }, true);
      card.appendChild(btn);
      host = card;
    }
  }

  /* ============ search term ============ */

  function currentTerm() {
    if (app && app.termOverride.trim()) return app.termOverride.trim();
    return GG.termFromUrl(location.href) || 'google_gifs';
  }

  /* ============ HUD ============ */

  function ensureHud() {
    if (app.hud && app.hud.el.isConnected) return app.hud;
    const el = document.createElement('div');
    el.className = 'ggg-hud';
    el.innerHTML =
      '<svg class="ggg-hud-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>' +
      '<div class="ggg-hud-main"><div class="ggg-hud-status">GIF Grabber</div>' +
      '<div class="ggg-hud-bar ggg-hidden"><div class="ggg-hud-fill"></div></div></div>' +
      '<button class="ggg-hud-stop" type="button">Stop</button>';
    document.documentElement.appendChild(el);
    app.hud = {
      el: el,
      status: el.querySelector('.ggg-hud-status'),
      bar: el.querySelector('.ggg-hud-bar'),
      fill: el.querySelector('.ggg-hud-fill'),
      stop: el.querySelector('.ggg-hud-stop')
    };
    app.hud.stop.addEventListener('click', stopAll);
    return app.hud;
  }

  function hudShow() {
    clearTimeout(app.hudHideTimer);
    const h = ensureHud();
    h.el.style.display = 'flex';
  }

  function hudHideSoon(ms) {
    clearTimeout(app.hudHideTimer);
    app.hudHideTimer = setTimeout(() => {
      if (app && app.hud) app.hud.el.style.display = 'none';
    }, ms);
  }

  function hudNote(text, idle) {
    const h = ensureHud();
    hudShow();
    h.status.textContent = text;
    h.el.classList.toggle('ggg-hud-idle', !!idle);
  }

  function hudProgress(done, total) {
    if (!app || !app.hud) return;
    app.hud.bar.classList.remove('ggg-hidden');
    app.hud.fill.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  }

  function stopAll() {
    if (!app) return;
    app.scrollState.stopFlag = true;
    try {
      const p = chrome.runtime.sendMessage({ type: 'GGG_CANCEL' });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
    hudNote('Stopping…');
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.ggg_progress || !app || !app.hud || app.hud.el.style.display === 'none') return;
    const p = changes.ggg_progress.newValue;
    if (!p) return;
    if (p.phase === 'verifying') {
      hudProgress(p.done, p.total);
      hud.status.textContent = 'Checking images — ' + p.done + '/' + p.total + ' (finding the GIFs…)';
      app.hud.el.classList.add('ggg-hud-idle');
    } else if (p.phase === 'downloading') {
      hudProgress(p.done, p.total);
      hud.status.textContent = 'Downloading ' + p.done + '/' + p.total + (p.current ? ' — ' + p.current : '') + (p.ignored ? ' · ' + p.ignored + ' non-GIF ignored' : '');
      app.hud.el.classList.add('ggg-hud-idle');
    } else if (p.phase === 'done') {
      hudProgress(p.done, p.total);
      hud.status.textContent = 'Saved ' + p.done + '/' + p.total + ' GIFs' + (p.ignored ? ' · ' + p.ignored + ' non-GIF ignored' : '');
      app.hud.el.classList.add('ggg-hud-idle', 'ggg-hud-done');
      hudHideSoon(5000);
    } else if (p.phase === 'cancelled') {
      hud.status.textContent = 'Stopped at ' + (p.done || 0) + '/' + (p.total || 0);
      app.hud.el.classList.add('ggg-hud-idle');
      hudHideSoon(4000);
    }
  });

  /* ============ auto-scroll engine ============ */

  function clickShowMore() {
    const nodes = document.querySelectorAll('input[type="button"], input[type="submit"], button, div[role="button"]');
    for (const el of nodes) {
      const txt = (el.value || el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
      if (/show more results/.test(txt) && txt.length < 40) {
        el.click();
        return true;
      }
    }
    return false;
  }

  async function startScroll(mode) {
    if (!app || app.scrollState.running) return;
    app.scrollState.running = true;
    app.scrollState.mode = mode === 'collect' ? 'collect' : 'grab';
    app.scrollState.stopFlag = false;
    hudShow();
    hudNote('Auto-scroll — hunting for GIFs…');
    const t0 = Date.now();
    let last = verifiedGifs().length;
    let still = 0;

    while (!app.scrollState.stopFlag) {
      window.scrollBy({ top: Math.max(400, Math.round(window.innerHeight * 0.85)), left: 0 });
      await GG.sleep(700);
      if (!app || app.scrollState.stopFlag) break;
      scan();
      const n = verifiedGifs().length;
      const de = document.documentElement;
      const atBottom = window.scrollY + window.innerHeight >= de.scrollHeight - 6;
      if (atBottom && n === last) {
        still++;
        if (still === 1) clickShowMore();
      } else if (n !== last) {
        still = 0;
      }
      last = n;
      hudNote('Scrolling — ' + n + ' GIF' + (n === 1 ? '' : 's') + ' found…');
      if ((still >= 4 && n > 0) || n >= MAX_RECORDS || Date.now() - t0 > 150000) break;
    }

    app.scrollState.running = false;

    if (!app || app.scrollState.stopFlag) {
      if (app) {
        hudNote('Stopped — ' + verifiedGifs().length + ' GIFs found', true);
        hudHideSoon(3500);
      }
      return;
    }

    const found = verifiedGifs().length;
    if (app.scrollState.mode === 'grab' && found > 0) {
      hudNote('Checking ' + app.records.size + ' images and downloading the GIFs…', true);
      try {
        await chrome.runtime.sendMessage({
          type: 'GGG_BULK',
          records: Array.from(app.records.values()).map((r) => ({
            key: r.key, full: r.full, thumb: r.thumb, page: r.page
          })),
          term: currentTerm(),
          auto: true
        });
      } catch (e) {
        hudNote('Could not reach the downloader — reopen the popup', true);
        hudHideSoon(5000);
        return;
      }
    } else {
      hudNote('Found ' + found + ' GIF' + (found === 1 ? '' : 's') + ' — open GIF Grabber to download', true);
      hudHideSoon(6000);
    }
  }

  /* ============ messaging ============ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case 'GGG_GET':
        if (!app) {
          sendResponse({
            active: false,
            onImagesPage: GG.isImagesResultsPage(location.href),
            term: GG.termFromUrl(location.href)
          });
        } else {
          sendResponse({
            active: true,
            onImagesPage: true,
            site: 'google',
            term: currentTerm(),
            records: verifiedGifs().map((r) => ({ key: r.key, full: r.full, thumb: r.thumb, page: r.page })),
            stats: {
              scanned: app.records.size,
              gifs: verifiedGifs().length,
              ignored: Array.from(app.records.values()).filter((r) => r.gif === false).length,
              checking: app.pending.size
            },
            scroll: {
              running: app.scrollState.running,
              mode: app.scrollState.mode,
              found: verifiedGifs().length
            }
          });
        }
        return false;
      case 'GGG_SET_TERM':
        if (app) app.termOverride = String(msg.term || '');
        sendResponse({ ok: true });
        return false;
      case 'GGG_RESCAN':
        if (app) { scan(); scheduleVerify(); }
        sendResponse({ count: app ? verifiedGifs().length : 0 });
        return false;
      case 'GGG_SCROLL_START':
        startScroll(msg.mode === 'collect' ? 'collect' : 'grab');
        sendResponse({ ok: true });
        return false;
      case 'GGG_SCROLL_STOP':
        if (app) app.scrollState.stopFlag = true;
        sendResponse({ ok: true });
        return false;
    }
    return false;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app && app.scrollState.running) stopAll();
  });

  /* safety-net rescan while the tab is visible */
  setInterval(() => {
    if (app && document.visibilityState === 'visible') { scan(); scheduleVerify(); }
  }, 1500);

  if (GG.isImagesResultsPage(location.href)) startApp();
  window.addEventListener('load', () => {
    if (GG.isImagesResultsPage(location.href)) { startApp(); scan(); }
  });
})();
