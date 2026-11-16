# Google Images GIF Grabber

A Chrome extension (Manifest V3) that sits on **Google Images** search results, identifies
the results that are **real animated GIFs**, and downloads them in original quality with
search-term file names.

Part of the GIF Grabber family (separate extension — the Tenor/Giphy version is not
required and the two can be installed side by side).

## What it does

- **Only real GIFs.** Every result is checked by fetching its first bytes and looking for
  the `GIF87a`/`GIF89a` signature. Static JPG, PNG, and WebP results are detected and
  **ignored automatically** — they never appear in the list and never get downloaded.
- **Original quality.** It downloads the original image URL that Google's `/imgres`
  result links point to — not the small gstatic thumbnail.
- **Search-term file names.** Searching `funny cat gif` gives `funny_cat_gif.gif`,
  or `funny_cat_gif_1.gif`, `funny_cat_gif_2.gif`, … for batches (per session).
- **Hover download button** on every result confirmed to be a GIF.
- **Auto-scroll**: scrolls the results to the end for you (clicking "Show more results"
  when needed), then downloads every GIF found — you can close the popup while it runs.
  A HUD on the page shows progress; press **Stop** or **Esc** to end early.
- **Popup tools**: thumbnail grid with checkboxes, Download / ZIP / Copy links,
  duplicate skipping, live progress.
- **Light/dark** popup theme follows your OS automatically.

## Install (unpacked)

1. Download / unzip `google-gif-grabber` (or use `google-gif-grabber.zip`).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the `google-gif-grabber` folder.
5. Open Google, run a search, click the **Images** tab — the extension icon shows a
   blue badge counting the GIFs found on the page.

## Why "Read and change all your data on all websites"?

GIF results can be hosted on *any* website. To check whether an image is a real GIF
the extension must fetch its first 2 KB from that host — that requires the broad host
permission. The content script only ever runs on `www.google.*` domains; all it ever
fetches are image bytes. Nothing is sent anywhere except ordinary image requests.
If you prefer, you can narrow `host_permissions` in `manifest.json`, but detection of
non-`.gif`-URL results will stop working.

## How detection works

1. **Collect candidates** — result tiles link through
   `/imgres?imgurl=…&imgrefurl=…`; the extension reads the original `imgurl` for each
   tile. Direct image nodes that are not Google-hosted (e.g. the preview panel) are
   also collected.
2. **Verify** — a `.gif` URL extension is trusted immediately; everything else is
   probed with a 2 KB `Range` request:
   - starts with `GIF87a`/`GIF89a` → real GIF;
   - RIFF/WebP with an `ANIM` chunk → animated WebP → ignored (not a GIF);
   - anything else → ignored.
   If the original host refuses the probe (hotlink protection), the Google thumbnail
   is probed instead: a GIF thumbnail implies an animated source.
3. **Download** — only verified GIFs, named from the search term.

## Notes & troubleshooting

- **Badge shows 0 on a GIF search** — scroll a little (results lazy-load), or press
  Rescan in the popup. Google changes its markup occasionally; the extension uses two
  independent collection strategies (result links + direct image nodes), but a redesign
  can still require an update.
- **"Not a GIF — ignored"** on a hover button — that result really isn't an animated
  GIF (e.g. a still frame). The extension only trusts animated files.
- **First bulk download** — Chrome may ask to allow "download multiple files"; choose
  Allow.
- Some sites block programmatic downloads (hotlink protection); those rare failures
  show up as failed items in the progress summary.
- ZIP export packs the selected GIFs (store method — GIFs are already compressed).
- The page's own behavior (Google throttling, CAPTCHAs after very heavy scrolling) is
  outside the extension's control.

## Files

```
manifest.json      MV3 manifest, permissions, content-script matches (google TLDs)
lib/gg-core.js     shared helpers (page gate, /imgres parsing, byte checks, naming)
lib/zip-min.js     dependency-free ZIP writer (store method)
content.js         page scanning, hover buttons, HUD, auto-scroll engine
content.css        styles for hover button + HUD
background.js      service worker: byte verification, download queue, naming, badge
popup.html/css/js  popup UI (grid, actions, auto-scroll, progress)
icons/             generated icons
```
