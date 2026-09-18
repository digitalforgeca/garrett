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

  function isProgressiveMp4Url(url) {
    if (isNonMediaUrl(url)) return false;
    const clean = url.split('?')[0].toLowerCase();
    return (
      (clean.includes('/playlist/vid/v2/') || clean.includes('/playlist/vid/')) &&
      (clean.includes('/mp4-') || clean.includes('mp4_') || clean.endsWith('.mp4')) &&
      !clean.includes('videocover')
    );
  }

  function isSegmentUrl(url) {
    if (isNonMediaUrl(url)) return false;
    if (isProgressiveMp4Url(url)) return false;
    const clean = url.split('?')[0].toLowerCase();
    return (
      clean.endsWith('.m4s') ||
      clean.endsWith('.ts') ||
      clean.endsWith('.init') ||
      clean.includes('init.mp4') ||
      clean.includes('iso.segment') ||
      clean.includes('/segment') ||
      clean.includes('/chunk') ||
      clean.includes('output_hls') ||
      (url.includes('/playlist/vid/') && /\/[0-9]+\/[0-9]+(\?|$)/.test(url))
    );
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

        if (isManifestUrl(url)) {
          this.addEventListener('load', () => {
            try {
              if (this.status >= 200 && this.status < 300 && this.responseText) {
                const text = this.responseText;
                if (text && (text.includes('<MPD') || text.includes('#EXTM3U'))) {
                  window.dispatchEvent(new CustomEvent('__GARRETT_MANIFEST_CONTENT__', {
                    detail: { url, text, timestamp: Date.now() }
                  }));
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
              byteLength: chunk.byteLength,
              timestamp: Date.now()
            }
          }));
        }
      } catch (err) {}
      return originalAppendBuffer.apply(this, arguments);
    };
  }

  function getBestProgressiveUrl(progressiveStreams) {
    if (!Array.isArray(progressiveStreams) || progressiveStreams.length === 0) return null;
    const sorted = progressiveStreams.slice().sort((a, b) => {
      const resA = (a.width || 0) * (a.height || 0);
      const resB = (b.width || 0) * (b.height || 0);
      if (resA !== resB) return resB - resA;
      return (b.bitRate || 0) - (a.bitRate || 0);
    });
    const best = sorted[0];
    const loc = best?.streamingLocations?.[0]?.url ||
                (typeof best?.streamingLocations?.[0] === 'string' ? best.streamingLocations[0] : null) ||
                best?.url;
    return loc ? { url: loc, width: best.width, height: best.height, bitRate: best.bitRate } : null;
  }

  function parseVideoMetadata(metaObj) {
    if (!metaObj || typeof metaObj !== 'object') return null;
    const vpm = metaObj.videoPlayMetadata || metaObj;
    const bestProg = getBestProgressiveUrl(vpm.progressiveStreams);
    const dashUrl = vpm.adaptiveStreams?.find(s => s.protocol === 'DASH' || s.url?.includes('dash') || s.url?.includes('.mpd'))?.url;
    const hlsUrl = vpm.adaptiveStreams?.find(s => s.protocol === 'HLS' || s.url?.includes('m3u8'))?.url;
    const manifestUrl = dashUrl || hlsUrl || (typeof vpm.manifestUrl === 'string' ? vpm.manifestUrl : null);
    const progUrl = bestProg ? bestProg.url : (typeof vpm.progressiveUrl === 'string' ? vpm.progressiveUrl : null);
    const dur = vpm.duration ? (vpm.duration > 1000 ? vpm.duration / 1000 : vpm.duration) : null;
    const entityUrn = vpm.entityUrn || vpm.mediaUrn || metaObj.entityUrn || null;

    if (progUrl || manifestUrl) {
      return {
        progressiveUrl: progUrl,
        manifestUrl: manifestUrl,
        dashUrl: dashUrl || null,
        hlsUrl: hlsUrl || null,
        entityUrn: entityUrn,
        duration: dur
      };
    }
    return null;
  }

  function inspectObjectForVideo(obj, depth = 0, visited = new WeakSet()) {
    if (!obj || depth > 3 || typeof obj !== 'object') return null;
    if (obj instanceof (typeof Node !== 'undefined' ? Node : Object) && obj.nodeType) return null;
    if (obj === window || obj === document) return null;
    if (visited.has(obj)) return null;
    visited.add(obj);

    const parsed = parseVideoMetadata(obj);
    if (parsed) return parsed;

    for (const k of Object.keys(obj)) {
      if (
        k === '_owner' || k === 'alternate' || k === 'child' || k === 'sibling' ||
        k === 'return' || k === 'stateNode' || k === 'memoizedState' || k === 'dependencies' ||
        k === 'ref' || k === 'updater' || k.startsWith('__react')
      ) {
        continue;
      }
      try {
        const val = obj[k];
        if (val && typeof val === 'object') {
          const res = inspectObjectForVideo(val, depth + 1, visited);
          if (res) return res;
        }
      } catch (e) {}
    }
    return null;
  }

  function findReactVideoMetadata(element) {
    if (!element) return null;
    const visited = new WeakSet();

    // 1. Check DOM Element and immediate parent __reactProps$
    let curr = element;
    let d = 0;
    while (curr && d < 3) {
      try {
        const propKey = Object.keys(curr).find(k => k.startsWith('__reactProps$'));
        if (propKey && curr[propKey]) {
          const meta = inspectObjectForVideo(curr[propKey], 0, visited);
          if (meta) return meta;
        }
      } catch (e) {}
      curr = curr.parentElement;
      d++;
    }

    // 2. Direct Fiber Walk: Ascend immediate component tree (max 8 fibers)
    let fiberNode = element;
    let fDepth = 0;
    while (fiberNode && fDepth < 3) {
      const fiberKey = Object.keys(fiberNode).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (fiberKey && fiberNode[fiberKey]) {
        let fiber = fiberNode[fiberKey];
        let fCount = 0;
        while (fiber && fCount < 8) {
          if (fiber.memoizedProps) {
            const meta = inspectObjectForVideo(fiber.memoizedProps, 0, visited);
            if (meta) return meta;
          }
          fiber = fiber.return;
          fCount++;
        }
        break;
      }
      fiberNode = fiberNode.parentElement;
      fDepth++;
    }

    return null;
  }

  window.addEventListener('__GARRETT_QUERY_REACT_STREAM__', (e) => {
    if (e.detail && e.detail.blobUrl) {
      const allVideos = document.querySelectorAll('video');
      let targetVideo = null;
      for (const v of allVideos) {
        if (v.currentSrc === e.detail.blobUrl || v.src === e.detail.blobUrl) {
          targetVideo = v;
          break;
        }
      }
      if (!targetVideo && allVideos.length === 1) {
        targetVideo = allVideos[0];
      }
      if (!targetVideo) {
        for (const v of allVideos) {
          if (!v.paused || v.currentTime > 0) {
            targetVideo = v;
            break;
          }
        }
      }

      if (targetVideo) {
        const meta = findReactVideoMetadata(targetVideo);
        if (meta) {
          window.dispatchEvent(new CustomEvent('__GARRETT_REACT_STREAM_FOUND__', {
            detail: {
              videoId: e.detail.videoId,
              blobUrl: e.detail.blobUrl,
              ...meta
            }
          }));
        }
      }
    }
  });
})();
