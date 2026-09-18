// Garrett - Stream Keeper: Main World Interceptor & Telemetry Hook
(function () {
  'use strict';
  if (window.__GARRETT_MAIN_HOOK_INSTALLED__) return;
  window.__GARRETT_MAIN_HOOK_INSTALLED__ = true;

  function isNonMediaUrl(url) {
    if (!url || typeof url !== 'string') return true;
    const clean = url.split('?')[0].toLowerCase();
    return (
      clean.includes('/dms/image/') ||
      clean.includes('company-logo') ||
      clean.includes('profile-displayphoto') ||
      clean.includes('feedshare-shrink') ||
      clean.includes('videocover') ||
      clean.includes('/li/track') ||
      /\.(jpg|jpeg|png|webp|gif|svg|ico|css|js|woff|woff2|map)$/i.test(clean)
    );
  }

  function isManifestUrl(url) {
    if (isNonMediaUrl(url)) return false;
    const clean = url.split('?')[0].toLowerCase();
    // Media fragments and init boxes are NEVER manifests
    if (clean.endsWith('.m4s') || clean.endsWith('.ts') || clean.endsWith('.init') || clean.includes('init.mp4') || /\/[0-9]+\/[0-9]+$/.test(clean)) {
      return false;
    }
    return (
      clean.endsWith('.mpd') ||
      clean.includes('.mpd') ||
      clean.endsWith('.m3u8') ||
      clean.includes('.m3u8') ||
      clean.endsWith('/dash') ||
      clean.includes('playlist.mpd') ||
      clean.includes('manifest')
    );
  }

  function isGenuineProgressiveMp4Url(url) {
    if (!url || typeof url !== 'string') return false;
    if (isNonMediaUrl(url)) return false;
    const clean = url.split('?')[0].toLowerCase();
    // Media segments, init chunks, and manifests are NEVER progressive MP4 files
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

  function isProgressiveMp4Url(url) {
    return isGenuineProgressiveMp4Url(url);
  }

  function isSegmentUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (isNonMediaUrl(url)) return false;
    if (isGenuineProgressiveMp4Url(url)) return false;
    const clean = url.split('?')[0].toLowerCase();
    return (
      clean.endsWith('.m4s') ||
      clean.endsWith('.ts') ||
      clean.endsWith('.init') ||
      clean.endsWith('/init') ||
      clean.includes('init.mp4') ||
      clean.includes('iso.segment') ||
      clean.includes('/segment/') ||
      clean.includes('/chunk/') ||
      clean.includes('output_hls') ||
      /\/[0-9]+\/[0-9]+$/.test(clean) ||
      (url.includes('/playlist/vid/') && /\/[0-9]+\/[0-9]+(?:\?|$)/.test(url))
    );
  }

  function getBestProgressiveUrl(progressiveStreams) {
    if (!Array.isArray(progressiveStreams) || progressiveStreams.length === 0) return null;
    const sorted = progressiveStreams.slice().sort((a, b) => {
      const resA = (a.width || 0) * (a.height || 0);
      const resB = (b.width || 0) * (b.height || 0);
      if (resA !== resB) return resB - resA;
      return (b.bitRate || 0) - (a.bitRate || 0);
    });
    for (const item of sorted) {
      if (!item) continue;
      if (Array.isArray(item.streamingLocations)) {
        for (const loc of item.streamingLocations) {
          const u = (loc && typeof loc === 'object') ? loc.url : (typeof loc === 'string' ? loc : null);
          if (u && typeof u === 'string' && isGenuineProgressiveMp4Url(u)) {
            return { url: u, width: item.width, height: item.height, bitRate: item.bitRate };
          }
        }
      }
      const singleLoc = item.streamingLocation || item.location;
      if (singleLoc) {
        const u = (typeof singleLoc === 'object') ? singleLoc.url : (typeof singleLoc === 'string' ? singleLoc : null);
        if (u && typeof u === 'string' && isGenuineProgressiveMp4Url(u)) {
          return { url: u, width: item.width, height: item.height, bitRate: item.bitRate };
        }
      }
      if (item.url && typeof item.url === 'string' && isGenuineProgressiveMp4Url(item.url)) {
        return { url: item.url, width: item.width, height: item.height, bitRate: item.bitRate };
      }
    }
    return null;
  }

  function parseVideoMetadata(metaObj) {
    if (!metaObj || typeof metaObj !== 'object') return null;
    const vpm = metaObj.videoPlayMetadata || metaObj.videoPlayMetadataV2 || metaObj;
    const bestProg = getBestProgressiveUrl(vpm.progressiveStreams || metaObj.progressiveStreams);
    const adaptive = vpm.adaptiveStreams || metaObj.adaptiveStreams;
    const dashUrl = adaptive?.find(s => s.protocol === 'DASH' || s.url?.includes('dash') || s.url?.includes('.mpd'))?.url;
    const hlsUrl = adaptive?.find(s => s.protocol === 'HLS' || s.url?.includes('m3u8'))?.url;
    const manifestUrl = dashUrl || hlsUrl || (typeof vpm.manifestUrl === 'string' ? vpm.manifestUrl : null);
    const progUrl = bestProg ? bestProg.url : (typeof vpm.progressiveUrl === 'string' && isGenuineProgressiveMp4Url(vpm.progressiveUrl) ? vpm.progressiveUrl : null);
    const rawDur = vpm.duration || vpm.durationMs || vpm.durationInSeconds || metaObj.duration || metaObj.durationMs || 0;
    const dur = rawDur ? (rawDur > 1000 ? rawDur / 1000 : rawDur) : null;
    const entityUrn = vpm.entityUrn || vpm.mediaUrn || metaObj.entityUrn || metaObj.mediaUrn || metaObj.urn || null;

    if (progUrl || manifestUrl || dur) {
      const allKeys = new Set();
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
      checkUrn(metaObj.entityUrn);
      checkUrn(metaObj.mediaUrn);
      checkUrn(metaObj.urn);
      checkUrn(metaObj['$id']);

      const mediaKey = (vpm.mediaUrn || vpm.entityUrn || metaObj.mediaUrn || metaObj.entityUrn || '')
        .replace(/^urn:li:[^:]+:/i, '').trim();

      return {
        progressiveUrl: progUrl,
        manifestUrl: manifestUrl,
        dashUrl: dashUrl || null,
        hlsUrl: hlsUrl || null,
        entityUrn: entityUrn,
        mediaKey: mediaKey || null,
        allKeys: Array.from(allKeys),
        duration: dur
      };
    }
    return null;
  }

  function scanJsonForVideoMetadata(json) {
    if (!json || typeof json !== 'object') return [];
    const results = [];
    const collected = [];

    function scan(node, depth = 0) {
      if (!node || depth > 8 || typeof node !== 'object') return;
      if (node.videoPlayMetadata && typeof node.videoPlayMetadata === 'object') {
        collected.push({ parent: node, vpm: node.videoPlayMetadata });
      }
      if (Array.isArray(node.progressiveStreams) || Array.isArray(node.adaptiveStreams)) {
        collected.push({ parent: node, vpm: node });
      }
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length && i < 80; i++) scan(node[i], depth + 1);
      } else {
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length && i < 50; i++) {
          const k = keys[i];
          if (k === 'videoPlayMetadata') continue;
          scan(node[k], depth + 1);
        }
      }
    }

    scan(json);

    for (const item of collected) {
      const vpm = item.vpm;
      const parent = item.parent || {};
      const parsed = parseVideoMetadata(vpm);
      if (parsed) {
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

        results.push({
          ...parsed,
          allKeys: Array.from(allKeys),
          entityUrn: parsed.entityUrn || vpm.entityUrn || parent.entityUrn || parent.urn || null
        });
      }
    }

    return results;
  }

  // 1. Hook window.fetch
  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const resource = args[0];
      let url = '';
      if (typeof resource === 'string') {
        url = resource;
      } else if (resource && resource.url) {
        url = resource.url;
      }

      if (url) {
        if (isProgressiveMp4Url(url)) {
          window.dispatchEvent(new CustomEvent('__GARRETT_PROGRESSIVE_DETECTED__', {
            detail: { url, timestamp: Date.now() }
          }));
        } else if (isSegmentUrl(url)) {
          window.dispatchEvent(new CustomEvent('__GARRETT_SEGMENT_DETECTED__', {
            detail: { url, timestamp: Date.now() }
          }));
        }
      }

      const response = await originalFetch.apply(this, args);

      if (url && response && response.ok) {
        const contentType = (response.headers && response.headers.get('content-type')) || '';
        const isManifest = isManifestUrl(url) ||
          contentType.includes('dash+xml') ||
          contentType.includes('application/vnd.apple.mpegurl') ||
          contentType.includes('application/x-mpegurl');

        if (isManifest) {
          try {
            const cloned = response.clone();
            cloned.text().then((text) => {
              if (text && (text.includes('<MPD') || text.includes('#EXTM3U'))) {
                window.dispatchEvent(new CustomEvent('__GARRETT_MANIFEST_CONTENT__', {
                  detail: { url, text, timestamp: Date.now() }
                }));
              }
            }).catch(() => {});
          } catch (e) {}
        } else if (
          contentType.includes('application/json') ||
          contentType.includes('application/graphql') ||
          url.includes('/voyager/') ||
          url.includes('/graphql') ||
          url.includes('/feed/')
        ) {
          try {
            const cloned = response.clone();
            cloned.text().then((text) => {
              if (text && (text.includes('videoPlayMetadata') || text.includes('progressiveStreams') || text.includes('adaptiveStreams'))) {
                try {
                  const json = JSON.parse(text);
                  const metas = scanJsonForVideoMetadata(json);
                  for (const m of metas) {
                    window.dispatchEvent(new CustomEvent('__GARRETT_METADATA_DISCOVERED__', {
                      detail: { ...m, timestamp: Date.now() }
                    }));
                  }
                } catch (e) {}
              }
            }).catch(() => {});
          } catch (e) {}
        }
      }

      return response;
    };
  }

  // 2. Hook XMLHttpRequest
  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__garrett_req_url = url ? url.toString() : '';
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      const url = this.__garrett_req_url;
      if (url) {
        if (isProgressiveMp4Url(url)) {
          window.dispatchEvent(new CustomEvent('__GARRETT_PROGRESSIVE_DETECTED__', {
            detail: { url, timestamp: Date.now() }
          }));
        } else if (isSegmentUrl(url)) {
          window.dispatchEvent(new CustomEvent('__GARRETT_SEGMENT_DETECTED__', {
            detail: { url, timestamp: Date.now() }
          }));
        }

        const isManifest = isManifestUrl(url);
        if (isManifest || url.includes('/voyager/') || url.includes('/graphql') || url.includes('/feed/')) {
          this.addEventListener('load', () => {
            try {
              if (this.status >= 200 && this.status < 300 && this.responseText) {
                const text = this.responseText;
                if (text && (text.includes('<MPD') || text.includes('#EXTM3U'))) {
                  window.dispatchEvent(new CustomEvent('__GARRETT_MANIFEST_CONTENT__', {
                    detail: { url, text, timestamp: Date.now() }
                  }));
                } else if (text && (text.includes('videoPlayMetadata') || text.includes('progressiveStreams') || text.includes('adaptiveStreams'))) {
                  try {
                    const json = JSON.parse(text);
                    const metas = scanJsonForVideoMetadata(json);
                    for (const m of metas) {
                      window.dispatchEvent(new CustomEvent('__GARRETT_METADATA_DISCOVERED__', {
                        detail: { ...m, timestamp: Date.now() }
                      }));
                    }
                  } catch (e) {}
                }
              }
            } catch (e) {}
          });
        }
      }
      return origSend.apply(this, arguments);
    };
  }

  // 3. Hook URL.createObjectURL for MediaSource tracking
  if (typeof URL !== 'undefined' && URL.createObjectURL) {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const blobUrl = origCreateObjectURL.apply(this, arguments);
      if (obj && typeof MediaSource !== 'undefined' && obj instanceof MediaSource) {
        const msId = 'ms_' + Math.random().toString(36).slice(2, 9);
        obj.__garrett_ms_id = msId;
        window.dispatchEvent(new CustomEvent('__GARRETT_BLOB_CREATED__', {
          detail: { blobUrl, mediaSourceId: msId, timestamp: Date.now() }
        }));
      }
      return blobUrl;
    };
  }

  // 3b. Hook MediaSource.prototype.addSourceBuffer to associate SourceBuffer with mediaSourceId
  if (typeof MediaSource !== 'undefined' && MediaSource.prototype && MediaSource.prototype.addSourceBuffer) {
    const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function () {
      const sb = origAddSourceBuffer.apply(this, arguments);
      try {
        if (sb && this.__garrett_ms_id) {
          sb.__garrett_ms_id = this.__garrett_ms_id;
        }
      } catch (e) {}
      return sb;
    };
  }

  // 4. Hook SourceBuffer.prototype.appendBuffer for raw MSE chunk capture
  if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype) {
    const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (buffer) {
      try {
        let chunk;
        if (buffer instanceof ArrayBuffer) {
          chunk = buffer.slice(0);
        } else if (ArrayBuffer.isView(buffer)) {
          chunk = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        }

        if (chunk && chunk.byteLength > 0) {
          window.dispatchEvent(new CustomEvent('__GARRETT_SOURCE_CHUNK__', {
            detail: {
              chunk,
              mediaSourceId: this.__garrett_ms_id || null,
              byteLength: chunk.byteLength,
              timestamp: Date.now()
            }
          }));
        }
      } catch (err) {}
      return originalAppendBuffer.apply(this, arguments);
    };
  }

  function inspectObjectForVideo(obj, depth = 0, visited = new WeakSet()) {
    if (!obj || depth > 12 || typeof obj !== 'object') return null;
    if (obj instanceof (typeof Node !== 'undefined' ? Node : Object) && obj.nodeType) return null;
    if (obj === window || obj === document) return null;
    if (visited.has(obj)) return null;
    visited.add(obj);

    const parsed = parseVideoMetadata(obj);
    if (parsed && (parsed.progressiveUrl || parsed.manifestUrl)) return parsed;

    // Fast-path prioritized keys used by LinkedIn React video components
    const priorityKeys = [
      'videoPlayMetadata', 'videoPlayMetadataV2', 'progressiveStreams', 'adaptiveStreams',
      'videoComponent', 'feedSharedLinkedinVideo', 'feedSharedVideo', 'videoPlayer',
      'video', 'media', 'playMetadata', 'item', 'content', 'data',
      'playerProps', 'playerState', 'metadata', 'vpm', 'update', 'included', 'elements'
    ];
    for (const k of priorityKeys) {
      if (k in obj && obj[k] && typeof obj[k] === 'object') {
        const res = inspectObjectForVideo(obj[k], depth + 1, visited);
        if (res && (res.progressiveUrl || res.manifestUrl)) return res;
      }
    }

    for (const k of Object.keys(obj)) {
      if (
        k === '_owner' || k === 'alternate' || k === 'child' || k === 'sibling' ||
        k === 'return' || k === 'dependencies' ||
        k === 'ref' || k === 'updater' || k.startsWith('__react') || priorityKeys.includes(k)
      ) {
        continue;
      }
      try {
        const val = obj[k];
        if (val && typeof val === 'object') {
          const res = inspectObjectForVideo(val, depth + 1, visited);
          if (res && (res.progressiveUrl || res.manifestUrl)) return res;
        }
      } catch (e) {}
    }
    return parsed;
  }

  function findReactVideoMetadata(element) {
    if (!element) return null;
    const visited = new WeakSet();

    const candidateRoots = [element];
    const topContainer = element.closest('.feed-shared-update-v2, .occludable-update, [data-urn*="activity"], [data-urn*="ugcPost"], [data-entity-urn], article, .feed-shared-linkedin-video');
    if (topContainer && !candidateRoots.includes(topContainer)) {
      candidateRoots.push(topContainer);
    }

    for (const rootEl of candidateRoots) {
      // 1. Check DOM Element and ancestors for __reactProps$
      let curr = rootEl;
      let d = 0;
      while (curr && d < 20) {
        try {
          const propKey = Object.keys(curr).find(k => k.startsWith('__reactProps$'));
          if (propKey && curr[propKey]) {
            const meta = inspectObjectForVideo(curr[propKey], 0, visited);
            if (meta && (meta.progressiveUrl || meta.manifestUrl)) return meta;
          }
        } catch (e) {}
        curr = curr.parentElement;
        d++;
      }

      // 2. Direct Fiber Walk: Ascend component tree via fiber.return
      let fiberNode = rootEl;
      let fDepth = 0;
      let fiber = null;
      while (fiberNode && fDepth < 20) {
        const fiberKey = Object.keys(fiberNode).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (fiberKey && fiberNode[fiberKey]) {
          fiber = fiberNode[fiberKey];
          break;
        }
        fiberNode = fiberNode.parentElement;
        fDepth++;
      }

      if (fiber) {
        let fCount = 0;
        while (fiber && fCount < 60) {
          if (fiber.memoizedProps) {
            const meta = inspectObjectForVideo(fiber.memoizedProps, 0, visited);
            if (meta && (meta.progressiveUrl || meta.manifestUrl)) return meta;
          }
          if (fiber.pendingProps) {
            const meta = inspectObjectForVideo(fiber.pendingProps, 0, visited);
            if (meta && (meta.progressiveUrl || meta.manifestUrl)) return meta;
          }
          if (fiber.stateNode && typeof fiber.stateNode === 'object' && !(fiber.stateNode instanceof (typeof Node !== 'undefined' ? Node : Object))) {
            const meta = inspectObjectForVideo(fiber.stateNode, 0, visited);
            if (meta && (meta.progressiveUrl || meta.manifestUrl)) return meta;
          }
          if (fiber.memoizedState) {
            let hook = fiber.memoizedState;
            let hCount = 0;
            while (hook && hCount < 20) {
              if (hook.memoizedState) {
                const meta = inspectObjectForVideo(hook.memoizedState, 0, visited);
                if (meta && (meta.progressiveUrl || meta.manifestUrl)) return meta;
              }
              hook = hook.next;
              hCount++;
            }
          }
          fiber = fiber.return;
          fCount++;
        }
      }
    }

    return null;
  }

  window.addEventListener('__GARRETT_QUERY_REACT_STREAM__', (e) => {
    if (!e.detail) return;
    const videoId = e.detail.videoId;
    const blobUrl = e.detail.blobUrl;
    let targetVideo = null;

    if (videoId) {
      targetVideo = document.querySelector(`video[data-garrett-video-id="${videoId}"]`);
    }
    if (!targetVideo && blobUrl) {
      const allVideos = document.querySelectorAll('video');
      for (const v of allVideos) {
        if (v.currentSrc === blobUrl || v.src === blobUrl) {
          targetVideo = v;
          break;
        }
      }
    }
    if (!targetVideo) {
      const allVideos = document.querySelectorAll('video');
      if (allVideos.length === 1) {
        targetVideo = allVideos[0];
      }
    }

    if (targetVideo) {
      const meta = findReactVideoMetadata(targetVideo);
      if (meta) {
        window.dispatchEvent(new CustomEvent('__GARRETT_REACT_STREAM_FOUND__', {
          detail: {
            videoId: videoId || targetVideo.getAttribute('data-garrett-video-id') || null,
            blobUrl: blobUrl || targetVideo.currentSrc || targetVideo.src || null,
            ...meta
          }
        }));
      }
    }
  });
})();

