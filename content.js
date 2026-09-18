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

  // MediaSource to Blob mapping for 100% video-to-SourceBuffer isolation
  const mediaSourceToBlob = new Map();
  const blobToMediaSource = new Map();

  // In-page registry of already kept videos
  const keptVideosRegistry = new Set();

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

  function isGenuineProgressiveMp4Url(url) {
    if (!url || typeof url !== 'string') return false;
    if (isNonMediaUrl(url)) return false;
    const clean = url.split('?')[0].toLowerCase();
    if (
      clean.endsWith('.m4s') ||
      clean.endsWith('.ts') ||
      clean.endsWith('.init') ||
      clean.endsWith('/init') ||
      clean.includes('init.mp4') ||
      clean.includes('iso.segment') ||
      clean.includes('/segment/') ||
      clean.includes('/chunk/') ||
      clean.includes('output_hls') ||
      clean.endsWith('.mpd') ||
      clean.endsWith('.m3u8') ||
      clean.includes('/dash/') ||
      clean.includes('manifest') ||
      /\/[0-9]+\/[0-9]+$/.test(clean) ||
      /\/[0-9]+\/[0-9]+(?:\?|$)/.test(url)
    ) {
      return false;
    }
    return (
      clean.endsWith('.mp4') ||
      clean.endsWith('.webm') ||
      clean.endsWith('.m4v') ||
      clean.includes('/playlist/vid/v2/') ||
      (clean.includes('/playlist/vid/') && !clean.includes('/dash/')) ||
      url.includes('progressive')
    );
  }

  function extractMediaUrlFromItem(item) {
    if (!item) return null;
    if (typeof item === 'string') return item;
    if (typeof item.url === 'string') return item.url;
    if (Array.isArray(item.streamingLocations)) {
      for (const loc of item.streamingLocations) {
        if (!loc) continue;
        if (typeof loc === 'string') return loc;
        if (typeof loc.url === 'string') return loc.url;
      }
    }
    const singleLoc = item.streamingLocation || item.location;
    if (singleLoc) {
      if (typeof singleLoc === 'string') return singleLoc;
      if (typeof singleLoc.url === 'string') return singleLoc.url;
    }
    return null;
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

  const extractStreamKey = (typeof window.GarrettQueue !== 'undefined' && window.GarrettQueue.extractStreamKey) || function (url) {
    if (!url || typeof url !== 'string') return '';
    try {
      if (url.includes('/playlist/vid/')) {
        const after = url.split('/playlist/vid/')[1].split('?')[0];
        const parts = after.split('/').filter(Boolean);
        for (const part of parts) {
          if (/^(v2|dash|mp4|hls|beta|vms|segment)$/i.test(part)) continue;
          if (/^[A-Za-z0-9_-]{8,}$/.test(part)) return part;
        }
      }
      const urnMatch = url.match(/(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i);
      if (urnMatch) return urnMatch[1];
      return '';
    } catch {
      return '';
    }
  };

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

      const streamKey = extractStreamKey(e.detail.url);
      for (const state of videoRegistry.values()) {
        const v = state.video;
        const keyMatch = (state.entityKey && entityKeysMatch(state.entityKey, e.detail.url)) ||
                         (state.allKeys && Array.from(state.allKeys).some(k => entityKeysMatch(k, e.detail.url)));
        const fallbackMatch = !keyMatch && (
          (videoRegistry.size === 1) ||
          (v && !v.paused && !state.manifestUrl)
        );

        if (keyMatch || fallbackMatch) {
          if (!state.manifestUrl || keyMatch) {
            state.manifestUrl = e.detail.url;
            state.manifestXml = e.detail.text || '';
            if (streamKey && !state.mediaKey) state.mediaKey = streamKey;
            if (streamKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
              state.entityKey = streamKey;
            }
          }
        }
      }
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

      const streamKey = extractStreamKey(e.detail.url);
      for (const state of videoRegistry.values()) {
        const v = state.video;
        const hasKeys = !!(state.entityKey || (state.allKeys && state.allKeys.size > 0));
        const matchesState = (state.entityKey && entityKeysMatch(state.entityKey, e.detail.url)) ||
                             (state.allKeys && Array.from(state.allKeys).some(k => entityKeysMatch(k, e.detail.url))) ||
                             (!hasKeys && videoRegistry.size === 1) ||
                             (!hasKeys && v && !v.paused);
        if (matchesState) {
          if (!state.allSegments) state.allSegments = [];
          if (!state.allSegments.includes(e.detail.url)) {
            state.allSegments.push(e.detail.url);
          }
          if (streamKey && !state.mediaKey) state.mediaKey = streamKey;
          if (streamKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
            state.entityKey = streamKey;
          }
        }
      }
    }
  });

  window.addEventListener('__GARRETT_BLOB_CREATED__', (e) => {
    if (e.detail && e.detail.blobUrl) {
      if (e.detail.mediaSourceId) {
        mediaSourceToBlob.set(e.detail.mediaSourceId, e.detail.blobUrl);
        blobToMediaSource.set(e.detail.blobUrl, e.detail.mediaSourceId);
      }
      if (queue) {
        queue.registerBlobStream(e.detail.blobUrl, { mediaSourceId: e.detail.mediaSourceId });
      }
    }
  });

  window.addEventListener('__GARRETT_SOURCE_CHUNK__', (e) => {
    if (e.detail && e.detail.chunk) {
      const chunk = e.detail.chunk;
      const isInit = isInitBox(chunk);
      if (isInit) {
        lastInitChunk = chunk;
      }
      const msId = e.detail.mediaSourceId;
      const targetBlobUrl = msId ? mediaSourceToBlob.get(msId) : null;

      for (const state of videoRegistry.values()) {
        const v = state.video;
        if (!v) continue;
        const vSrc = v.currentSrc || v.src || '';
        const matches = targetBlobUrl
          ? (vSrc === targetBlobUrl)
          : (videoRegistry.size === 1 || !v.paused);

        if (matches) {
          if (isInit) {
            state.initChunk = chunk;
          } else {
            if (!state.capturedChunks) state.capturedChunks = [];
            state.capturedChunks.push(chunk);
          }
        }
      }
      recentChunks.push(chunk);
      if (recentChunks.length > 200) recentChunks.shift();
    }
  });

  const discoveredMetadataCache = [];

  window.addEventListener('__GARRETT_METADATA_DISCOVERED__', (e) => {
    if (e.detail) {
      const meta = e.detail;
      discoveredMetadataCache.push(meta);
      if (discoveredMetadataCache.length > 60) discoveredMetadataCache.shift();

      for (const state of videoRegistry.values()) {
        const hasKeys = !!(state.entityKey || (state.allKeys && state.allKeys.size > 0));
        const matches = (meta.entityUrn && state.entityKey && entityKeysMatch(state.entityKey, meta.entityUrn)) ||
                        (meta.mediaKey && state.mediaKey && entityKeysMatch(state.mediaKey, meta.mediaKey)) ||
                        (meta.allKeys && state.entityKey && meta.allKeys.some(k => entityKeysMatch(state.entityKey, k))) ||
                        (state.allKeys && meta.entityUrn && Array.from(state.allKeys).some(k => entityKeysMatch(k, meta.entityUrn))) ||
                        (!hasKeys && videoRegistry.size === 1);

        if (matches) {
          if (meta.progressiveUrl && !state.progressiveUrl) {
            state.progressiveUrl = meta.progressiveUrl;
          }
          if (meta.manifestUrl && !state.manifestUrl) {
            state.manifestUrl = meta.manifestUrl;
          }
          if (meta.duration && meta.duration > 0 && (!state.duration || state.duration <= 5)) {
            state.duration = meta.duration;
          }
          if (meta.entityUrn && !state.entityKey) {
            state.entityKey = meta.entityUrn;
          }
        }
      }
    }
  });

  window.addEventListener('__GARRETT_REACT_STREAM_FOUND__', (e) => {
    if (e.detail) {
      if (e.detail.blobUrl) reactStreamCache.set(e.detail.blobUrl, e.detail);
      if (e.detail.videoId) reactStreamCache.set(e.detail.videoId, e.detail);

      for (const state of videoRegistry.values()) {
        const v = state.video;
        const matchesVideo = (e.detail.videoId && state.id === e.detail.videoId) ||
                             (v && e.detail.blobUrl && (v.currentSrc === e.detail.blobUrl || v.src === e.detail.blobUrl)) ||
                             (videoRegistry.size === 1);
        if (matchesVideo) {
          if (e.detail.progressiveUrl) state.progressiveUrl = e.detail.progressiveUrl;
          if (e.detail.manifestUrl) state.manifestUrl = e.detail.manifestUrl;
          if (e.detail.entityUrn && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
            state.entityKey = e.detail.entityUrn;
          }
          if (e.detail.mediaKey && !state.mediaKey) state.mediaKey = e.detail.mediaKey;
          if (e.detail.allKeys && state.allKeys) {
            for (const k of e.detail.allKeys) state.allKeys.add(k);
          }
          if (e.detail.duration && (!state.duration || state.duration <= 5)) {
            state.duration = e.detail.duration;
          }
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
      if (!isGenuineProgressiveMp4Url(progUrl)) return;
      const streamKey = extractStreamKey(progUrl);
      for (const state of videoRegistry.values()) {
        const v = state.video;
        const hasKeys = !!(state.entityKey || (state.allKeys && state.allKeys.size > 0));
        const matchesState = (state.entityKey && entityKeysMatch(state.entityKey, progUrl)) ||
                             (state.allKeys && Array.from(state.allKeys).some(k => entityKeysMatch(k, progUrl))) ||
                             (!hasKeys && videoRegistry.size === 1) ||
                             (!hasKeys && v && !v.paused);
        if (matchesState) {
          state.progressiveUrl = progUrl;
          if (streamKey && !state.mediaKey) state.mediaKey = streamKey;
          if (streamKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
            state.entityKey = streamKey;
          }
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
   * Collects both media-level keys (digitalmediaAsset) and post-level URNs (activity/ugcPost).
   */
  function extractVideoEntityInfoFromDom(video) {
    const info = {
      primaryKey: '',
      mediaKey: '',
      activityUrn: '',
      allKeys: new Set()
    };
    if (!video) return info;

    // 1. Check direct poster attribute on video
    const poster = video.getAttribute('poster') || video.poster || '';
    if (poster) {
      const pm = poster.match(/(?:dms\/image\/(?:sync\/)?(?:v2\/)?|videocover[^\/]*\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i) ||
                 poster.match(/([CD]\d{2}[A-Za-z0-9_-]{8,})/);
      if (pm) {
        info.mediaKey = pm[1];
        info.allKeys.add(pm[1]);
      }
    }

    // 2. Find closest post container (never stop at inner Ember divs)
    const playerWrapper = video.closest('.feed-shared-linkedin-video, .video-js, [class*="player"]') || video.parentElement;
    const postContainer = video.closest('.feed-shared-update-v2, .occludable-update, [data-urn*="activity"], [data-urn*="ugcPost"], [data-entity-urn], article') || playerWrapper;
    const container = postContainer || playerWrapper;
    if (!container) {
      info.primaryKey = info.mediaKey;
      return info;
    }

    // 3. Search thumbnail / preview divs inside this specific container
    const thumbElements = container.querySelectorAll('[style*="videocover"], [style*="dms/image"], [style*="background"], img');
    for (const el of thumbElements) {
      const src = el.src || el.getAttribute('src') || el.getAttribute('style') || '';
      const m = src.match(/(?:dms\/image\/(?:sync\/)?(?:v2\/)?|videocover[^\/]*\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i) ||
                src.match(/([CD]\d{2}[A-Za-z0-9_-]{8,})/);
      if (m) {
        if (!info.mediaKey) info.mediaKey = m[1];
        info.allKeys.add(m[1]);
      }
    }

    // 4. Search data attributes in this container and its ancestors
    const searchRoots = [postContainer, playerWrapper, video.parentElement].filter(Boolean);
    const urnElements = [];
    for (const r of searchRoots) {
      urnElements.push(r);
      const children = r.querySelectorAll('[data-urn], [data-entity-urn], [data-chameleon-urn], [data-activity-urn]');
      for (const c of children) urnElements.push(c);
    }
    
    // First pass: media IDs (digitalmediaAsset, fs_video, dms, video)
    for (const el of urnElements) {
      for (const attrName of ['data-entity-urn', 'data-urn', 'data-chameleon-urn', 'data-activity-urn']) {
        const val = el.getAttribute ? el.getAttribute(attrName) : '';
        if (val) {
          const vm = val.match(/(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i) || val.match(/([CD]\d{2}[A-Za-z0-9_-]{8,})/);
          if (vm) {
            if (!info.mediaKey) info.mediaKey = vm[1];
            info.allKeys.add(vm[1]);
          }
        }
      }
    }

    // Second pass: activity/post URNs
    for (const el of urnElements) {
      for (const attrName of ['data-urn', 'data-entity-urn', 'data-chameleon-urn', 'data-activity-urn']) {
        const val = el.getAttribute ? el.getAttribute(attrName) : '';
        if (val) {
          const am = val.match(/urn:li:(?:activity|ugcPost|share):([0-9]{10,})/i);
          if (am) {
            if (!info.activityUrn) info.activityUrn = am[1];
            info.allKeys.add(am[1]);
            info.allKeys.add(am[0]);
          }
        }
      }
    }

    // 5. Scoped innerHTML search for media ID
    const html = container.innerHTML || '';
    const hm = html.match(/(?:dms\/image\/(?:sync\/)?(?:v2\/)?|videocover[^\/]*\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i) ||
               html.match(/([CD]\d{2}[A-Za-z0-9_-]{8,})/);
    if (hm) {
      if (!info.mediaKey) info.mediaKey = hm[1];
      info.allKeys.add(hm[1]);
    }

    info.primaryKey = info.mediaKey || info.activityUrn || '';
    return info;
  }

  function extractVideoEntityKeyFromDom(video) {
    const info = extractVideoEntityInfoFromDom(video);
    return info.primaryKey;
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

  /**
   * Scrapes visible player timer text and seekbar attributes from DOM to determine
   * ground-truth presentation duration, bypassing MSE buffered window limitations (e.g. 4.0s).
   */
  function extractVideoDurationFromDom(video) {
    if (!video) return 0;
    try {
      const playerWrapper = video.closest('.feed-shared-linkedin-video, .video-js, [class*="player"]');
      const postRoot = video.closest('.feed-shared-update-v2, .occludable-update, [data-urn*="activity"], [data-urn*="ugcPost"], [data-entity-urn], article');
      const searchRoots = [playerWrapper, postRoot, video.parentElement].filter(Boolean);

      let maxSec = 0;

      // 1. Check progress sliders and range inputs (e.g., aria-valuemax="84" or max="113")
      for (const root of searchRoots) {
        const sliders = root.querySelectorAll('[role="slider"], input[type="range"], [class*="progress"], [class*="seekbar"]');
        for (const s of sliders) {
          const vMax = parseFloat(s.getAttribute('aria-valuemax') || s.getAttribute('max') || '0');
          if (vMax > maxSec && isFinite(vMax)) maxSec = vMax;
        }
      }

      // 2. Check candidate timer text across player and post roots
      for (const root of searchRoots) {
        const candidates = root.querySelectorAll('time, span, div, p, [aria-label*="duration"], [aria-label*="time"]');
        for (const el of candidates) {
          const aria = el.getAttribute('aria-label') || '';
          if (aria && aria.length < 60) {
            const ariaMatches = [...aria.matchAll(/\b(?:(\d+):)?(\d{1,2}):(\d{2})\b/g)];
            for (const m of ariaMatches) {
              const hours = m[1] ? parseInt(m[1], 10) : 0;
              const mins = parseInt(m[2], 10);
              const secs = parseInt(m[3], 10);
              const total = hours * 3600 + mins * 60 + secs;
              if (total > maxSec) maxSec = total;
            }
            const verbalMatches = [...aria.matchAll(/(\d+)\s*(?:minutes?|mins?|m)\s*(?:and\s*)?(\d+)\s*(?:seconds?|secs?|s)/gi)];
            for (const vm of verbalMatches) {
              const mins = parseInt(vm[1], 10);
              const secs = parseInt(vm[2], 10);
              const total = mins * 60 + secs;
              if (total > maxSec) maxSec = total;
            }
            const secMatches = [...aria.matchAll(/(\d+)\s*(?:seconds?|secs?|s)\b/gi)];
            for (const sm of secMatches) {
              const secs = parseInt(sm[1], 10);
              if (secs > maxSec) maxSec = secs;
            }
          }

          let text = (el.textContent || '').trim();
          if (!text || text.length > 40) continue;
          if (text.includes('/')) {
            const parts = text.split('/');
            text = parts[parts.length - 1].trim();
          }
          const matches = [...text.matchAll(/\b(?:(\d+):)?(\d{1,2}):(\d{2})\b/g)];
          for (const m of matches) {
            const hours = m[1] ? parseInt(m[1], 10) : 0;
            const mins = parseInt(m[2], 10);
            const secs = parseInt(m[3], 10);
            const total = hours * 3600 + mins * 60 + secs;
            if (total > maxSec) maxSec = total;
          }
          const verbalMatches = [...text.matchAll(/(\d+)\s*(?:minutes?|mins?|m)\s*(?:and\s*)?(\d+)\s*(?:seconds?|secs?|s)/gi)];
          for (const vm of verbalMatches) {
            const mins = parseInt(vm[1], 10);
            const secs = parseInt(vm[2], 10);
            const total = mins * 60 + secs;
            if (total > maxSec) maxSec = total;
          }
        }
      }

      if (maxSec > 3) return maxSec;
    } catch (e) {}
    return 0;
  }

  /**
   * Resolves true presentation duration across DOM UI, embedded metadata, manifest, and video tag.
   * If video is streaming via MSE blob:, NEVER treats <= 5.0s (initial buffer window) as the presentation duration.
   */
  function resolveRealVideoDuration(state) {
    const domDur = state && state.video ? extractVideoDurationFromDom(state.video) : 0;
    if (domDur > 5) {
      if (state && (!state.duration || state.duration <= 5)) state.duration = domDur;
      return domDur;
    }
    if (state && state.duration && state.duration > 5 && isFinite(state.duration)) {
      return state.duration;
    }

    // Check manifestXml for mediaPresentationDuration if available
    if (state && state.manifestXml) {
      const m = state.manifestXml.match(/\bmediaPresentationDuration=["']([^"']+)["']/i) ||
                state.manifestXml.match(/<Period\b[^>]*\bduration=["']([^"']+)["']/i);
      const assembler = window.GarrettStreamAssembler || globalThis.GarrettStreamAssembler;
      if (m && assembler && assembler.parseIsoDuration) {
        const pDur = assembler.parseIsoDuration(m[1]);
        if (pDur > 5) {
          state.duration = pDur;
          return pDur;
        }
      }
    }

    // Check React stream cache
    const currentSrc = state && state.video ? (state.video.currentSrc || state.video.src || '') : '';
    if (reactStreamCache.has(state.id)) {
      const rMeta = reactStreamCache.get(state.id);
      if (rMeta && rMeta.duration && rMeta.duration > 5) {
        state.duration = rMeta.duration;
        return rMeta.duration;
      }
    }
    if (currentSrc && reactStreamCache.has(currentSrc)) {
      const rMeta = reactStreamCache.get(currentSrc);
      if (rMeta && rMeta.duration && rMeta.duration > 5) {
        state.duration = rMeta.duration;
        return rMeta.duration;
      }
    }

    const vidDur = (state && state.video && typeof state.video.duration === 'number' && isFinite(state.video.duration))
      ? state.video.duration
      : 0;

    const isBlob = currentSrc.startsWith('blob:');
    if (vidDur > 5) {
      return vidDur;
    }
    if (!isBlob && vidDur > 0) {
      return vidDur;
    }
    return 0;
  }

  function matchesVideoMetadata(videoState, meta) {
    if (!meta) return false;

    const targetKeys = [
      videoState.entityKey,
      videoState.mediaKey,
      videoState.activityUrn,
      ...(videoState.allKeys ? Array.from(videoState.allKeys) : [])
    ].filter(Boolean);

    const metaKeys = [
      meta.entityUrn,
      meta.mediaKey,
      ...(meta.allKeys || [])
    ].filter(Boolean);

    if (targetKeys.length > 0) {
      for (const tk of targetKeys) {
        for (const mk of metaKeys) {
          if (entityKeysMatch(tk, mk)) return true;
        }
      }
      return false;
    }

    if (videoRegistry.size === 1) return true;
    return false;
  }

  let cachedEmbeddedMetadata = null;
  let cachedEmbeddedMetadataTime = 0;

  function extractAllEmbeddedVideoMetadata() {
    const now = Date.now();
    if (cachedEmbeddedMetadata && (now - cachedEmbeddedMetadataTime) < 3000) {
      return cachedEmbeddedMetadata;
    }

    const results = [];
    const codeEls = document.querySelectorAll('code[id*="bpr-guid"], script[type="application/json"], script[id*="bpr-guid"], script[data-source="voyager"]');
    for (const el of codeEls) {
      const text = el.textContent || '';
      if (!text.includes('videoPlayMetadata') && !text.includes('progressiveStreams') && !text.includes('adaptiveStreams')) {
        continue;
      }
      try {
        const json = JSON.parse(text);
        const collected = [];

        function scan(node, depth = 0, currentAncestorKeys = []) {
          if (!node || depth > 12 || typeof node !== 'object') return;
          const nodeKeys = [...currentAncestorKeys];
          const checkNodeVal = (val) => {
            if (!val || typeof val !== 'string') return;
            nodeKeys.push(val);
            const m1 = val.match(/(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i);
            if (m1) nodeKeys.push(m1[1]);
            const m2 = val.match(/urn:li:(?:activity|ugcPost|share):([0-9]{10,})/i);
            if (m2) nodeKeys.push(m2[1]);
            const m3 = val.match(/([CD]\d{2}[A-Za-z0-9_-]{8,})/);
            if (m3) nodeKeys.push(m3[1]);
          };
          if (node.urn) checkNodeVal(node.urn);
          if (node.entityUrn) checkNodeVal(node.entityUrn);
          if (node['$id']) checkNodeVal(node['$id']);

          if (node.videoPlayMetadata && typeof node.videoPlayMetadata === 'object') {
            collected.push({ parent: node, vpm: node.videoPlayMetadata, ancestorKeys: nodeKeys });
          }
          if (Array.isArray(node.progressiveStreams) || Array.isArray(node.adaptiveStreams)) {
            collected.push({ parent: node, vpm: node, ancestorKeys: nodeKeys });
          }
          if (Array.isArray(node)) {
            for (const item of node) scan(item, depth + 1, nodeKeys);
          } else {
            for (const k of Object.keys(node)) {
              if (k === 'videoPlayMetadata') continue;
              scan(node[k], depth + 1, nodeKeys);
            }
          }
        }

        scan(json);

        for (const item of collected) {
          const vpm = item.vpm;
          const parent = item.parent || {};

          const allKeys = new Set();
          if (item.ancestorKeys) {
            for (const ak of item.ancestorKeys) allKeys.add(ak);
          }
          const checkUrn = (val) => {
            if (!val || typeof val !== 'string') return;
            allKeys.add(val);
            const m1 = val.match(/(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i);
            if (m1) allKeys.add(m1[1]);
            const m2 = val.match(/urn:li:(?:activity|ugcPost|share):([0-9]{10,})/i);
            if (m2) allKeys.add(m2[1]);
            const m3 = val.match(/([CD]\d{2}[A-Za-z0-9_-]{8,})/);
            if (m3) allKeys.add(m3[1]);
          };

          checkUrn(vpm.entityUrn);
          checkUrn(vpm.mediaUrn);
          checkUrn(parent.entityUrn);
          checkUrn(parent.urn);
          checkUrn(parent['$id']);
          for (const [k, v] of Object.entries(parent)) {
            if (typeof v === 'string' && (v.includes('urn:li:') || v.length > 10)) {
              checkUrn(v);
            }
          }

          const entityUrn = vpm.entityUrn || vpm.mediaUrn || parent.entityUrn || parent.urn || '';
          const mediaKey = cleanEntityKey(vpm.entityUrn || vpm.mediaUrn || '');

          const progStreams = vpm.progressiveStreams || [];
          let bestProgUrl = null;
          if (progStreams.length > 0) {
            const sorted = progStreams.slice().sort((a, b) => {
              const resA = (a.width || 0) * (a.height || 0);
              const resB = (b.width || 0) * (b.height || 0);
              if (resA !== resB) return resB - resA;
              return (b.bitRate || 0) - (a.bitRate || 0);
            });
            for (const item of sorted) {
              if (!item) continue;
              const u = extractMediaUrlFromItem(item);
              if (u && typeof u === 'string' && isGenuineProgressiveMp4Url(u)) {
                bestProgUrl = u;
                break;
              }
            }
          }

          let dashUrl = null;
          let hlsUrl = null;
          const adaptiveList = Array.isArray(vpm.adaptiveStreams) ? vpm.adaptiveStreams : [];
          for (const s of adaptiveList) {
            if (!s) continue;
            const u = extractMediaUrlFromItem(s);
            if (!u) continue;
            const proto = String(s.protocol || '').toUpperCase();
            if (proto === 'DASH' || u.includes('/dash/') || u.includes('.mpd')) {
              if (!dashUrl) dashUrl = u;
            } else if (proto === 'HLS' || u.includes('.m3u8') || u.includes('/hls/')) {
              if (!hlsUrl) hlsUrl = u;
            }
          }

          const dur = vpm.duration ? (vpm.duration > 1000 ? vpm.duration / 1000 : vpm.duration) : 0;

          if (bestProgUrl || dashUrl || hlsUrl) {
            results.push({
              entityUrn,
              mediaKey,
              allKeys: Array.from(allKeys),
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

    cachedEmbeddedMetadata = results;
    cachedEmbeddedMetadataTime = now;
    return results;
  }

  function registerVideo(video) {
    if (videoRegistry.has(video)) return;

    const id = `vbs-${nextVideoId++}`;
    video.setAttribute('data-garrett-video-id', id);
    const entityInfo = extractVideoEntityInfoFromDom(video);
    const poster = video.getAttribute('poster') || '';

    const state = {
      id,
      video,
      entityKey: entityInfo.primaryKey,
      mediaKey: entityInfo.mediaKey,
      activityUrn: entityInfo.activityUrn,
      allKeys: entityInfo.allKeys,
      poster,
      progressiveUrl: null,
      manifestUrl: null,
      manifestXml: null,
      allSegments: [],
      isDownloading: false,
      overlayBtn: null,
      mainBtn: null
    };

    // Pre-check discovered network metadata and embedded JSON for immediate progressive/manifest URL attachment
    try {
      const allMeta = [...discoveredMetadataCache, ...extractAllEmbeddedVideoMetadata()];
      for (const m of allMeta) {
        if (matchesVideoMetadata(state, m)) {
          if (m.progressiveUrl) state.progressiveUrl = m.progressiveUrl;
          if (m.manifestUrl) state.manifestUrl = m.manifestUrl;
          if (m.mediaKey) state.mediaKey = m.mediaKey;
          if (m.duration && m.duration > 0 && (!state.duration || state.duration <= 5)) state.duration = m.duration;
          if (m.mediaKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
            state.entityKey = m.mediaKey;
          }
          if (m.progressiveUrl) break;
        }
      }
    } catch (e) {}

    videoRegistry.set(video, state);
    createOverlayUI(state);
    notifyBackground(state);

    // Immediate query to React Fiber
    const initSrc = video.currentSrc || video.src || '';
    window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
      detail: { videoId: id, blobUrl: initSrc }
    }));

    const onUserPlay = () => {
      const info = extractVideoEntityInfoFromDom(video);
      if (info.primaryKey && !state.entityKey) state.entityKey = info.primaryKey;
      if (info.mediaKey && !state.mediaKey) state.mediaKey = info.mediaKey;
      if (info.allKeys) {
        for (const k of info.allKeys) state.allKeys.add(k);
      }
      const dDur = extractVideoDurationFromDom(video);
      if (dDur > 5 && (!state.duration || state.duration <= 5)) {
        state.duration = dDur;
      }
      const src = video.currentSrc || video.src || '';
      window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
        detail: { videoId: state.id, blobUrl: src }
      }));
      notifyBackground(state);
    };

    video.addEventListener('play', onUserPlay);
    video.addEventListener('loadedmetadata', onUserPlay);
    video.addEventListener('timeupdate', () => {
      if (video.currentTime > 1 && !state.progressiveUrl && !state.manifestUrl) {
        onUserPlay();
      }
    });
  }

  function notifyBackground(state) {
    const v = state.video;
    const src = v ? (v.currentSrc || v.src || '') : '';
    const entityKey = state.entityKey || extractVideoEntityKeyFromDom(v);
    state.entityKey = entityKey;
    const realDur = resolveRealVideoDuration(state);

    safeSendMessage({
      action: 'registerVideo',
      video: {
        id: state.id,
        src: src,
        entityKey: entityKey,
        isBlob: src.startsWith('blob:'),
        poster: state.poster,
        duration: realDur,
        width: v ? (v.videoWidth || 0) : 0,
        height: v ? (v.videoHeight || 0) : 0
      }
    });

    if (src && src.startsWith('blob:')) {
      safeSendMessage({
        action: 'registerBlobStream',
        record: {
          blobUrl: src,
          videoId: state.id,
          entityKey: entityKey,
          duration: realDur,
          width: v ? (v.videoWidth || 0) : 0,
          height: v ? (v.videoHeight || 0) : 0,
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

    // Clean up any existing overlay buttons on this specific parent
    parent.querySelectorAll('.vbs-overlay-btn, .vbs-btn-group, .vbs-action-pill').forEach(el => el.remove());

    // Single sleek action button: [ Keep Video ] with open hand icon
    const btn = document.createElement('button');
    btn.className = 'vbs-overlay-btn';
    btn.setAttribute('data-video-id', state.id);
    btn.title = 'Keep this video directly to MP4 in background';
    btn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/>
        <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>
        <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/>
        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
      </svg>
      <span class="vbs-btn-text">Keep Video</span>
    `;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      keepVideoNow(state);
    });

    parent.appendChild(btn);
    state.overlayBtn = btn;
    state.mainBtn = btn;

    const isAlreadyKept = state.isKept ||
      (state.video && state.video.__garrett_kept) ||
      (state.id && keptVideosRegistry.has(state.id)) ||
      (state.entityKey && keptVideosRegistry.has(state.entityKey)) ||
      (state.mediaKey && keptVideosRegistry.has(state.mediaKey));
    if (isAlreadyKept) {
      updateButtonKeptState(state);
    }
  }

  function updateButtonKeptState(state) {
    if (!state || !state.mainBtn) return;
    const btn = state.mainBtn;
    btn.classList.add('vbs-btn-kept');
    btn.title = state.keptFilename
      ? `Already kept: ${state.keptFilename}. Click to keep again.`
      : 'Already kept. Click to keep again.';
    btn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span class="vbs-btn-text">Kept</span>
    `;
  }

  function markVideoAsKept(state, filename) {
    if (!state) return;
    state.isKept = true;
    state.keptFilename = filename;
    if (state.id) keptVideosRegistry.add(state.id);
    if (state.entityKey) keptVideosRegistry.add(state.entityKey);
    if (state.mediaKey) keptVideosRegistry.add(state.mediaKey);
    if (state.progressiveUrl) keptVideosRegistry.add(state.progressiveUrl);
    const src = state.video ? (state.video.currentSrc || state.video.src || '') : '';
    if (src) keptVideosRegistry.add(src);
    if (state.video) state.video.__garrett_kept = true;

    updateButtonKeptState(state);
  }

  async function resolveStreamForVideo(state, maxWaitMs = 2500) {
    const video = state.video;
    const currentSrc = video ? (video.currentSrc || video.src || '') : '';
    const domInfo = extractVideoEntityInfoFromDom(video);
    if (domInfo.mediaKey && !state.mediaKey) state.mediaKey = domInfo.mediaKey;
    if (domInfo.primaryKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
      state.entityKey = domInfo.primaryKey;
    }
    if (domInfo.allKeys && state.allKeys) {
      for (const k of domInfo.allKeys) state.allKeys.add(k);
    }
    const entityKey = state.mediaKey || state.entityKey;
    state.entityKey = entityKey;
    const duration = resolveRealVideoDuration(state);

    // Fast Path 0: Already cached progressive MP4 URL
    if (state.progressiveUrl) {
      return {
        progressiveUrl: state.progressiveUrl,
        isStream: false,
        format: 'DIRECT',
        streamKey: state.mediaKey || entityKey
      };
    }

    // Trigger immediate React Fiber query
    if (currentSrc.startsWith('blob:') || !state.progressiveUrl) {
      window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
        detail: { videoId: state.id, blobUrl: currentSrc }
      }));
    }

    // Fast Path 1: Check React Stream Cache
    const rMetaFast = (state.id && reactStreamCache.get(state.id)) || (currentSrc && reactStreamCache.get(currentSrc));
    if (rMetaFast) {
      if (rMetaFast.duration && rMetaFast.duration > 0 && (!state.duration || state.duration <= 5)) {
        state.duration = rMetaFast.duration;
      }
      if (rMetaFast.progressiveUrl) {
        state.progressiveUrl = rMetaFast.progressiveUrl;
        return {
          progressiveUrl: rMetaFast.progressiveUrl,
          isStream: false,
          format: 'DIRECT',
          streamKey: rMetaFast.entityUrn || entityKey
        };
      }
      if (rMetaFast.manifestUrl && !state.manifestUrl) {
        state.manifestUrl = rMetaFast.manifestUrl;
      }
    }

    // Fast Path 2: Check Discovered Network Metadata & Embedded DOM JSON
    try {
      const allMeta = [...discoveredMetadataCache, ...extractAllEmbeddedVideoMetadata()];
      for (const m of allMeta) {
        const keyMatch = matchesVideoMetadata(state, m);
        if (keyMatch) {
          if (m.mediaKey) state.mediaKey = m.mediaKey;
          if (m.mediaKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
            state.entityKey = m.mediaKey;
          }
          if (m.duration && m.duration > 0 && (!state.duration || state.duration <= 5)) {
            state.duration = m.duration;
          }
          if (m.progressiveUrl) {
            state.progressiveUrl = m.progressiveUrl;
            return {
              progressiveUrl: m.progressiveUrl,
              isStream: false,
              format: 'DIRECT',
              streamKey: m.mediaKey || state.entityKey
            };
          }
          if (m.manifestUrl && !state.manifestUrl) {
            state.manifestUrl = m.manifestUrl;
          }
        }
      }
    } catch (e) {}

    const videoInfo = {
      id: state.id,
      src: currentSrc,
      currentSrc: currentSrc,
      entityKey: state.mediaKey || entityKey,
      poster: state.poster || (video ? video.getAttribute('poster') : '') || '',
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
      const rMetaAsync = (state.id && reactStreamCache.get(state.id)) || (currentSrc && reactStreamCache.get(currentSrc));
      if (rMetaAsync) {
        if (rMetaAsync.progressiveUrl) {
          state.progressiveUrl = rMetaAsync.progressiveUrl;
          return {
            progressiveUrl: rMetaAsync.progressiveUrl,
            isStream: false,
            format: 'DIRECT',
            streamKey: rMetaAsync.entityUrn || state.entityKey
          };
        }
        if (rMetaAsync.manifestUrl && !state.manifestUrl) {
          state.manifestUrl = rMetaAsync.manifestUrl;
        }
      }

      // Check performance resource entries for manifests or progressive MP4s
      try {
        const resEntries = performance.getEntriesByType('resource');
        const isPlaying = video && (!video.paused || video.currentTime > 0);

        for (let i = resEntries.length - 1; i >= 0; i--) {
          const name = resEntries[i].name;
          if (isNonMediaUrl(name)) continue;

          let matchesKey = state.entityKey ? entityKeysMatch(state.entityKey, name) : false;
          if (!matchesKey && state.allKeys) {
            for (const k of state.allKeys) {
              if (entityKeysMatch(k, name)) { matchesKey = true; break; }
            }
          }
          if (!matchesKey && isPlaying && videoRegistry.size === 1 && (resEntries.length - 1 - i < 15)) {
            if (name.includes('/playlist/vid/') || name.includes('/dash/')) {
              matchesKey = true;
            }
          }

          if (matchesKey) {
            // Guard: ensure this URL is not already claimed by another video in videoRegistry!
            const isClaimedByOther = Array.from(videoRegistry.values()).some(other => other !== state && (other.progressiveUrl === name || other.manifestUrl === name));
            if (isClaimedByOther) continue;
            const streamKey = extractStreamKey(name);
            if (streamKey && !state.mediaKey) state.mediaKey = streamKey;
            if (streamKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
              state.entityKey = streamKey;
            }

            if (isGenuineProgressiveMp4Url(name)) {
              state.progressiveUrl = name;
              return {
                progressiveUrl: name,
                isStream: false,
                format: 'DIRECT',
                streamKey: state.entityKey
              };
            }
            if (!state.manifestUrl && (name.includes('.mpd') || name.includes('.m3u8') || (name.includes('/playlist/vid/') && name.includes('manifest'))) && !name.includes('.m4s') && !name.includes('.ts')) {
              if (queue) queue.registerManifest(name);
              state.manifestUrl = name;
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
                streamKey: pl.entityKey || state.entityKey
              };
            }
            if (pl.manifestUrl) {
              state.manifestUrl = pl.manifestUrl;
              if (pl.manifestXml && !state.manifestXml) state.manifestXml = pl.manifestXml;
              if (pl.playlistUrls && pl.playlistUrls.length > 0) state.allSegments = pl.playlistUrls;
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
              streamKey: localMatch.entityKey || state.entityKey
            };
          }
          if (localMatch.manifestUrl) {
            state.manifestUrl = localMatch.manifestUrl;
            if (localMatch.manifestXml) state.manifestXml = localMatch.manifestXml;
            const segs = localMatch.getAllSegmentUrls ? localMatch.getAllSegmentUrls() : (localMatch.allSegments || []);
            if (segs && segs.length > 0) state.allSegments = segs;
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
              streamKey: s.streamKey || state.entityKey
            };
          }
          if (s.manifestUrl) {
            state.manifestUrl = s.manifestUrl;
            if (s.manifestXml) state.manifestXml = s.manifestXml;
            const segs = (s.segments || []).map(seg => seg.url || seg);
            if (segs && segs.length > 0) state.allSegments = segs;
          }
        }
      } catch (e) {}

      // If we have progressive URL, return immediately
      if (state.progressiveUrl) {
        return {
          progressiveUrl: state.progressiveUrl,
          isStream: false,
          format: 'DIRECT',
          streamKey: state.entityKey
        };
      }

      // Allow adequate time for React Fiber inspection to return progressiveStreams.
      // If after 2000ms no progressive URL is found, proceed only if manifest or substantial segments are locked.
      const hasSubstantialSegments = state.allSegments && state.allSegments.length >= 6;
      if (Date.now() - startTime >= 2000 && (state.manifestUrl || hasSubstantialSegments)) {
        break;
      }

      await new Promise(r => setTimeout(r, 150));
    }

    // Return manifest if locked
    if (state.manifestUrl) {
      return {
        url: state.manifestUrl,
        manifestXml: state.manifestXml || '',
        isStream: true,
        format: state.manifestUrl.includes('.m3u8') ? 'HLS' : 'DASH',
        streamKey: state.entityKey,
        allSegments: state.allSegments || []
      };
    }

    // Return segment stream if available
    if (state.allSegments && state.allSegments.length > 0) {
      return {
        url: null,
        isStream: true,
        format: 'SEGMENT_STREAM',
        streamKey: state.entityKey,
        allSegments: state.allSegments
      };
    }

    return null;
  }

  async function downloadStreamInPage(state, streamUrl, manifestText = '') {
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

      const realDur = resolveRealVideoDuration(state);
      const result = await assembler.downloadStream(streamUrl, onProgress, {
        manifestText,
        duration: realDur,
        customFetchText,
        customFetchBuffer,
        initBuffer: state.initChunk || lastInitChunk
      });

      const filename = generateFilename(state.video, result.ext || 'mp4');
      const saved = downloadBlobDirectly(result.blob, filename);

      if (saved) {
        showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
        markVideoAsKept(state, filename);
      }
      safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
    } catch (err) {
      console.error('[Garrett] Stream download error:', err);
      throw err;
    } finally {
      state.isDownloading = false;
    }
  }

  function deduplicateChunks(chunks) {
    if (!chunks || chunks.length <= 1) return chunks || [];
    const seen = new Set();
    const result = [];
    for (const chunk of chunks) {
      if (!chunk || chunk.byteLength < 16) continue;
      const len = chunk.byteLength;
      const u8 = new Uint8Array(chunk instanceof ArrayBuffer ? chunk : chunk.buffer, chunk.byteOffset || 0, Math.min(32, len));
      let head = '';
      for (let i = 0; i < u8.length; i++) head += u8[i].toString(16).padStart(2, '0');
      const tailU8 = new Uint8Array(chunk instanceof ArrayBuffer ? chunk : chunk.buffer, (chunk.byteOffset || 0) + Math.max(0, len - 16), Math.min(16, len));
      let tail = '';
      for (let i = 0; i < tailU8.length; i++) tail += tailU8[i].toString(16).padStart(2, '0');
      const sig = `${len}_${head}_${tail}`;
      if (!seen.has(sig)) {
        seen.add(sig);
        result.push(chunk);
      }
    }
    return result;
  }

  async function downloadFromSegmentQueue(state, segmentUrls) {
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

      const realDur = resolveRealVideoDuration(state);

      // Priority 0: If progressive MP4 URL exists, use it!
      if (state.progressiveUrl && isGenuineProgressiveMp4Url(state.progressiveUrl)) {
        state.isDownloading = false;
        return await keepVideoNow(state);
      }

      // Check authentic MSE chunks coverage
      const expectedMinChunks = (realDur > 10) ? Math.max(3, Math.floor(realDur / 4.5)) : 3;
      let rawChunks = state.capturedChunks ? deduplicateChunks(state.capturedChunks) : [];

      let urlsToDownload = (segmentUrls && segmentUrls.length > 0) ? segmentUrls.slice() : [];

      // Priority Path: Authentic MSE captured chunks from the player's active SourceBuffer
      if (rawChunks.length >= 3 && (rawChunks.length >= expectedMinChunks || urlsToDownload.length <= 3)) {
        const initBuf = state.initChunk || lastInitChunk;
        if (initBuf && isInitBox(initBuf)) {
          console.log(`[Garrett] Assembling ${rawChunks.length} authentic MSE chunks with initialization header...`);
          const allBuffers = [initBuf, ...rawChunks];
          const blob = new Blob(allBuffers, { type: 'video/mp4' });
          if (blob.size >= 32768) {
            const filename = generateFilename(state.video, 'mp4');
            const saved = downloadBlobDirectly(blob, filename);
            if (saved) {
              showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
              markVideoAsKept(state, filename);
              safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
              return;
            }
          }
        }
      }

      // Autonomous Segment Pattern Synthesis (only for non-HMAC streams)
      if (assembler.synthesizeSegmentUrls && urlsToDownload.length > 0) {
        const sampleUrl = urlsToDownload[urlsToDownload.length - 1];
        const syn = assembler.synthesizeSegmentUrls(sampleUrl, realDur);
        if (syn && syn.urls && syn.urls.length > 0) {
          if (syn.urls.length > urlsToDownload.length || urlsToDownload.length <= 3) {
            console.log(`[Garrett] Autonomous crawler: Extrapolating ${urlsToDownload.length} buffered segments to full presentation sequence (${syn.urls.length} segments, ~${Math.round(realDur)}s)`);
            urlsToDownload = syn.urls;
          }
        }
      }

      // If after all checks we only have <= 3 segments and < 3 raw chunks, NEVER assemble a 4s snippet!
      if (urlsToDownload.length <= 3 && rawChunks.length < 3) {
        // One final check for React Fiber progressive stream
        const curSrc = state.video ? (state.video.currentSrc || state.video.src || '') : '';
        window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
          detail: { videoId: state.id, blobUrl: curSrc }
        }));
        await new Promise(r => setTimeout(r, 400));
        if (state.progressiveUrl && isGenuineProgressiveMp4Url(state.progressiveUrl)) {
          state.isDownloading = false;
          return await keepVideoNow(state);
        }
        if (state.manifestUrl) {
          state.isDownloading = false;
          return await downloadStreamInPage(state, state.manifestUrl, state.manifestXml);
        }

        showToast('Stream is buffering. Please play 1-2 seconds of the video so Garrett can lock onto the complete presentation, then click Keep Video.', 5500);
        if (textEl) textEl.textContent = 'Keep Video';
        state.isDownloading = false;
        return;
      }

      if (urlsToDownload.length === 0) {
        throw new Error('No media segments available to assemble.');
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

      const result = await assembler.assembleSegments(urlsToDownload, 'video/mp4', 'mp4', onProgress, customFetchBuffer, {
        allowTrailingLoss: true,
        initBuffer: state.initChunk || lastInitChunk
      });
      const filename = generateFilename(state.video, 'mp4');
      const saved = downloadBlobDirectly(result.blob, filename);

      if (saved) {
        showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
        markVideoAsKept(state, filename);
      }
      safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
    } catch (err) {
      console.error('[Garrett] Segment queue download error:', err);
      showToast(`Segment assembly error: ${err.message}`, 5000);
      safeSendMessage({ action: 'streamError', videoId: state.id, error: err.message });
      if (textEl) textEl.textContent = 'Keep Video';
    } finally {
      state.isDownloading = false;
    }
  }

  async function keepVideoNow(state) {
    if (state.isDownloading) {
      showToast('Garrett is already preserving this stream...');
      return;
    }
    if (state.isKept) {
      showToast(`This video was already kept (${state.keptFilename || 'earlier'}). Saving a fresh copy...`, 3500);
    }
    state.isDownloading = true;

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
          filename,
          saveAs: false
        }, async (resp) => {
          if (resp && resp.success) {
            showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
            markVideoAsKept(state, filename);
            safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
          } else {
            // Background download fallback via fetch in page
            try {
              const r = await fetch(progUrl);
              const blob = await r.blob();
              downloadBlobDirectly(blob, filename);
              showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
              markVideoAsKept(state, filename);
              safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
            } catch (err) {
              showToast(`Download error: ${err.message}`);
              safeSendMessage({ action: 'streamError', videoId: state.id, error: err.message });
              if (textEl && !state.isKept) textEl.textContent = 'Keep Video';
            }
          }
        });
        return;
      }

      // Path 2: Full Manifest Stream (DASH or HLS assembled)
      const manifestUrl = (stream && stream.url) || state.manifestUrl;
      if (manifestUrl) {
        try {
          const manifestXml = (stream && stream.manifestXml) || state.manifestXml || '';
          await downloadStreamInPage(state, manifestUrl, manifestXml);
          return;
        } catch (streamErr) {
          console.warn('[Garrett] Manifest download failed, engaging segment synthesis crawler:', streamErr.message);
        }
      }

      // Path 3: Direct standalone MP4/WebM URL on video tag
      const src = state.video ? (state.video.currentSrc || state.video.src || '') : '';
      if (src && !src.startsWith('blob:')) {
        const ext = src.split('.').pop().split(/[?#]/)[0] || 'mp4';
        const filename = generateFilename(state.video, ext);
        safeSendMessage({ action: 'downloadUrl', url: src, filename, saveAs: false });
        showToast(`Downloading ${filename}...`);
        markVideoAsKept(state, filename);
        safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
        return;
      }

      // Path 4: Autonomous Segment Queue & Pattern Synthesis
      const candidateSegs = (stream && stream.allSegments && stream.allSegments.length > 0)
        ? stream.allSegments
        : (state.allSegments && state.allSegments.length > 0 ? state.allSegments : null);

      if (candidateSegs && candidateSegs.length > 0) {
        await downloadFromSegmentQueue(state, candidateSegs);
        return;
      }

      // Path 5: Final active media stream lock from performance resource entries
      try {
        const resEntries = performance.getEntriesByType('resource');
        const foundSegments = [];
        for (let i = resEntries.length - 1; i >= 0; i--) {
          const name = resEntries[i].name;
          if (isNonMediaUrl(name)) continue;
          if (name.includes('/playlist/vid/') || name.includes('/dash/') || name.includes('.mpd') || name.includes('.m3u8')) {
            const isClaimedByOther = Array.from(videoRegistry.values()).some(other => other !== state && (other.progressiveUrl === name || other.manifestUrl === name));
            if (isClaimedByOther) continue;

            let matchesKey = state.entityKey ? entityKeysMatch(state.entityKey, name) : false;
            if (!matchesKey && state.allKeys) {
              for (const k of state.allKeys) {
                if (entityKeysMatch(k, name)) { matchesKey = true; break; }
              }
            }
            const isAllowed = matchesKey || videoRegistry.size === 1;
            if (!isAllowed) continue;

            // 5a. Check if manifest is present in performance entries
            if (!state.manifestUrl && (name.includes('.mpd') || name.includes('/dash/') || name.includes('.m3u8')) && !name.includes('.m4s') && !name.includes('.ts')) {
              state.manifestUrl = name;
              if (queue) queue.registerManifest(name);
              await downloadStreamInPage(state, name);
              return;
            }

            // 5b. Check if progressive MP4 is present
            if (isGenuineProgressiveMp4Url(name)) {
              const filename = generateFilename(state.video, 'mp4');
              safeSendMessage({ action: 'downloadUrl', url: name, filename, saveAs: false });
              showToast(`Downloading full video: ${filename}...`);
              markVideoAsKept(state, filename);
              safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
              return;
            }

            // 5c. Collect media segments
            if (name.includes('.m4s') || name.includes('.ts') || name.includes('/segment/') || /\/[0-9]+\/[0-9]+(?:\?|$)/.test(name)) {
              foundSegments.push(name);
            }
          }
        }
        if (foundSegments.length > 0) {
          await downloadFromSegmentQueue(state, foundSegments);
          return;
        }
      } catch (e) {}

      // STRICT PROTECTION: Inform user if stream buffering is needed
      showToast('Stream is buffering. Please play 1-2 seconds of the video so Garrett can lock onto the stream, then click Keep Video.', 5500);
      safeSendMessage({ action: 'streamError', videoId: state.id, error: 'Stream buffering: Play 1-2s of video first' });
      if (textEl) textEl.textContent = 'Keep Video';
    } catch (err) {
      console.error('[Garrett] keepVideoNow error:', err);
      showToast(`Error keeping video: ${err.message}`, 5000);
      safeSendMessage({ action: 'streamError', videoId: state.id, error: err.message });
      if (textEl) textEl.textContent = 'Keep Video';
    } finally {
      state.isDownloading = false;
    }
  }

  function scanForVideos() {
    const videos = findAllVideos(document);
    videos.forEach(v => registerVideo(v));
  }

  // MutationObserver with deep shadow DOM checks and debounced scanning
  let scanDebounceTimer = null;
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        shouldScan = true;
        break;
      }
    }
    if (shouldScan) {
      if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
      scanDebounceTimer = setTimeout(scanForVideos, 250);
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
        const realDur = resolveRealVideoDuration(state);
        list.push({
          id: state.id,
          src: currentSrc,
          isBlob: currentSrc.startsWith('blob:'),
          entityKey: state.entityKey,
          poster: state.poster,
          duration: realDur,
          width: v ? (v.videoWidth || 0) : 0,
          height: v ? (v.videoHeight || 0) : 0,
          muted: v ? v.muted : false,
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
      let state = Array.from(videoRegistry.values()).find(s => s.id === request.videoId) ||
                  Array.from(videoRegistry.values())[0];
      if (!state && request.streamUrl) {
        state = {
          id: request.videoId || `vbs-ext-${Date.now()}`,
          video: null,
          entityKey: '',
          poster: '',
          progressiveUrl: null,
          manifestUrl: null,
          isDownloading: false,
          overlayBtn: null,
          mainBtn: null
        };
      }
      if (state) {
        if (request.progressiveUrl) {
          state.progressiveUrl = request.progressiveUrl;
        }
        if (request.streamUrl) {
          if (isGenuineProgressiveMp4Url(request.streamUrl)) {
            state.progressiveUrl = request.streamUrl;
          } else if (!state.progressiveUrl && (request.streamUrl.includes('.mpd') || request.streamUrl.includes('/dash/') || request.streamUrl.includes('.m3u8'))) {
            state.manifestUrl = request.streamUrl;
          }
        }
        if (request.manifestXml) {
          state.manifestXml = request.manifestXml;
        }
        sendResponse({ success: true, started: true });
        keepVideoNow(state).catch((err) => {
          console.error('[Garrett] keepVideoNow failed:', err);
          safeSendMessage({ action: 'streamError', videoId: state.id, error: err.message });
        });
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
        downloadStreamInPage(state, request.url).catch(e => {
          console.error('[Garrett] startKeepStream error:', e);
          showToast(`Stream download error: ${e.message}`, 5000);
          safeSendMessage({ action: 'streamError', videoId: state.id, error: e.message });
        });
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

    if (request.action === 'progressiveDiscovered' && request.url) {
      const streamKey = extractStreamKey(request.url);
      for (const state of videoRegistry.values()) {
        const hasKeys = !!(state.entityKey || (state.allKeys && state.allKeys.size > 0));
        const matches = (state.entityKey && entityKeysMatch(state.entityKey, request.url)) ||
                        (state.allKeys && Array.from(state.allKeys).some(k => entityKeysMatch(k, request.url))) ||
                        (!hasKeys && videoRegistry.size === 1);
        if (matches) {
          state.progressiveUrl = request.url;
          if (streamKey && !state.mediaKey) state.mediaKey = streamKey;
        }
      }
      sendResponse({ received: true });
      return true;
    }
  });
}

})();
