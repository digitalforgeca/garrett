// Garrett - Stream Keeper: Content Script
(function () {
  'use strict';

  if (window.__GARRETT_CONTENT_SCRIPT_INITIALIZED__) return;
  window.__GARRETT_CONTENT_SCRIPT_INITIALIZED__ = true;

  const queue = (typeof window.GarrettQueue !== 'undefined' && window.GarrettQueue.queue) || null;
  const keeper = (typeof window.GarrettKeeper !== 'undefined' && window.GarrettKeeper) || null;

  const videoRegistry = new Map();
  let nextVideoId = 1;

  // Raw chunks passive fallback
  const recentChunks = [];
  let lastInitChunk = null;

  // React stream cache from pageHook.js
  const reactStreamCache = new Map(); // blobUrl -> { manifestUrl, entityUrn, duration }

  function isNonMediaUrl(url) {
    if (!url || typeof url !== 'string') return true;
    const clean = url.split('?')[0].toLowerCase();
    return (
      clean.includes('company-logo') ||
      clean.includes('profile-displayphoto') ||
      clean.includes('feedshare-shrink') ||
      clean.includes('videocover') ||
      clean.includes('/li/track') ||
      /\.(jpg|jpeg|png|webp|gif|svg|ico|css|js|woff|woff2|map)$/i.test(clean)
    );
  }

  function isInitBox(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < 8) return false;
    const view = new DataView(arrayBuffer);
    return (
      view.getUint8(4) === 0x66 && // 'f'
      view.getUint8(5) === 0x74 && // 't'
      view.getUint8(6) === 0x79 && // 'y'
      view.getUint8(7) === 0x70    // 'p'
    );
  }

  function safeSendMessage(message, callback) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        if (typeof callback === 'function') callback(null);
        return Promise.resolve(null);
      }
      if (typeof callback === 'function') {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime && chrome.runtime.lastError) {
            // suppress unchecked runtime.lastError
          }
          callback(res);
        });
        return;
      }
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (e) {
      if (typeof callback === 'function') callback(null);
      return Promise.resolve(null);
    }
  }

  // Listen for telemetry events from pageHook.js (MAIN world)
  window.addEventListener('__GARRETT_MANIFEST_CONTENT__', (e) => {
    if (e.detail && e.detail.url && !isNonMediaUrl(e.detail.url)) {
      if (queue) {
        queue.registerManifest(e.detail.url, e.detail.text || '');
      }
      safeSendMessage({
        action: 'registerManifest',
        url: e.detail.url,
        content: e.detail.text || ''
      });
    }
  });

  window.addEventListener('__GARRETT_SEGMENT_DETECTED__', (e) => {
    if (e.detail && e.detail.url && !isNonMediaUrl(e.detail.url)) {
      if (queue) {
        queue.registerSegment(e.detail.url);
      }
      safeSendMessage({
        action: 'registerSegment',
        url: e.detail.url
      });
    }
  });

  window.addEventListener('__GARRETT_BLOB_CREATED__', (e) => {
    if (e.detail && e.detail.blobUrl) {
      if (queue) {
        queue.registerBlobStream(e.detail.blobUrl, { mediaSourceId: e.detail.mediaSourceId });
      }
    }
  });

  window.addEventListener('__GARRETT_SOURCE_CHUNK__', (e) => {
    if (e.detail && e.detail.chunk) {
      const chunk = e.detail.chunk;
      if (isInitBox(chunk)) {
        lastInitChunk = chunk;
      }
      recentChunks.push(chunk);
      if (recentChunks.length > 60) recentChunks.shift();
    }
  });

  window.addEventListener('__GARRETT_REACT_STREAM_FOUND__', (e) => {
    if (e.detail && e.detail.blobUrl) {
      reactStreamCache.set(e.detail.blobUrl, e.detail);
      for (const state of videoRegistry.values()) {
        const v = state.video;
        if (v && (v.currentSrc === e.detail.blobUrl || v.src === e.detail.blobUrl)) {
          if (e.detail.progressiveUrl) state.progressiveUrl = e.detail.progressiveUrl;
          if (e.detail.manifestUrl) state.manifestUrl = e.detail.manifestUrl;
          if (e.detail.entityUrn && !state.entityKey) state.entityKey = e.detail.entityUrn;
        }
      }
      if (e.detail.manifestUrl && queue) {
        queue.registerManifest(e.detail.manifestUrl);
      }
    }
  });

  window.addEventListener('__GARRETT_PROGRESSIVE_DETECTED__', (e) => {
    if (e.detail && e.detail.url) {
      const progUrl = e.detail.url;
      for (const state of videoRegistry.values()) {
        if (state.entityKey && entityKeysMatch(state.entityKey, progUrl)) {
          state.progressiveUrl = progUrl;
        }
      }
    }
  });

  function showToast(message, duration = 4500) {
    const toast = document.createElement('div');
    toast.className = 'vbs-toast';
    toast.innerHTML = `<span>${message}</span>`;
    (document.body || document.documentElement).appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  function generateFilename(video, extension = 'mp4') {
    let title = document.title || 'video';
    title = title.replace(/[/\\?%*:|"<>]/g, '-').trim();
    if (title.length > 40) title = title.substring(0, 40);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${title}_${timestamp}.${extension}`;
  }

  function downloadBlobDirectly(blob, filename) {
    if (!blob || blob.size < 10240) {
      showToast('Video file too small (<10KB), incomplete stream.');
      return false;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 30000);
    return true;
  }

  // Deep recursive video discovery supporting light DOM and nested Shadow DOMs
  function findAllVideos(root = document) {
    const videos = [];
    function traverse(node) {
      if (!node) return;
      if (node.tagName === 'VIDEO') {
        videos.push(node);
      }
      if (node.shadowRoot) {
        traverse(node.shadowRoot);
      }
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
          traverse(node.children[i]);
        }
      }
    }
    traverse(root);
    return videos;
  }

  /**
   * Exhaustive, container-scoped entity key extractor.
   * Scoped to the video's parent post container to prevent picking sibling posts.
   */
  function extractVideoEntityKeyFromDom(video) {
    if (!video) return '';

    // 1. Check direct poster attribute on video
    const poster = video.getAttribute('poster') || video.poster || '';
    if (poster) {
      const pm = poster.match(/(?:dms\/image\/(?:v2\/)?|videocover-(?:high|low)\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i);
      if (pm) return pm[1];
    }

    // 2. Find closest post container (never leak outside)
    const container = video.closest('.feed-shared-update-v2, [data-urn], [data-id], article, .feed-shared-linkedin-video, div[data-id], .occludable-update') || video.parentElement;
    if (!container) return '';

    // 3. Search thumbnail / preview divs inside this specific container
    const thumbElements = container.querySelectorAll('[style*="videocover"], [style*="dms/image"], [style*="background"], img');
    for (const el of thumbElements) {
      const src = el.src || el.getAttribute('src') || el.getAttribute('style') || '';
      const m = src.match(/(?:dms\/image\/(?:v2\/)?|videocover-(?:high|low)\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i);
      if (m) return m[1];
    }

    // 4. Search data attributes in this container and its ancestors
    const urnElements = [container, ...container.querySelectorAll('[data-urn], [data-entity-urn], [data-chameleon-urn], [data-id]')];
    for (const el of urnElements) {
      for (const attrName of ['data-urn', 'data-entity-urn', 'data-chameleon-urn', 'data-id']) {
        const val = el.getAttribute ? el.getAttribute(attrName) : '';
        if (val) {
          const vm = val.match(/(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i);
          if (vm) return vm[1];
          const am = val.match(/urn:li:(?:activity|ugcPost|share):([0-9]{10,})/i);
          if (am) return am[1];
        }
      }
    }

    // 5. Search container innerHTML as scoped fallback
    const html = container.innerHTML || '';
    const hm = html.match(/(?:dms\/image\/(?:v2\/)?|videocover-(?:high|low)\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i);
    if (hm) return hm[1];

    return '';
  }

  function cleanEntityKey(key) {
    if (!key) return '';
    return key.replace(/^urn:li:[^:]+:/i, '').trim();
  }

  function entityKeysMatch(key1, key2) {
    if (!key1 || !key2) return false;
    const k1 = cleanEntityKey(key1);
    const k2 = cleanEntityKey(key2);
    if (k1 === k2) return true;
    if (k1.includes(k2) || k2.includes(k1)) return true;
    if (k1.length > 10 && k2.length > 10) {
      const sub1 = k1.slice(1);
      const sub2 = k2.slice(1);
      if (sub1 === sub2 || sub1.includes(sub2) || sub2.includes(sub1)) return true;
    }
    return false;
  }

  function extractAllEmbeddedVideoMetadata() {
    const results = [];
    const codeEls = document.querySelectorAll('code[id^="bpr-guid-"]');
    for (const el of codeEls) {
      const text = el.textContent || '';
      if (!text.includes('videoPlayMetadata') && !text.includes('progressiveStreams') && !text.includes('adaptiveStreams')) {
        continue;
      }
      try {
        const json = JSON.parse(text);
        const collected = [];

        function scan(node, depth = 0) {
          if (!node || depth > 10 || typeof node !== 'object') return;
          if (node.videoPlayMetadata && typeof node.videoPlayMetadata === 'object') {
            collected.push({ parent: node, vpm: node.videoPlayMetadata });
          }
          if (Array.isArray(node.progressiveStreams) || Array.isArray(node.adaptiveStreams)) {
            collected.push({ parent: node, vpm: node });
          }
          if (Array.isArray(node)) {
            for (const item of node) scan(item, depth + 1);
          } else {
            for (const k of Object.keys(node)) {
              if (k === 'videoPlayMetadata') continue;
              scan(node[k], depth + 1);
            }
          }
        }

        scan(json);

        for (const item of collected) {
          const vpm = item.vpm;
          const parent = item.parent;
          const entityUrn = vpm.entityUrn || vpm.mediaUrn || parent.entityUrn || parent.urn || parent['$id'] || '';
          const progStreams = vpm.progressiveStreams || [];
          let bestProgUrl = null;
          if (progStreams.length > 0) {
            const sorted = progStreams.slice().sort((a, b) => {
              const resA = (a.width || 0) * (a.height || 0);
              const resB = (b.width || 0) * (b.height || 0);
              if (resA !== resB) return resB - resA;
              return (b.bitRate || 0) - (a.bitRate || 0);
            });
            bestProgUrl = sorted[0]?.streamingLocations?.[0]?.url || sorted[0]?.url || null;
          }
          const dashUrl = vpm.adaptiveStreams?.find(s => s.protocol === 'DASH' || s.url?.includes('dash') || s.url?.includes('.mpd'))?.url || null;
          const hlsUrl = vpm.adaptiveStreams?.find(s => s.protocol === 'HLS' || s.url?.includes('m3u8'))?.url || null;
          const dur = vpm.duration ? (vpm.duration > 1000 ? vpm.duration / 1000 : vpm.duration) : 0;

          if (bestProgUrl || dashUrl || hlsUrl) {
            results.push({
              entityUrn,
              progressiveUrl: bestProgUrl,
              manifestUrl: dashUrl || hlsUrl,
              dashUrl,
              hlsUrl,
              duration: dur
            });
          }
        }
      } catch (e) {}
    }
    return results;
  }

  function registerVideo(video) {
    if (videoRegistry.has(video)) return;

    const id = `vbs-${nextVideoId++}`;
    const entityKey = extractVideoEntityKeyFromDom(video);
    const poster = video.getAttribute('poster') || '';

    const state = {
      id,
      video,
      entityKey,
      poster,
      progressiveUrl: null,
      manifestUrl: null,
      isDownloading: false,
      overlayBtn: null,
      mainBtn: null
    };

    // Pre-check embedded JSON for immediate progressive/manifest URL attachment
    try {
      const allMeta = extractAllEmbeddedVideoMetadata();
      for (const m of allMeta) {
        if (entityKey && entityKeysMatch(entityKey, m.entityUrn)) {
          if (m.progressiveUrl) state.progressiveUrl = m.progressiveUrl;
          if (m.manifestUrl) state.manifestUrl = m.manifestUrl;
          break;
        }
      }
    } catch (e) {}

    videoRegistry.set(video, state);
    createOverlayUI(state);
    notifyBackground(state);

    const onUserPlay = () => {
      state.entityKey = state.entityKey || extractVideoEntityKeyFromDom(video);
      const src = video.currentSrc || video.src || '';
      if (src.startsWith('blob:')) {
        window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
          detail: { videoId: state.id, blobUrl: src }
        }));
      }
      notifyBackground(state);
    };

    video.addEventListener('play', onUserPlay);
    video.addEventListener('loadedmetadata', onUserPlay);
  }

  function notifyBackground(state) {
    const v = state.video;
    const src = v.currentSrc || v.src || '';
    const entityKey = state.entityKey || extractVideoEntityKeyFromDom(v);
    state.entityKey = entityKey;

    safeSendMessage({
      action: 'registerVideo',
      video: {
        id: state.id,
        src: src,
        entityKey: entityKey,
        isBlob: src.startsWith('blob:'),
        poster: state.poster,
        duration: v.duration || 0,
        width: v.videoWidth || 0,
        height: v.videoHeight || 0
      }
    });

    if (src && src.startsWith('blob:')) {
      safeSendMessage({
        action: 'registerBlobStream',
        record: {
          blobUrl: src,
          videoId: state.id,
          entityKey: entityKey,
          duration: v.duration || 0,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0,
          poster: state.poster
        }
      });
    }
  }

  function createOverlayUI(state) {
    const video = state.video;
    const parent = video.parentElement;
    if (!parent) return;

    const parentPos = window.getComputedStyle(parent).position;
    if (parentPos === 'static') {
      parent.style.position = 'relative';
    }

    // Sleek download action button with SVG icon
    const btn = document.createElement('button');
    btn.className = 'vbs-overlay-btn';
    btn.id = 'vbs-main-btn';
    btn.title = 'Keep video directly to MP4 in background';
    btn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <span class="vbs-btn-text" style="display: none;"></span>
    `;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      keepVideoNow(state);
    });

    parent.appendChild(btn);
    state.overlayBtn = btn;
    state.mainBtn = btn;
  }

  async function resolveStreamForVideo(state, maxWaitMs = 2500) {
    const video = state.video;
    const currentSrc = video.currentSrc || video.src || '';
    const entityKey = state.entityKey || extractVideoEntityKeyFromDom(video);
    state.entityKey = entityKey;
    const duration = video.duration || 0;

    // Fast Path 0: Already cached progressive MP4 URL
    if (state.progressiveUrl) {
      return {
        progressiveUrl: state.progressiveUrl,
        isStream: false,
        format: 'DIRECT',
        streamKey: entityKey
      };
    }

    // Fast Path 0.5: Already cached manifest URL
    if (state.manifestUrl) {
      return {
        url: state.manifestUrl,
        manifestXml: state.manifestXml || '',
        isStream: true,
        format: state.manifestUrl.includes('.m3u8') ? 'HLS' : 'DASH',
        streamKey: entityKey,
        allSegments: []
      };
    }

    // Fast Path 1: Check React Stream Cache
    if (reactStreamCache.has(currentSrc)) {
      const rMeta = reactStreamCache.get(currentSrc);
      if (rMeta.progressiveUrl) {
        state.progressiveUrl = rMeta.progressiveUrl;
        return {
          progressiveUrl: rMeta.progressiveUrl,
          isStream: false,
          format: 'DIRECT',
          streamKey: rMeta.entityUrn || entityKey
        };
      }
      if (rMeta.manifestUrl) {
        state.manifestUrl = rMeta.manifestUrl;
        return {
          url: rMeta.manifestUrl,
          isStream: true,
          format: rMeta.manifestUrl.includes('.m3u8') ? 'HLS' : 'DASH',
          streamKey: rMeta.entityUrn || entityKey,
          allSegments: []
        };
      }
    }

    // Fast Path 2: Check Embedded DOM JSON (<code id^="bpr-guid-">)
    try {
      const allMeta = extractAllEmbeddedVideoMetadata();
      for (const m of allMeta) {
        const keyMatch = entityKey && m.entityUrn && entityKeysMatch(entityKey, m.entityUrn);
        const durMatch = duration > 5 && m.duration > 5 && Math.abs(duration - m.duration) <= 1.5;
        const singleMatch = allMeta.length === 1;
        if (keyMatch || durMatch || singleMatch) {
          if (m.progressiveUrl) {
            state.progressiveUrl = m.progressiveUrl;
            return {
              progressiveUrl: m.progressiveUrl,
              isStream: false,
              format: 'DIRECT',
              streamKey: m.entityUrn || entityKey
            };
          }
          if (m.manifestUrl) {
            state.manifestUrl = m.manifestUrl;
            return {
              url: m.manifestUrl,
              isStream: true,
              format: m.manifestUrl.includes('.m3u8') ? 'HLS' : 'DASH',
              streamKey: m.entityUrn || entityKey,
              allSegments: []
            };
          }
        }
      }
    } catch (e) {}

    const videoInfo = {
      id: state.id,
      src: currentSrc,
      currentSrc: currentSrc,
      entityKey: entityKey,
      poster: state.poster || video.getAttribute('poster') || '',
      duration: duration
    };

    // Trigger React Fiber query to pageHook in MAIN world
    if (currentSrc.startsWith('blob:')) {
      window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
        detail: { videoId: state.id, blobUrl: currentSrc }
      }));
    }

    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      // Check React Cache again if arrived asynchronously
      if (reactStreamCache.has(currentSrc)) {
        const rMeta = reactStreamCache.get(currentSrc);
        if (rMeta.progressiveUrl) {
          state.progressiveUrl = rMeta.progressiveUrl;
          return {
            progressiveUrl: rMeta.progressiveUrl,
            isStream: false,
            format: 'DIRECT',
            streamKey: rMeta.entityUrn || entityKey
          };
        }
        if (rMeta.manifestUrl) {
          state.manifestUrl = rMeta.manifestUrl;
          return {
            url: rMeta.manifestUrl,
            isStream: true,
            format: rMeta.manifestUrl.includes('.m3u8') ? 'HLS' : 'DASH',
            streamKey: rMeta.entityUrn || entityKey,
            allSegments: []
          };
        }
      }

      // Check performance resource entries for manifests or progressive MP4s
      try {
        const resEntries = performance.getEntriesByType('resource');
        for (let i = resEntries.length - 1; i >= 0; i--) {
          const name = resEntries[i].name;
          if (isNonMediaUrl(name)) continue;
          const matchesKey = entityKey ? entityKeysMatch(entityKey, name) : true;

          if (matchesKey) {
            if (name.includes('/mp4-') || (name.includes('/playlist/vid/') && (name.endsWith('.mp4') || name.includes('mp4_')))) {
              state.progressiveUrl = name;
              return {
                progressiveUrl: name,
                isStream: false,
                format: 'DIRECT',
                streamKey: entityKey
              };
            }
            if (name.includes('/dash/') || name.includes('.mpd') || name.includes('.m3u8') || (name.includes('/playlist/vid/') && name.includes('manifest'))) {
              if (queue) queue.registerManifest(name);
              state.manifestUrl = name;
              return {
                url: name,
                isStream: true,
                format: name.includes('.m3u8') ? 'HLS' : 'DASH',
                streamKey: entityKey,
                allSegments: []
              };
            }
          }
        }
      } catch (e) {}

      // Query Background Service Worker for this exact blob's playlist
      if (currentSrc.startsWith('blob:')) {
        try {
          const bgBlobResp = await safeSendMessage({
            action: 'getPlaylistForBlob',
            blobUrl: currentSrc
          });
          if (bgBlobResp && bgBlobResp.success && bgBlobResp.playlist) {
            const pl = bgBlobResp.playlist;
            if (pl.progressiveUrl) {
              state.progressiveUrl = pl.progressiveUrl;
              return {
                progressiveUrl: pl.progressiveUrl,
                isStream: false,
                format: 'DIRECT',
                streamKey: pl.entityKey || entityKey
              };
            }
            if (pl.manifestUrl) {
              return {
                url: pl.manifestUrl,
                isStream: true,
                format: pl.format,
                streamKey: pl.entityKey || entityKey,
                allSegments: pl.playlistUrls || []
              };
            }
          }
        } catch (e) {}
      }

      // Check local GarrettQueue by entityKey & duration
      if (queue) {
        const localMatch = queue.findStreamForVideo(videoInfo);
        if (localMatch) {
          if (localMatch.progressiveUrl) {
            state.progressiveUrl = localMatch.progressiveUrl;
            return {
              progressiveUrl: localMatch.progressiveUrl,
              isStream: false,
              format: 'DIRECT',
              streamKey: localMatch.entityKey || entityKey
            };
          }
          if (localMatch.manifestUrl) {
            return {
              url: localMatch.manifestUrl,
              manifestXml: localMatch.manifestXml,
              isStream: true,
              format: localMatch.format || 'DASH',
              streamKey: localMatch.streamKey || entityKey,
              allSegments: localMatch.getAllSegmentUrls ? localMatch.getAllSegmentUrls() : (localMatch.allSegments || []),
              entry: localMatch
            };
          }
        }
      }

      // Query Background Service Worker Queue
      try {
        const resp = await safeSendMessage({
          action: 'getStreamForVideo',
          videoInfo
        });
        if (resp && resp.success && resp.stream) {
          const s = resp.stream;
          if (s.progressiveUrl) {
            state.progressiveUrl = s.progressiveUrl;
            return {
              progressiveUrl: s.progressiveUrl,
              isStream: false,
              format: 'DIRECT',
              streamKey: s.streamKey || entityKey
            };
          }
          if (s.manifestUrl) {
            return {
              url: s.manifestUrl,
              isStream: s.isStream,
              format: s.format || 'DASH',
              streamKey: s.streamKey || entityKey,
              allSegments: (s.segments || []).map(seg => seg.url),
              entry: s
            };
          }
        }
      } catch (e) {}

      await new Promise(r => setTimeout(r, 200));
    }

    return null;
  }

  async function downloadStreamInPage(state, streamUrl, manifestText = '') {
    if (state.isDownloading) return;
    state.isDownloading = true;

    const textEl = state.mainBtn ? state.mainBtn.querySelector('.vbs-btn-text') : null;
    if (textEl) {
      textEl.style.display = 'inline';
      textEl.textContent = '0%';
    }

    try {
      const assembler = window.GarrettStreamAssembler || globalThis.GarrettStreamAssembler;
      if (!assembler || !assembler.downloadStream) {
        throw new Error('Stream assembler engine not loaded.');
      }

      const customFetchText = async (url) => {
        try {
          const r = await fetch(url);
          if (r.ok) return await r.text();
          throw new Error(`HTTP ${r.status}`);
        } catch (e) {
          const bg = await safeSendMessage({ action: 'fetchText', url });
          if (bg && bg.success && bg.text) return bg.text;
          throw e;
        }
      };

      const customFetchBuffer = async (url) => {
        try {
          const r = await fetch(url);
          if (r.ok) return await r.arrayBuffer();
          throw new Error(`HTTP ${r.status}`);
        } catch (e) {
          const bg = await safeSendMessage({ action: 'fetchBuffer', url });
          if (bg && bg.success && bg.data) {
            const bin = atob(bg.data);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            return buf.buffer;
          }
          throw e;
        }
      };

      const onProgress = (completed, total, pct) => {
        if (textEl) {
          textEl.style.display = 'inline';
          textEl.textContent = `${pct}%`;
        }
        safeSendMessage({ action: 'streamProgress', videoId: state.id, completed, total, pct });
      };

      const result = await assembler.downloadStream(streamUrl, onProgress, {
        manifestText,
        customFetchText,
        customFetchBuffer
      });

      const filename = generateFilename(state.video, result.ext || 'mp4');
      const saved = downloadBlobDirectly(result.blob, filename);

      if (saved) {
        showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
      }
      safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });

      if (textEl) {
        textEl.style.display = 'inline';
        textEl.textContent = 'Kept!';
        setTimeout(() => {
          if (textEl) {
            textEl.textContent = '';
            textEl.style.display = 'none';
          }
        }, 4000);
      }
    } catch (err) {
      console.error('[Garrett] Stream download error:', err);
      showToast(`Stream download error: ${err.message}`, 5000);
      if (textEl) {
        textEl.textContent = '';
        textEl.style.display = 'none';
      }
    } finally {
      state.isDownloading = false;
    }
  }

  async function downloadFromSegmentQueue(state, segmentUrls) {
    if (state.isDownloading) return;
    state.isDownloading = true;

    const textEl = state.mainBtn ? state.mainBtn.querySelector('.vbs-btn-text') : null;
    if (textEl) {
      textEl.style.display = 'inline';
      textEl.textContent = '0%';
    }

    try {
      const assembler = window.GarrettStreamAssembler || globalThis.GarrettStreamAssembler;
      if (!assembler || !assembler.assembleSegments) {
        throw new Error('Stream assembler engine not loaded.');
      }

      const customFetchBuffer = async (url) => {
        try {
          const r = await fetch(url);
          if (r.ok) return await r.arrayBuffer();
          throw new Error(`HTTP ${r.status}`);
        } catch (e) {
          const bg = await safeSendMessage({ action: 'fetchBuffer', url });
          if (bg && bg.success && bg.data) {
            const bin = atob(bg.data);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            return buf.buffer;
          }
          throw e;
        }
      };

      const onProgress = (completed, total, pct) => {
        if (textEl) {
          textEl.style.display = 'inline';
          textEl.textContent = `${pct}%`;
        }
        safeSendMessage({ action: 'streamProgress', videoId: state.id, completed, total, pct });
      };

      const result = await assembler.assembleSegments(segmentUrls, 'video/mp4', 'mp4', onProgress, customFetchBuffer);
      const filename = generateFilename(state.video, 'mp4');
      const saved = downloadBlobDirectly(result.blob, filename);

      if (saved) {
        showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
      }
      safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });

      if (textEl) {
        textEl.style.display = 'inline';
        textEl.textContent = 'Kept!';
        setTimeout(() => {
          if (textEl) {
            textEl.textContent = '';
            textEl.style.display = 'none';
          }
        }, 4000);
      }
    } catch (err) {
      console.error('[Garrett] Segment queue download error:', err);
      showToast(`Segment assembly error: ${err.message}`, 5000);
      if (textEl) {
        textEl.textContent = '';
        textEl.style.display = 'none';
      }
    } finally {
      state.isDownloading = false;
    }
  }

  async function keepVideoNow(state) {
    if (state.isDownloading) {
      showToast('Garrett is already preserving this stream...');
      return;
    }

    const quoteObj = keeper ? keeper.getRandomKeeperQuote() : null;
    if (quoteObj) {
      showToast(`"${quoteObj.quote}"`);
    } else {
      showToast('Garrett is keeping this video in background...');
    }

    const textEl = state.mainBtn ? state.mainBtn.querySelector('.vbs-btn-text') : null;
    if (textEl) {
      textEl.style.display = 'inline';
      textEl.textContent = 'Seeking...';
    }

    try {
      // 1. Resolve stream via Garrett Multi-Tier Discovery
      const stream = await resolveStreamForVideo(state, 2500);

      // Path 1: Pristine Standalone Progressive MP4 (Full Duration, HD, Complete Audio)
      const progUrl = (stream && stream.progressiveUrl) || state.progressiveUrl;
      if (progUrl) {
        if (textEl) {
          textEl.style.display = 'inline';
          textEl.textContent = 'Saving...';
        }
        const filename = generateFilename(state.video, 'mp4');
        showToast(`Downloading full video: ${filename}...`);

        safeSendMessage({
          action: 'downloadUrl',
          url: progUrl,
          filename: filename,
          saveAs: false
        }, async (resp) => {
          if (resp && resp.success) {
            showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
            if (textEl) {
              textEl.style.display = 'inline';
              textEl.textContent = 'Kept!';
            }
          } else {
            // Background download fallback via fetch in page
            try {
              const r = await fetch(progUrl);
              const blob = await r.blob();
              downloadBlobDirectly(blob, filename);
              showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
              if (textEl) {
                textEl.style.display = 'inline';
                textEl.textContent = 'Kept!';
              }
            } catch (err) {
              showToast(`Download error: ${err.message}`);
              if (textEl) {
                textEl.textContent = '';
                textEl.style.display = 'none';
              }
            }
          }
          setTimeout(() => {
            if (textEl) {
              textEl.textContent = '';
              textEl.style.display = 'none';
            }
          }, 4000);
        });
        return;
      }

      // Path 2: Full Manifest Stream (DASH or HLS assembled)
      if (stream && stream.url) {
        await downloadStreamInPage(state, stream.url, stream.manifestXml || '');
        return;
      }

      // Path 3: Direct standalone MP4/WebM URL on video tag
      const src = state.video.currentSrc || state.video.src || '';
      if (src && !src.startsWith('blob:')) {
        const ext = src.split('.').pop().split(/[?#]/)[0] || 'mp4';
        const filename = generateFilename(state.video, ext);
        safeSendMessage({ action: 'downloadUrl', url: src, filename, saveAs: false });
        showToast(`Downloading ${filename}...`);
        if (textEl) {
          textEl.style.display = 'inline';
          textEl.textContent = 'Kept!';
        }
        setTimeout(() => {
          if (textEl) {
            textEl.textContent = '';
            textEl.style.display = 'none';
          }
        }, 3000);
        return;
      }

      // Path 3.5: Derived Manifest from Intercepted Segment URL
      if (stream && stream.allSegments && stream.allSegments.length > 0) {
        const segUrl = stream.allSegments[0];
        let derivedManifest = null;
        if (segUrl.includes('/playlist/vid/')) {
          if (segUrl.includes('/segment/')) {
            derivedManifest = segUrl.replace(/\/segment\/[^\/]+\/[^\/?#]+/, '/dash/playlist.mpd');
          } else if (/\/[0-9]+\/[0-9]+(?:\?|$)/.test(segUrl)) {
            derivedManifest = segUrl.replace(/\/[0-9]+\/[0-9]+(\?|$)/, '/dash/playlist.mpd$1');
          }
        }
        if (derivedManifest) {
          try {
            await downloadStreamInPage(state, derivedManifest);
            return;
          } catch (e) {
            console.warn('[Garrett] Derived manifest download attempt:', e.message);
          }
        }
      }

      // Path 4: Complete Segment Queue (ONLY if segment count represents >= 85% of duration!)
      if (stream && stream.allSegments && stream.allSegments.length > 0) {
        const duration = state.video.duration || 0;
        const expectedMinSegments = duration > 10 ? Math.floor((duration / 4) * 0.85) : 2;

        if (stream.allSegments.length >= expectedMinSegments) {
          await downloadFromSegmentQueue(state, stream.allSegments);
          return;
        }
      }

      // Path 5: Final active media stream lock from performance resource entries
      try {
        const resEntries = performance.getEntriesByType('resource');
        for (let i = resEntries.length - 1; i >= 0; i--) {
          const name = resEntries[i].name;
          if (isNonMediaUrl(name)) continue;
          if (name.includes('/playlist/vid/')) {
            if (name.includes('/mp4-') || name.endsWith('.mp4')) {
              const filename = generateFilename(state.video, 'mp4');
              safeSendMessage({ action: 'downloadUrl', url: name, filename, saveAs: false });
              showToast(`Downloading full video: ${filename}...`);
              if (textEl) {
                textEl.style.display = 'inline';
                textEl.textContent = 'Kept!';
              }
              setTimeout(() => {
                if (textEl) {
                  textEl.textContent = '';
                  textEl.style.display = 'none';
                }
              }, 4000);
              return;
            }
            if (name.includes('/dash/') || name.includes('.mpd') || name.includes('.m3u8')) {
              await downloadStreamInPage(state, name);
              return;
            }
            if (name.includes('/segment/') || /\/[0-9]+\/[0-9]+(\?|$)/.test(name)) {
              const derived = name.includes('/segment/')
                ? name.replace(/\/segment\/[^\/]+\/[^\/?#]+/, '/dash/playlist.mpd')
                : name.replace(/\/[0-9]+\/[0-9]+(\?|$)/, '/dash/playlist.mpd$1');
              await downloadStreamInPage(state, derived);
              return;
            }
          }
        }
      } catch (e) {}

      // STRICT PROTECTION: NEVER save 4-second partial cuts!
      showToast('Stream is buffering. Please play 2-3 seconds of the video so Garrett can lock onto the stream, then click download.', 5500);
      if (textEl) {
        textEl.textContent = '';
        textEl.style.display = 'none';
      }
    } catch (err) {
      console.error('[Garrett] keepVideoNow error:', err);
      showToast(`Error keeping video: ${err.message}`, 5000);
      if (textEl) {
        textEl.textContent = '';
        textEl.style.display = 'none';
      }
    } finally {
      state.isDownloading = false;
    }
  }

  function scanForVideos() {
    const videos = findAllVideos(document);
    videos.forEach(v => registerVideo(v));
  }

  // MutationObserver with deep shadow DOM checks
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        shouldScan = true;
        break;
      }
    }
    if (shouldScan) {
      scanForVideos();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Initial scan
  scanForVideos();

  // Listen to messages from popup or background
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ pong: true });
      return true;
    }

    if (request.action === 'scanAndGetVideos') {
      scanForVideos();
      const list = [];
      videoRegistry.forEach((state) => {
        const v = state.video;
        const currentSrc = v.currentSrc || v.src || '';
        const format = state.progressiveUrl ? 'MP4' : (state.manifestUrl ? (state.manifestUrl.includes('.m3u8') ? 'HLS' : 'DASH') : (currentSrc.startsWith('blob:') ? 'DASH' : 'MP4'));
        const streamUrl = state.progressiveUrl || state.manifestUrl || currentSrc;
        list.push({
          id: state.id,
          src: currentSrc,
          isBlob: currentSrc.startsWith('blob:'),
          entityKey: state.entityKey,
          poster: state.poster,
          duration: v.duration || 0,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0,
          muted: v.muted,
          format: format,
          streamUrl: streamUrl,
          hasProgressive: !!state.progressiveUrl,
          hasManifest: !!state.manifestUrl
        });
      });
      sendResponse({ videos: list });
      return true;
    }

    if (request.action === 'harvestVideo' || request.action === 'keepVideo') {
      const state = Array.from(videoRegistry.values()).find(s => s.id === request.videoId) ||
                    Array.from(videoRegistry.values())[0];
      if (state) {
        if (request.streamUrl) {
          if (request.streamUrl.includes('.mpd') || request.streamUrl.includes('/dash/') || request.streamUrl.includes('.m3u8')) {
            state.manifestUrl = request.streamUrl;
          } else if (request.streamUrl.endsWith('.mp4') || request.streamUrl.includes('/mp4-')) {
            state.progressiveUrl = request.streamUrl;
          }
        }
        if (request.manifestXml) {
          state.manifestXml = request.manifestXml;
        }
        keepVideoNow(state)
          .then((res) => sendResponse({ success: true, ...res }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
      } else {
        sendResponse({ success: false, error: 'Video not found' });
      }
      return true;
    }

    if (request.action === 'directDownload') {
      const state = Array.from(videoRegistry.values()).find(s => s.id === request.videoId) ||
                    Array.from(videoRegistry.values())[0];
      if (state) {
        const dlUrl = state.progressiveUrl || state.video.currentSrc || state.video.src || '';
        if (dlUrl && !dlUrl.startsWith('blob:')) {
          const filename = generateFilename(state.video, 'mp4');
          safeSendMessage({ action: 'downloadUrl', url: dlUrl, filename, saveAs: false });
          showToast(`Downloading ${filename}...`);
          sendResponse({ success: true });
        } else {
          keepVideoNow(state);
          sendResponse({ success: true, redirected: true });
        }
      } else {
        sendResponse({ success: false, error: 'Video not found' });
      }
      return true;
    }

    if (request.action === 'startKeepStream') {
      const state = Array.from(videoRegistry.values()).find(s => s.id === request.videoId) ||
                    Array.from(videoRegistry.values())[0];
      if (state) {
        downloadStreamInPage(state, request.url);
      }
      sendResponse({ success: true });
      return true;
    }

    if (request.action === 'streamDiscovered' && request.stream) {
      if (queue && request.stream.url) {
        queue.registerManifest(request.stream.url, '', request.stream);
      }
      sendResponse({ received: true });
      return true;
    }

    if (request.action === 'segmentDiscovered' && request.url) {
      if (queue) {
        queue.registerSegment(request.url);
      }
      sendResponse({ received: true });
      return true;
    }
  });
}

})();
