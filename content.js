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
        const matchesState = (state.entityKey && entityKeysMatch(state.entityKey, e.detail.url)) ||
                             (state.allKeys && Array.from(state.allKeys).some(k => entityKeysMatch(k, e.detail.url))) ||
                             (v && (!v.paused || v.currentTime > 0)) ||
                             videoRegistry.size === 1;
        if (matchesState) {
          state.manifestUrl = e.detail.url;
          state.manifestXml = e.detail.text || '';
          if (streamKey && !state.mediaKey) state.mediaKey = streamKey;
          if (streamKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
            state.entityKey = streamKey;
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
        const matchesState = (state.entityKey && entityKeysMatch(state.entityKey, e.detail.url)) ||
                             (state.allKeys && Array.from(state.allKeys).some(k => entityKeysMatch(k, e.detail.url))) ||
                             (v && (!v.paused || v.currentTime > 0)) ||
                             videoRegistry.size === 1;
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
        const matchesVideo = v && (
          v.currentSrc === e.detail.blobUrl ||
          v.src === e.detail.blobUrl ||
          (!v.paused || v.currentTime > 0) ||
          videoRegistry.size === 1
        );
        if (matchesVideo) {
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
      const streamKey = extractStreamKey(progUrl);
      for (const state of videoRegistry.values()) {
        const v = state.video;
        const matchesState = (state.entityKey && entityKeysMatch(state.entityKey, progUrl)) ||
                             (state.allKeys && Array.from(state.allKeys).some(k => entityKeysMatch(k, progUrl))) ||
                             (v && (!v.paused || v.currentTime > 0)) ||
                             videoRegistry.size === 1;
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
      const pm = poster.match(/(?:dms\/image\/(?:v2\/)?|videocover-(?:high|low)\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i);
      if (pm) {
        info.mediaKey = pm[1];
        info.allKeys.add(pm[1]);
      }
    }

    // 2. Find closest post container (never leak outside)
    const container = video.closest('.feed-shared-update-v2, [data-urn], [data-id], article, .feed-shared-linkedin-video, div[data-id], .occludable-update') || video.parentElement;
    if (!container) {
      info.primaryKey = info.mediaKey;
      return info;
    }

    // 3. Search thumbnail / preview divs inside this specific container
    const thumbElements = container.querySelectorAll('[style*="videocover"], [style*="dms/image"], [style*="background"], img');
    for (const el of thumbElements) {
      const src = el.src || el.getAttribute('src') || el.getAttribute('style') || '';
      const m = src.match(/(?:dms\/image\/(?:v2\/)?|videocover-(?:high|low)\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i);
      if (m) {
        if (!info.mediaKey) info.mediaKey = m[1];
        info.allKeys.add(m[1]);
      }
    }

    // 4. Search data attributes in this container and its ancestors
    const urnElements = [container, ...container.querySelectorAll('[data-urn], [data-entity-urn], [data-chameleon-urn], [data-id]')];
    
    // First pass: media IDs (digitalmediaAsset, fs_video, dms, video)
    for (const el of urnElements) {
      for (const attrName of ['data-entity-urn', 'data-urn', 'data-chameleon-urn', 'data-id']) {
        const val = el.getAttribute ? el.getAttribute(attrName) : '';
        if (val) {
          const vm = val.match(/(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i);
          if (vm) {
            if (!info.mediaKey) info.mediaKey = vm[1];
            info.allKeys.add(vm[1]);
          }
        }
      }
    }

    // Second pass: activity/post URNs
    for (const el of urnElements) {
      for (const attrName of ['data-urn', 'data-entity-urn', 'data-chameleon-urn', 'data-id']) {
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
    const hm = html.match(/(?:dms\/image\/(?:v2\/)?|videocover-(?:high|low)\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i);
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
   * Scrapes visible player timer text from DOM to determine ground-truth duration,
   * bypassing MSE buffered window limitations (e.g. 4.0s).
   */
  function extractVideoDurationFromDom(video) {
    if (!video) return 0;
    try {
      const container = video.closest('.feed-shared-update-v2, [data-urn], [data-id], article, .feed-shared-linkedin-video, div[data-id], .occludable-update') || video.parentElement;
      if (!container) return 0;
      const candidates = container.querySelectorAll('time, [class*="duration"], [class*="time"], [aria-label*="duration"], [aria-label*="time"], [class*="vjs-"]');
      let maxSec = 0;
      for (const el of candidates) {
        let text = (el.textContent || '').trim();
        if (text.length > 25) continue;
        if (text.includes('/')) {
          const parts = text.split('/');
          text = parts[parts.length - 1].trim();
        }
        const matches = [...text.matchAll(/\b(?:(\d+):)?(\d+):(\d{2})\b/g)];
        for (const m of matches) {
          const hours = m[1] ? parseInt(m[1], 10) : 0;
          const mins = parseInt(m[2], 10);
          const secs = parseInt(m[3], 10);
          const total = hours * 3600 + mins * 60 + secs;
          if (total > maxSec) maxSec = total;
        }
      }
      if (maxSec > 3) return maxSec;
    } catch (e) {}
    return 0;
  }

  /**
   * Resolves true presentation duration across DOM UI, embedded metadata, and video tag.
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
    if (state && state.video && typeof state.video.duration === 'number' && isFinite(state.video.duration) && state.video.duration > 5) {
      return state.video.duration;
    }
    return (state ? state.duration : 0) || domDur || (state && state.video && isFinite(state.video.duration) ? state.video.duration : 0) || 0;
  }

  function matchesVideoMetadata(videoState, meta) {
    if (!meta) return false;
    if (videoRegistry.size <= 1) return true;

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

    for (const tk of targetKeys) {
      for (const mk of metaKeys) {
        if (entityKeysMatch(tk, mk)) return true;
      }
    }

    const realDur = resolveRealVideoDuration(videoState);
    if (realDur > 3 && meta.duration > 3 && Math.abs(realDur - meta.duration) <= 2.5) {
      return true;
    }

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
          const parent = item.parent || {};

          const allKeys = new Set();
          const checkUrn = (val) => {
            if (!val || typeof val !== 'string') return;
            allKeys.add(val);
            const m1 = val.match(/(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i);
            if (m1) allKeys.add(m1[1]);
            const m2 = val.match(/urn:li:(?:activity|ugcPost|share):([0-9]{10,})/i);
            if (m2) allKeys.add(m2[1]);
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
            bestProgUrl = sorted[0]?.streamingLocations?.[0]?.url ||
                          (typeof sorted[0]?.streamingLocations?.[0] === 'string' ? sorted[0].streamingLocations[0] : null) ||
                          sorted[0]?.url || null;
          }
          const dashUrl = vpm.adaptiveStreams?.find(s => s.protocol === 'DASH' || s.url?.includes('dash') || s.url?.includes('.mpd'))?.url || null;
          const hlsUrl = vpm.adaptiveStreams?.find(s => s.protocol === 'HLS' || s.url?.includes('m3u8'))?.url || null;
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

    // Pre-check embedded JSON for immediate progressive/manifest URL attachment
    try {
      const allMeta = extractAllEmbeddedVideoMetadata();
      for (const m of allMeta) {
        if (matchesVideoMetadata(state, m)) {
          if (m.progressiveUrl) state.progressiveUrl = m.progressiveUrl;
          if (m.manifestUrl) state.manifestUrl = m.manifestUrl;
          if (m.mediaKey) state.mediaKey = m.mediaKey;
          if (m.duration && m.duration > 0) state.duration = m.duration;
          if (m.mediaKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
            state.entityKey = m.mediaKey;
          }
          break;
        }
      }
    } catch (e) {}

    videoRegistry.set(video, state);
    createOverlayUI(state);
    notifyBackground(state);

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
      if (src.startsWith('blob:')) {
        window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
          detail: { videoId: state.id, blobUrl: src }
        }));
      }
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

    // Clean up any existing overlay buttons across ancestors to guarantee zero duplicates
    let ancestor = parent;
    for (let depth = 0; depth < 3 && ancestor; depth++) {
      ancestor.querySelectorAll('.vbs-overlay-btn, #vbs-main-btn, .vbs-btn-group, .vbs-action-pill').forEach(el => el.remove());
      ancestor = ancestor.parentElement;
    }

    // Single sleek action button: [ Keep Video ]
    const btn = document.createElement('button');
    btn.className = 'vbs-overlay-btn';
    btn.id = 'vbs-main-btn';
    btn.title = 'Keep this video directly to MP4 in background';
    btn.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
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
    if (reactStreamCache.has(currentSrc)) {
      const rMeta = reactStreamCache.get(currentSrc);
      if (rMeta.duration && rMeta.duration > 0 && (!state.duration || state.duration <= 5)) {
        state.duration = rMeta.duration;
      }
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
      }
    }

    // Fast Path 2: Check Embedded DOM JSON (<code id*="bpr-guid">)
    try {
      const allMeta = extractAllEmbeddedVideoMetadata();
      for (const m of allMeta) {
        const keyMatch = matchesVideoMetadata(state, m);
        const singleMatch = allMeta.length === 1 || videoRegistry.size <= 1;
        if (keyMatch || singleMatch) {
          if (m.mediaKey) state.mediaKey = m.mediaKey;
          if (m.mediaKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
            state.entityKey = m.mediaKey;
          }
          if (m.duration && m.duration > 0) {
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
      if (reactStreamCache.has(currentSrc)) {
        const rMeta = reactStreamCache.get(currentSrc);
        if (rMeta.progressiveUrl) {
          state.progressiveUrl = rMeta.progressiveUrl;
          return {
            progressiveUrl: rMeta.progressiveUrl,
            isStream: false,
            format: 'DIRECT',
            streamKey: rMeta.entityUrn || state.entityKey
          };
        }
        if (rMeta.manifestUrl && !state.manifestUrl) {
          state.manifestUrl = rMeta.manifestUrl;
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
          if (!matchesKey && isPlaying && (resEntries.length - 1 - i < 15)) {
            if (name.includes('/playlist/vid/') || name.includes('/dash/') || name.includes('/mp4-')) {
              matchesKey = true;
            }
          }

          if (matchesKey) {
            const streamKey = extractStreamKey(name);
            if (streamKey && !state.mediaKey) state.mediaKey = streamKey;
            if (streamKey && (!state.entityKey || /^\d+$/.test(state.entityKey))) {
              state.entityKey = streamKey;
            }

            if (name.includes('/mp4-') || (name.includes('/playlist/vid/') && (name.endsWith('.mp4') || name.includes('mp4_')))) {
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
      // If after 1600ms no progressive URL is found but manifest/segments are locked, proceed.
      if (Date.now() - startTime >= 1600 && (state.manifestUrl || (state.allSegments && state.allSegments.length > 0))) {
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
        customFetchBuffer
      });

      const filename = generateFilename(state.video, result.ext || 'mp4');
      const saved = downloadBlobDirectly(result.blob, filename);

      if (saved) {
        showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
      }
      safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });

      if (textEl) {
        textEl.textContent = 'Kept!';
        setTimeout(() => {
          if (textEl) textEl.textContent = 'Keep Video';
        }, 4000);
      }
    } catch (err) {
      console.error('[Garrett] Stream download error:', err);
      throw err;
    } finally {
      state.isDownloading = false;
    }
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
      let urlsToDownload = (segmentUrls && segmentUrls.length > 0) ? segmentUrls.slice() : [];

      // Autonomous Segment Pattern Synthesis:
      // If segmentUrls doesn't yet cover the full duration, synthesize the complete sequence!
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

      const result = await assembler.assembleSegments(urlsToDownload, 'video/mp4', 'mp4', onProgress, customFetchBuffer, { allowTrailingLoss: true });
      const filename = generateFilename(state.video, 'mp4');
      const saved = downloadBlobDirectly(result.blob, filename);

      if (saved) {
        showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
      }
      safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });

      if (textEl) {
        textEl.textContent = 'Kept!';
        setTimeout(() => {
          if (textEl) textEl.textContent = 'Keep Video';
        }, 4000);
      }
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
            safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
            if (textEl) {
              textEl.textContent = 'Kept!';
            }
          } else {
            // Background download fallback via fetch in page
            try {
              const r = await fetch(progUrl);
              const blob = await r.blob();
              downloadBlobDirectly(blob, filename);
              showToast(`"What was taken is now safely kept." — Garrett (${filename})`, 6000);
              safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
              if (textEl) {
                textEl.textContent = 'Kept!';
              }
            } catch (err) {
              showToast(`Download error: ${err.message}`);
              safeSendMessage({ action: 'streamError', videoId: state.id, error: err.message });
              if (textEl) textEl.textContent = 'Keep Video';
            }
          }
          setTimeout(() => {
            if (textEl) textEl.textContent = 'Keep Video';
          }, 4000);
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
        safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
        if (textEl) {
          textEl.textContent = 'Kept!';
        }
        setTimeout(() => {
          if (textEl) textEl.textContent = 'Keep Video';
        }, 3000);
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
          if (name.includes('/playlist/vid/')) {
            if (name.includes('/mp4-') || name.endsWith('.mp4')) {
              const filename = generateFilename(state.video, 'mp4');
              safeSendMessage({ action: 'downloadUrl', url: name, filename, saveAs: false });
              showToast(`Downloading full video: ${filename}...`);
              safeSendMessage({ action: 'streamCompleted', videoId: state.id, filename });
              if (textEl) {
                textEl.textContent = 'Kept!';
              }
              setTimeout(() => {
                if (textEl) textEl.textContent = 'Keep Video';
              }, 4000);
              return;
            }
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
          if (request.streamUrl.endsWith('.mp4') || request.streamUrl.includes('/mp4-') || request.streamUrl.includes('mp4_')) {
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
  });
}

})();
