# Garrett — Video Keeper

<p align="left">
  <img src="https://img.shields.io/badge/Manifest_V3-Chrome_%7C_Brave-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
  <img src="https://img.shields.io/badge/Stream_Assembly-DASH_%26_HLS-D4AF37?style=for-the-badge" alt="Stream Assembly" />
  <img src="https://img.shields.io/badge/Version-1.9.0-blue?style=for-the-badge" alt="Version 1.9.0" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License MIT" />
</p>

> *"What is merely watched is soon forgotten. What is taken is kept."*  
> — *Keeper Annuary, Ch. VII*

Named after **Garrett**, the cynical, pragmatic Master Thief trained by the secretive **Keeper Order** (*Thief: The Dark Project*), this browser extension embodies the Keeper philosophy:

**Modern web platforms treat video as disposable, ephemeral streams bound to in-memory `blob:` URLs that disappear as soon as you scroll or close the tab. Garrett extracts, stitches, and preserves complete MP4 files directly to your machine.**

---

## Key Capabilities

Modern streaming video players (LinkedIn, X/Twitter, Reddit, TikTok, Vimeo, and custom WebRTC/MSE players) use ephemeral `blob:` URLs pointing to internal `MediaSource` streaming engines rather than direct static file links. Garrett extracts and preserves them silently in the background:

* **Multi-Tier Stream Discovery**:
  1. **Direct React Fiber Traversal**: Reads unexposed progressive MP4 and DASH streaming locations directly from component props and React Fiber trees (`fiber.return`).
  2. **Embedded Hydration Scans**: Deeply inspects server-rendered JSON payloads (`<code id^="bpr-guid-">`) to discover pristine HD video sources before playback even finishes.
  3. **Universal Stream & Segment Queue (`garrettQueue.js`)**: Real-time sniffer and indexer backed by `chrome.storage.local` that catalogs manifests (`.mpd`, `.m3u8`) and segmented chunks (`.m4s`, `.ts`) with 100% video-to-blob isolation.
  4. **Performance Resource Inspection**: Correlates active network requests in `performance.getEntriesByType('resource')` to lock onto streams in real time.
* **Parallel Fragment Assembler (`streamAssembler.js`)**:
  - Downloads media initialization boxes (`ftyp`, `moov`) and segmented media fragments (`moof`, `mdat`) across concurrent background fetch workers.
  - Automatically parses and stitches MPEG-DASH and HLS playlists into pristine, playable, complete `.mp4` video files with full audio.
  - Zero loss of duration: never truncates playback or relies on slow screen/canvas recording.
* **100% Invisible Background Operation**:
  - No viewport seeks, scrubbing, audio disruption, or visible playback alteration.
  - Context-invalidation resilient: handles dynamic extension updates without throwing unhandled page console errors.
  - Zero external telemetry or third-party dependencies.

---

## Installation

### Chrome & Brave (Manifest V3)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/digitalforgeca/garrett.git
   ```
2. Navigate to your browser's extensions manager:
   * **Brave**: `brave://extensions/`
   * **Chrome**: `chrome://extensions/`
   * **Edge**: `edge://extensions/`
3. Toggle **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the root directory of this repository (`garrett/`).
5. Open any supported video page (e.g., LinkedIn feed, post, or media player) and refresh the page (`Cmd + Shift + R` or `Ctrl + Shift + R`).
6. Click the overlay download button to preserve the complete stream directly to disk.

---

## Architecture & File Map

```
garrett/
├── manifest.json         # Manifest V3 configuration (permissions, webRequest, content scripts)
├── pageHook.js           # MAIN-world interceptor (fetch, XHR, MSE appendBuffer, React Fiber traversal)
├── garrettQueue.js       # Universal stream & segment queue engine (indexed by blob: URL)
├── streamAssembler.js    # MPEG-DASH & HLS manifest parser and parallel segment stitcher
├── keeper.js             # Keeper Order lore, notifications, and quote generator
├── content.js            # Isolated-world controller (DOM watcher, overlay UI, download manager)
├── content.css           # Sleek overlay button and toast notification styling
├── popup.html            # Extension popup listing detected tab videos
├── popup.js              # Popup interface logic and direct download dispatcher
├── popup.css             # Extension popup dark theme styling
├── test.html             # Standalone local test lab for video stream validation
├── icons/                # Extension action and store icons (16px, 48px, 128px)
├── LICENSE               # MIT License
└── README.md             # Documentation & badge overview
```

---

## Privacy & Permissions

Garrett runs **exclusively inside your local browser instance**:
* **No Analytics or Trackers**: No user telemetry, external network pings, or data collection.
* **Local Processing**: Segment stitching and stream assembly occur entirely in client-side memory.
* **Minimal Privileges**: Permissions are limited to `downloads` (saving the assembled `.mp4`), `webRequest` (detecting media manifests and chunks), and `storage` (session-level stream indexing).

---

## Support & Maintainer

Garrett is maintained by **Digital Forge Studios Inc.** as part of our suite of high-efficiency developer and productivity tools.

* **Website**: [digitalforgestudios.com](https://digitalforgestudios.com)
* **GitHub**: [@digitalforgeca](https://github.com/digitalforgeca)
* **License**: [MIT](LICENSE)
