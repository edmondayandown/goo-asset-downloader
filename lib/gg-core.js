/* Google Images GIF Grabber — shared helpers (content script, popup, service worker).
 *
 * Google Images basics (verified against known page structures):
 *  - Result tiles link through /imgres?imgurl=...&imgrefurl=...&tbnid=...
 *    where imgurl is the ORIGINAL full-size image on the source site.
 *  - Grid thumbnails come from encrypted-tbn*.gstatic.com.
 *  - Search term = the q URL parameter (tbm=isch legacy / udm=2 current tab).
 *  - A file is a real GIF only if its bytes start with GIF87a/GIF89a —
 *    thumbnails may be jpg/webp even for GIF results, so we verify bytes.
 */
(function (root) {
  'use strict';

  /** www.google.com / google.de / google.co.uk … (subdomains like mail. excluded) */
  function isGoogleHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return /^(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2,3})?$/.test(h);
  }

  /** The Google Images results tab: udm=2 (current), tbm=isch (legacy), /imgres pages. */
  function isImagesResultsPage(url) {
    try {
      const u = new URL(url);
      if (u.pathname === '/imgres') return true;
      const q = u.searchParams;
      if (q.get('udm') === '2' || q.get('tbm') === 'isch') return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  /** Search term from a Google URL (q parameter), '' if absent. */
  function termFromUrl(url) {
    try {
      const u = new URL(url);
      const q = (u.searchParams.get('q') || u.searchParams.get('query') || '').trim();
      return q;
    } catch (e) {
      return '';
    }
  }

  /** Make an absolute http(s) URL; '' for data:/blob:/other schemes. */
  function normalizeImageUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^\/\//.test(s)) return 'https:' + s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
    return 'https://' + s;
  }

  /**
   * Parse an /imgres link into {full, page, tbnid}.
   * Works with absolute and relative hrefs; returns null when no imgurl.
   */
  function parseImgresHref(href, base) {
    try {
      const u = new URL(href, base || 'https://www.google.com/');
      if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname)) return null;
      if (u.pathname !== '/imgres') return null;
      const p = u.searchParams;
      const full = normalizeImageUrl(p.get('imgurl'));
      if (!full) return null;
      return {
        full: full,
        page: p.get('imgrefurl') || '',
        tbnid: p.get('tbnid') || ''
      };
    } catch (e) {
      return null;
    }
  }

  /** Path ends with .gif (ignoring query string) — strong signal, no probe needed. */
  function looksLikeGifUrl(u) {
    try {
      const p = new URL(u).pathname;
      return /\.gif$/i.test(p);
    } catch (e) {
      return false;
    }
  }

  /** First bytes look like a GIF87a/GIF89a file? */
  function isGifBytes(u8) {
    return !!u8 && u8.length >= 6 &&
      u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38 &&
      (u8[4] === 0x37 || u8[4] === 0x39) && u8[5] === 0x61;
  }

  /** RIFF/WEBP file that carries an ANIM chunk = animated WebP (not a GIF). */
  function isAnimatedWebpBytes(u8) {
    if (!u8 || u8.length < 16) return false;
    if (!(u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46)) return false; // RIFF
    if (!(u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50)) return false; // WEBP
    const n = Math.min(u8.length - 4, 256);
    for (let i = 12; i < n; i++) {
      if (u8[i] === 0x41 && u8[i + 1] === 0x4E && u8[i + 2] === 0x49 && u8[i + 3] === 0x4D) return true; // 'ANIM'
    }
    return false;
  }

  /** FNV-1a 32-bit hash as 8 hex chars — stable record keys from URLs. */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /** Make a safe file-name base from a search term. */
  function sanitizeTerm(s) {
    let t = String(s || '').trim();
    if (!t) return 'google_gifs';
    t = t
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!t) t = 'google_gifs';
    return t.slice(0, 60);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  root.GG = {
    isGoogleHost: isGoogleHost,
    isImagesResultsPage: isImagesResultsPage,
    termFromUrl: termFromUrl,
    normalizeImageUrl: normalizeImageUrl,
    parseImgresHref: parseImgresHref,
    looksLikeGifUrl: looksLikeGifUrl,
    isGifBytes: isGifBytes,
    isAnimatedWebpBytes: isAnimatedWebpBytes,
    fnv1a: fnv1a,
    sanitizeTerm: sanitizeTerm,
    sleep: sleep
  };
})(globalThis);
