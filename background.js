/* Google Images GIF Grabber — service worker.
 * Verifies candidate image URLs by fetching their first bytes and checking
 * whether they are a real GIF (GIF87a/GIF89a). Non-GIF images are ignored.
 * Runs the download queue, assigns search-term file names
 * (term.gif / term_1.gif / term_2.gif…), skips duplicates, shows badge
 * progress and notifies on completion. */
'use strict';
importScripts('lib/gg-core.js');

const QUEUE = [];
let running = false;
let cancelFlag = false;

const sleep = GG.sleep;

try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (e) { /* older Chrome */ }

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get({ skipDupes: true });
  await chrome.storage.local.set(cur);
  chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
});

/* ---------------- storage helpers ---------------- */

async function getCounts() {
  const o = await chrome.storage.session.get({ ggg_counts: {} });
  return o.ggg_counts;
}

function setProgress(p) {
  return chrome.storage.session.set({ ggg_progress: p }).catch(() => {});
}

/* ---------------- badge ---------------- */

function badgeTab(tabId, text) {
  if (tabId == null) return;
  try { chrome.action.setBadgeText({ tabId: tabId, text: text }).catch(() => {}); } catch (e) {}
}

function badgeColor(tabId, color) {
  if (tabId == null) return;
  try { chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color }).catch(() => {}); } catch (e) {}
}

/* ---------------- GIF verification ---------------- */

const verifyCache = new Map(); // key -> {gif:boolean}

/** Range-GET the first 2 KB and inspect the magic bytes. */
async function probeImage(url) {
  const res = await fetch(url, { headers: { Range: 'bytes=0-2047' }, credentials: 'omit' });
  if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (GG.isGifBytes(buf)) {
    const cr = res.headers.get('content-range');
    const total = cr ? parseInt(String(cr).split('/')[1], 10) || 0 : parseInt(res.headers.get('content-length') || '0', 10);
    if (total && total < 1024) throw new Error('too small'); // decorative stub
    return 'gif';
  }
  if (GG.isAnimatedWebpBytes(buf)) return 'animwebp';
  return 'other';
}

/** Decide whether a result is a real GIF. Never throws. */
async function verifyItem(item) {
  const ck = item.key;
  if (verifyCache.has(ck)) return verifyCache.get(ck);
  const result = { gif: false, url: item.full || '' };

  if (item.full) {
    if (GG.looksLikeGifUrl(item.full)) {
      result.gif = true; // .gif extension on the original — trust it
    } else {
      try {
        const kind = await probeImage(item.full);
        result.gif = kind === 'gif';
      } catch (e) {
        // Hotlink-protected hosts may refuse the probe. Fall back to the
        // Google thumbnail: if IT is a GIF file, the source was animated.
        if (item.thumb) {
          try {
            const kind2 = await probeImage(item.thumb);
            result.gif = kind2 === 'gif';
          } catch (e2) { result.gif = false; }
        }
      }
    }
  }
  verifyCache.set(ck, result);
  return result;
}

async function verifyAll(items) {
  const results = {};
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      const it = items[i];
      try {
        const r = await verifyItem(it);
        results[it.key] = r;
      } catch (e) {
        results[it.key] = { gif: false, url: it.full || '' };
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  return results;
}

/* ---------------- naming ---------------- */

/**
 * term.gif for the first single save; term_1.gif, term_2.gif… from then on.
 * Batches of N get term_1…term_N (continuing the session counter per term).
 */
async function assignNames(term, total) {
  const counts = await getCounts();
  const start = counts[term] || 0;
  let names;
  if (total === 1) {
    const n = start + 1;
    names = [n === 1 ? term + '.gif' : term + '_' + (n - 1) + '.gif'];
    counts[term] = n;
  } else {
    names = [];
    for (let i = 0; i < total; i++) names.push(term + '_' + (start + i + 1) + '.gif');
    counts[term] = start + total;
  }
  await chrome.storage.session.set({ ggg_counts: counts });
  return names;
}

/* ---------------- notifications ---------------- */

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: String(message || '').slice(0, 400)
    });
  } catch (e) { /* notifications unavailable */ }
}

/* ---------------- job runner ---------------- */

async function handleOne(msg, tabId) {
  const rec = msg.record;
  if (!rec || !rec.key || !rec.full) return { ok: false, error: 'bad record' };
  const term = GG.sanitizeTerm(msg.record.term || '');
  const verdict = await verifyItem({ key: rec.key, full: rec.full, thumb: rec.thumb });
  if (!verdict.gif) return { ok: false, error: 'Not a GIF — ignored' };
  const counts = await getCounts();
  const n = (counts[term] || 0) + 1;
  counts[term] = n;
  await chrome.storage.session.set({ ggg_counts: counts });
  const name = n === 1 ? term + '.gif' : term + '_' + (n - 1) + '.gif';
  try {
    await chrome.downloads.download({ url: rec.full, filename: name, conflictAction: 'uniquify', saveAs: false });
    const dl = await chrome.storage.session.get({ ggg_downloaded: {} });
    dl.ggg_downloaded[rec.key] = name;
    await chrome.storage.session.set({ ggg_downloaded: dl.ggg_downloaded });
    badgeTab(tabId, '+1');
    badgeColor(tabId, '#188038');
    setTimeout(() => badgeTab(tabId, ''), 2500);
    return { ok: true, name: name };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function runJob(job) {
  const term = job.term;
  const tabId = job.tabId;
  let items = job.records.filter((r) => r && r.key && r.full);

  const settings = await chrome.storage.local.get({ skipDupes: true });
  const dl = await chrome.storage.session.get({ ggg_downloaded: {} });
  const downloaded = dl.ggg_downloaded;

  let skipped = 0;
  if (settings.skipDupes) {
    items = items.filter((r) => {
      if (downloaded[r.key]) { skipped++; return false; }
      return true;
    });
  }

  /* phase 1 — verify all candidates (finding the real GIFs) */
  if (items.length) {
    await setProgress({ phase: 'verifying', term: term, done: 0, total: items.length, ignored: 0 });
    let checked = 0;
    const CHUNK = 8;
    for (let i = 0; i < items.length; i += CHUNK) {
      if (cancelFlag) break;
      const chunk = items.slice(i, i + CHUNK);
      const res = await verifyAll(chunk);
      for (const it of chunk) it._gif = !!(res[it.key] && res[it.key].gif);
      checked = Math.min(i + CHUNK, items.length);
      await setProgress({ phase: 'verifying', term: term, done: checked, total: items.length, ignored: 0 });
    }
    items = items.filter((r) => r._gif);
  }

  const ignored = Math.max(0, job.records.length - items.length - skipped);
  const total = items.length;

  if (!total) {
    await setProgress({ phase: 'done', term: term, done: 0, total: 0, ok: 0, skipped: skipped, ignored: ignored, errors: 0 });
    if (job.auto) {
      notify('GIF Grabber', ignored
        ? 'No real GIFs here — ' + ignored + ' image' + (ignored === 1 ? '' : 's') + ' checked and ignored.'
        : 'Nothing to check.');
    }
    return;
  }

  const names = await assignNames(term, total);
  badgeColor(tabId, '#1a73e8');
  await setProgress({ phase: 'downloading', term: term, done: 0, total: total, current: names[0], skipped: skipped, ignored: ignored, ok: 0, errors: 0 });

  let ok = 0;
  const errors = [];
  for (let i = 0; i < total; i++) {
    if (cancelFlag) break;
    const it = items[i];
    try {
      await chrome.downloads.download({ url: it.full, filename: names[i], conflictAction: 'uniquify', saveAs: false });
      ok++;
      downloaded[it.key] = names[i];
    } catch (e) {
      errors.push(names[i] + ': ' + ((e && e.message) || e));
    }
    await setProgress({ phase: 'downloading', term: term, done: i + 1, total: total, current: names[i], skipped: skipped, ignored: ignored, ok: ok, errors: errors.length });
    badgeTab(tabId, Math.round(((i + 1) / total) * 100) + '%');
    await sleep(120);
  }

  await chrome.storage.session.set({ ggg_downloaded: downloaded });

  if (cancelFlag) {
    cancelFlag = false;
    await setProgress({ phase: 'cancelled', term: term, done: ok, total: total, ok: ok, errors: errors.length, ignored: ignored });
    badgeTab(tabId, '');
    notify('GIF Grabber — stopped', 'Saved ' + ok + '/' + total + ' files before stopping.');
    return;
  }

  await setProgress({ phase: 'done', term: term, done: ok, total: total, ok: ok, errors: errors.length, skipped: skipped, ignored: ignored });
  badgeColor(tabId, '#188038');
  badgeTab(tabId, 'OK');
  setTimeout(() => badgeTab(tabId, ''), 4000);
  if (job.auto || total > 2) {
    notify('GIF Grabber',
      'Saved ' + ok + '/' + total + ' GIFs as "' + term + '_1 … ' + term + '_' + total + '"' +
      (ignored ? ' · ' + ignored + ' non-GIF image' + (ignored === 1 ? '' : 's') + ' ignored' : '') +
      (errors.length ? ' (' + errors.length + ' failed)' : '') + '.');
  }
}

async function kickQueue() {
  if (running) return;
  running = true;
  try {
    while (QUEUE.length && !cancelFlag) {
      const job = QUEUE.shift();
      try { await runJob(job); } catch (e) { /* keep draining */ }
    }
  } finally {
    running = false;
    if (cancelFlag) {
      cancelFlag = false;
      await setProgress({ phase: 'cancelled', done: 0, total: 0 });
    }
  }
}

function enqueue(msg, tabId) {
  const term = GG.sanitizeTerm(msg.term || '');
  const recs = (msg.records || []).filter((r) => r && r.key && r.full);
  if (!recs.length) return 0;
  QUEUE.push({ term: term, records: recs, auto: !!msg.auto, tabId: tabId });
  kickQueue();
  return recs.length;
}

/* ---------------- messaging ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  const tabId = sender && sender.tab ? sender.tab.id : null;
  switch (msg.type) {
    case 'GGG_COUNT':
      badgeColor(tabId, '#1a73e8');
      badgeTab(tabId, msg.count ? String(Math.min(msg.count, 999)) : '');
      sendResponse({ ok: true });
      return false;
    case 'GGG_VERIFY':
      verifyAll(msg.items || [])
        .then((results) => sendResponse({ ok: true, results: results }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'GGG_ONE':
      handleOne(msg, tabId)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'GGG_BULK': {
      const n = enqueue(msg, tabId);
      sendResponse({ ok: true, queued: n });
      return false;
    }
    case 'GGG_CANCEL':
      cancelFlag = true;
      sendResponse({ ok: true });
      return false;
  }
  return false;
});
