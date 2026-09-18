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

    // YouTube progressive videoplayback itags (18 = 360p, 22 = 720p, 37 = 1080p, 38, 43)
    if (clean.includes('googlevideo.com/videoplayback') || clean.includes('/videoplayback')) {
      const itagMatch = url.match(/[?&]itag=(\d+)/);
      if (itagMatch) {
        const itag = parseInt(itagMatch[1], 10);
        if ([18, 22, 37, 38, 43].includes(itag)) {
          return true;
        }
      }
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
    if (typeof item.src === 'string') return item.src;
    if (typeof item.manifestUrl === 'string') return item.manifestUrl;
    if (typeof item.playbackUrl === 'string') return item.playbackUrl;
    if (typeof item.masterPlaylistUrl === 'string') return item.masterPlaylistUrl;
    if (Array.isArray(item.streamingLocations)) {
      for (const loc of item.streamingLocations) {
        if (!loc) continue;
        if (typeof loc === 'string') return loc;
        if (typeof loc.url === 'string') return loc.url;
        if (typeof loc.src === 'string') return loc.src;
        if (typeof loc.masterPlaylistUrl === 'string') return loc.masterPlaylistUrl;
        if (typeof loc.manifestUrl === 'string') return loc.manifestUrl;
        if (typeof loc.playbackUrl === 'string') return loc.playbackUrl;
      }
    }
    const singleLoc = item.streamingLocation || item.location;
    if (singleLoc) {
      if (typeof singleLoc === 'string') return singleLoc;
      if (typeof singleLoc.url === 'string') return singleLoc.url;
      if (typeof singleLoc.src === 'string') return singleLoc.src;
      if (typeof singleLoc.masterPlaylistUrl === 'string') return singleLoc.masterPlaylistUrl;
      if (typeof singleLoc.manifestUrl === 'string') return singleLoc.manifestUrl;
      if (typeof singleLoc.playbackUrl === 'string') return singleLoc.playbackUrl;
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

  function extractYouTubeVideoId(urlOrStr) {
    if (!urlOrStr || typeof urlOrStr !== 'string') return null;
    try {
      const vMatch = urlOrStr.match(/[?&]v=([a-zA-Z0-9_-]{11})(?:[&?]|$)/);
      if (vMatch) return vMatch[1];
      const shortsMatch = urlOrStr.match(/\/shorts\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch = urlOrStr.match(/\/embed\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/);
      if (embedMatch) return embedMatch[1];
      const beMatch = urlOrStr.match(/youtu\.be\/([a-zA-Z0-9_-]{11})(?:[/?#]|$)/);
      if (beMatch) return beMatch[1];
      const docidMatch = urlOrStr.match(/[?&]docid=([a-zA-Z0-9_-]{11})(?:[&?]|$)/);
      if (docidMatch) return docidMatch[1];
      if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrStr)) return urlOrStr;
      return null;
    } catch {
      return null;
    }
  }

  function cleanProgressiveUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.includes('googlevideo.com/videoplayback') || url.includes('/videoplayback')) {
      try {
        const parsed = new URL(url);
        parsed.searchParams.delete('range');
        parsed.searchParams.delete('rn');
        parsed.searchParams.delete('rbuf');
        return parsed.toString();
      } catch (e) {
        return url
          .replace(/([?&])range=[^&]*/g, '$1')
          .replace(/([?&])rn=[^&]*/g, '$1')
          .replace(/([?&])rbuf=[^&]*/g, '$1')
          .replace(/[?&]&+/g, '&')
          .replace(/\?&/, '?')
          .replace(/[?&]$/, '');
      }
    }
    return url;
  }

  const extractStreamKey = (typeof window.GarrettQueue !== 'undefined' && window.GarrettQueue.extractStreamKey) || function (url) {
    if (!url || typeof url !== 'string') return '';
    try {
      const ytId = extractYouTubeVideoId(url);
      if (ytId) return ytId;

      if (url.includes('googlevideo.com/videoplayback') || url.includes('/videoplayback')) {
        const docidMatch = url.match(/[?&]docid=([a-zA-Z0-9_-]{11})/i);
        if (docidMatch) return docidMatch[1];
        const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/i);
        if (idMatch) return idMatch[1];
      }

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

  function cleanEntityKey(key) {
    if (!key) return '';
    return String(key).replace(/^(?:urn:(?:li|youtube):[^:]+:|yt_)/i, '').trim();
  }

  function entityKeysMatch(key1, key2) {
    if (!key1 || !key2) return false;
    const k1 = cleanEntityKey(key1);
    const k2 = cleanEntityKey(key2);
    if (!k1 || !k2) return false;
    if (k1 === k2) return true;

    const isNum1 = /^\d+$/.test(k1);
    const isNum2 = /^\d+$/.test(k2);
    if (isNum1 && isNum2) return k1 === k2;
    if (isNum1 !== isNum2) return false;

    if (k1.length === k2.length && k1.length >= 14) {
      if (k1.slice(1) === k2.slice(1)) return true;
    }
    return false;
  }

  function streamUrlMatchesKey(url, key) {
    if (!url || !key) return false;
    const streamKey = extractStreamKey(url);
    if (!streamKey) return false;
    return entityKeysMatch(streamKey, key);
  }

  const discoveredManifestCache = [];

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
      if (!streamKey) return;

      discoveredManifestCache.push({ url: e.detail.url, text: e.detail.text || '', streamKey });
      if (discoveredManifestCache.length > 50) discoveredManifestCache.shift();

      const isHls = e.detail.url.includes('.m3u8') || e.detail.url.includes('/hls/');
      for (const state of videoRegistry.values()) {
        if (!state.video || !state.video.isConnected) continue;
        const keyMatch = (state.mediaKey && entityKeysMatch(state.mediaKey, streamKey)) ||
                         (state.allSegments && state.allSegments.some(s => streamUrlMatchesKey(s, streamKey))) ||
                         (state.allKeys && Array.from(state.allKeys).some(k => entityKeysMatch(k, streamKey)));

        if (keyMatch) {
          if (isHls) {
            state.hlsUrl = e.detail.url;
            state.manifestUrl = e.detail.url;
            state.manifestXml = e.detail.text || '';
          } else {
            state.dashUrl = e.detail.url;
            state.dashXml = e.detail.text || '';
            // NEVER let DASH overwrite an existing HLS URL!
            if (!state.hlsUrl && (!state.manifestUrl || !state.manifestUrl.includes('.m3u8'))) {
              state.manifestUrl = e.detail.url;
              state.manifestXml = e.detail.text || '';
            }
          }
          if (!state.mediaKey) state.mediaKey = streamKey;
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
      if (!streamKey) return;

      for (const state of videoRegistry.values()) {
        if (!state.video || !state.video.isConnected) continue;
        const v = state.video;
        const activePlaying = Array.from(videoRegistry.values()).filter(s => s.video && !s.video.paused);
        const matchesState = (state.mediaKey && entityKeysMatch(state.mediaKey, streamKey)) ||
                             (state.allSegments && state.allSegments.some(s => streamUrlMatchesKey(s, streamKey))) ||
                             (!state.mediaKey && v && !v.paused && activePlaying.length === 1);
        if (matchesState) {
          if (!state.allSegments) state.allSegments = [];
          if (!state.allSegments.includes(e.detail.url)) {
            state.allSegments.push(e.detail.url);
          }
          if (!state.mediaKey) state.mediaKey = streamKey;
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
      const msId = e.detail.mediaSourceId;
      const targetBlobUrl = msId ? mediaSourceToBlob.get(msId) : null;

      for (const state of videoRegistry.values()) {
        const v = state.video;
        if (!v || !v.isConnected) continue;
        const vSrc = v.currentSrc || v.src || '';
        const matches = targetBlobUrl ? (vSrc === targetBlobUrl) : (!v.paused);

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
        if (!state.video || !state.video.isConnected) continue;
        if (matchesVideoMetadata(state, meta)) {
          if (meta.progressiveUrl && !state.progressiveUrl) {
            state.progressiveUrl = meta.progressiveUrl;
          }
          if (meta.hlsUrl) {
            state.hlsUrl = meta.hlsUrl;
            state.manifestUrl = meta.hlsUrl;
          } else if (meta.manifestUrl && (meta.manifestUrl.includes('.m3u8') || meta.manifestUrl.includes('/hls/'))) {
            state.hlsUrl = meta.manifestUrl;
            state.manifestUrl = meta.manifestUrl;
          } else if (meta.dashUrl || meta.manifestUrl) {
            state.dashUrl = meta.dashUrl || meta.manifestUrl;
            if (!state.hlsUrl && (!state.manifestUrl || !state.manifestUrl.includes('.m3u8'))) {
              state.manifestUrl = state.dashUrl;
            }
          }
          if (meta.duration && meta.duration > 0 && (!state.duration || state.duration <= 5)) {
            state.duration = meta.duration;
          }
          if (meta.mediaKey && !state.mediaKey) {
            state.mediaKey = meta.mediaKey;
          }
          if (meta.activityUrn && !state.activityUrn) {
            state.activityUrn = meta.activityUrn;
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
        if (!v || !v.isConnected) continue;
        const matchesVideo = (e.detail.videoId && state.id === e.detail.videoId) ||
                             (e.detail.blobUrl && (v.currentSrc === e.detail.blobUrl || v.src === e.detail.blobUrl)) ||
                             (e.detail.mediaKey && state.mediaKey && entityKeysMatch(state.mediaKey, e.detail.mediaKey));
        if (matchesVideo) {
          if (e.detail.progressiveUrl) state.progressiveUrl = e.detail.progressiveUrl;
          if (e.detail.hlsUrl) {
            state.hlsUrl = e.detail.hlsUrl;
            state.manifestUrl = e.detail.hlsUrl;
          } else if (e.detail.manifestUrl && (e.detail.manifestUrl.includes('.m3u8') || e.detail.manifestUrl.includes('/hls/'))) {
            state.hlsUrl = e.detail.manifestUrl;
            state.manifestUrl = e.detail.manifestUrl;
          } else if (e.detail.dashUrl || e.detail.manifestUrl) {
            state.dashUrl = e.detail.dashUrl || e.detail.manifestUrl;
            if (!state.hlsUrl && (!state.manifestUrl || !state.manifestUrl.includes('.m3u8'))) {
              state.manifestUrl = state.dashUrl;
            }
          }
          if (e.detail.mediaKey && !state.mediaKey) state.mediaKey = e.detail.mediaKey;
          if (e.detail.activityUrn && !state.activityUrn) state.activityUrn = e.detail.activityUrn;
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
      if (!streamKey) return;

      for (const state of videoRegistry.values()) {
        const v = state.video;
        if (!v || !v.isConnected) continue;
        const matchesState = (state.mediaKey && entityKeysMatch(state.mediaKey, streamKey)) ||
                             (state.allSegments && state.allSegments.some(s => streamUrlMatchesKey(s, streamKey)));
        if (matchesState) {
          state.progressiveUrl = progUrl;
          if (!state.mediaKey) state.mediaKey = streamKey;
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
    let title = '';
    const isYouTube = location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be');
    if (isYouTube) {
      const ytTitleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, #title h1, h1.title, ytd-reel-video-renderer h2.title');
      if (ytTitleEl && ytTitleEl.textContent) {
        title = ytTitleEl.textContent.trim();
      }
    }
    if (!title) {
      title = document.title || 'video';
    }
    title = title.replace(/\s*-\s*YouTube.*$/i, '').replace(/[/\\?%*:|"<>]/g, '-').trim();
    if (title.length > 50) title = title.substring(0, 50).trim();
    if (!title) title = 'video';
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

    // 0. YouTube detection: Watch page, Shorts, or Embeds
    const isYouTube = location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be') || !!video.closest('#movie_player, .html5-video-player');
    if (isYouTube) {
      let ytId = null;
      const shortsContainer = video.closest('ytd-reel-video-renderer, shorts-video, ytd-shorts');
      if (shortsContainer) {
        const link = shortsContainer.querySelector('a[href*="/shorts/"], a[href*="/watch?v="]');
        if (link) {
          const href = link.getAttribute('href') || '';
          ytId = extractYouTubeVideoId(href);
        }
      }
      if (!ytId) {
        ytId = extractYouTubeVideoId(location.href);
      }
      if (!ytId) {
        const moviePlayer = video.closest('#movie_player, .html5-video-player') || document.getElementById('movie_player');
        if (moviePlayer) {
          const vidData = moviePlayer.getAttribute('data-video-id');
          if (vidData) ytId = vidData;
        }
      }

      if (ytId) {
        info.mediaKey = ytId;
        info.primaryKey = ytId;
        info.activityUrn = `yt_${ytId}`;
        info.allKeys.add(ytId);
        info.allKeys.add(`yt_${ytId}`);
        info.allKeys.add(`urn:youtube:video:${ytId}`);
        return info;
      }
    }

    // 1. Find player wrapper and post container
    const playerWrapper = video.closest('.feed-shared-linkedin-video, .video-js, [class*="player"]') || video.parentElement;
    const postContainer = video.closest('.feed-shared-update-v2, .occludable-update, [data-urn*="activity"], [data-urn*="ugcPost"], [data-entity-urn], article') || playerWrapper;

    // 1b. Check data-sources attribute on video or player wrapper (used by LinkedIn web player)
    const dsVal = video.getAttribute('data-sources') || (playerWrapper && playerWrapper.getAttribute('data-sources'));
    if (dsVal) {
      try {
        const parsedSources = JSON.parse(dsVal);
        if (Array.isArray(parsedSources)) {
          for (const s of parsedSources) {
            const u = s.src || s.url;
            if (u && typeof u === 'string' && isGenuineProgressiveMp4Url(u)) {
              info.progressiveUrl = u;
              const k = extractStreamKey(u);
              if (k) {
                if (!info.mediaKey) info.mediaKey = k;
                info.allKeys.add(k);
              }
              break;
            }
          }
        }
      } catch (e) {}
    }

    // 2. Check direct poster attribute on video (ignoring user avatars & company logos)
    const poster = video.getAttribute('poster') || video.poster || '';
    if (poster) {
      const cleanPoster = poster.split('?')[0].toLowerCase();
      if (!cleanPoster.includes('profile-displayphoto') && !cleanPoster.includes('company-logo')) {
        const pm = poster.match(/(?:dms\/image\/(?:sync\/)?(?:v2\/)?|videocover[^\/]*\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i);
        if (pm) {
          info.mediaKey = pm[1];
          info.allKeys.add(pm[1]);
        }
      }
    }

    // 3. Search thumbnail / preview elements ONLY inside the player wrapper (NEVER in outer post container which contains avatars)
    if (playerWrapper) {
      const thumbElements = playerWrapper.querySelectorAll('[style*="videocover"], [style*="dms/image"], img');
      for (const el of thumbElements) {
        const src = el.src || el.getAttribute('src') || el.getAttribute('style') || '';
        const cleanSrc = src.split('?')[0].toLowerCase();
        if (cleanSrc.includes('profile-displayphoto') || cleanSrc.includes('company-logo')) {
          continue;
        }
        const m = src.match(/(?:dms\/image\/(?:sync\/)?(?:v2\/)?|videocover[^\/]*\/|playlist\/vid\/(?:v2\/|dash\/)?)\/?([A-Za-z0-9_-]{8,})/i);
        if (m) {
          if (!info.mediaKey) info.mediaKey = m[1];
          info.allKeys.add(m[1]);
          break;
        }
      }
    }

    // 4. Extract post-level activity/ugcPost URN from postContainer and playerWrapper
    const searchRoots = [postContainer, playerWrapper].filter(Boolean);
    for (const r of searchRoots) {
      const els = [r, ...r.querySelectorAll('[data-urn*="activity"], [data-urn*="ugcPost"], [data-entity-urn*="activity"], [data-entity-urn*="ugcPost"]')];
      for (const el of els) {
        for (const attr of ['data-urn', 'data-entity-urn', 'data-activity-urn']) {
          const val = el.getAttribute ? el.getAttribute(attr) : '';
          if (!val || typeof val !== 'string') continue;
          const actMatch = val.match(/urn:li:(?:activity|ugcPost|share):([0-9]{10,})/i);
          if (actMatch) {
            if (!info.activityUrn) info.activityUrn = actMatch[1];
            info.allKeys.add(actMatch[1]);
            info.allKeys.add(actMatch[0]);
          }
          const mediaMatch = val.match(/urn:li:(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i);
          if (mediaMatch) {
            if (!info.mediaKey) info.mediaKey = mediaMatch[1];
            info.allKeys.add(mediaMatch[1]);
            info.allKeys.add(mediaMatch[0]);
          }
        }
        if (info.activityUrn && info.mediaKey) break;
      }
      if (info.activityUrn) break;
    }

    info.primaryKey = info.mediaKey || info.activityUrn || '';
    return info;
  }

  function extractVideoEntityKeyFromDom(video) {
    const info = extractVideoEntityInfoFromDom(video);
    return info.primaryKey;
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

      // 1. Check progress sliders and range inputs (disregard 100/1 which represent 0-100% progress)
      for (const root of searchRoots) {
        const sliders = root.querySelectorAll('[role="slider"], input[type="range"], [class*="progress"], [class*="seekbar"]');
        for (const s of sliders) {
          const ariaText = s.getAttribute('aria-valuetext') || '';
          if (ariaText) {
            const m = [...ariaText.matchAll(/\b(?:(\d+):)?(\d{1,2}):(\d{2})\b/g)];
            for (const match of m) {
              const h = match[1] ? parseInt(match[1], 10) : 0;
              const mins = parseInt(match[2], 10);
              const secs = parseInt(match[3], 10);
              const tot = h * 3600 + mins * 60 + secs;
              if (tot > maxSec) maxSec = tot;
            }
          }
          const vMax = parseFloat(s.getAttribute('aria-valuemax') || s.getAttribute('max') || '0');
          if (vMax > 0 && vMax !== 100 && vMax !== 1 && isFinite(vMax)) {
            if (vMax > maxSec) maxSec = vMax;
          }
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
    if (!isBlob && vidDur > 0) {
      return vidDur;
    }
    // For blob (MSE) streams, video.duration represents ONLY the buffered chunks (e.g. 24s, 36s).
    // It must NEVER be used as the presentation duration, as doing so artificially truncates DASH synthesis.
    return 0;
  }

  function matchesVideoMetadata(videoState, meta) {
    if (!videoState || !meta) return false;

    // 1. Match by mediaKey
    if (videoState.mediaKey && meta.mediaKey && entityKeysMatch(videoState.mediaKey, meta.mediaKey)) {
      return true;
    }

    // 2. Match by post activity URN
    if (videoState.activityUrn && meta.activityUrn && entityKeysMatch(videoState.activityUrn, meta.activityUrn)) {
      return true;
    }

    // 3. Match across all collected keys and URNs
    if (videoState.allKeys && videoState.allKeys.size > 0) {
      if (meta.mediaKey && Array.from(videoState.allKeys).some(k => entityKeysMatch(k, meta.mediaKey))) return true;
      if (meta.activityUrn && Array.from(videoState.allKeys).some(k => entityKeysMatch(k, meta.activityUrn))) return true;
      if (meta.allKeys && Array.isArray(meta.allKeys)) {
        for (const mk of meta.allKeys) {
          if (Array.from(videoState.allKeys).some(k => entityKeysMatch(k, mk))) return true;
        }
      }
    }

    // 4. Match by active blob URL
    if (videoState.currentBlobUrl && meta.blobUrl && videoState.currentBlobUrl === meta.blobUrl) {
      return true;
    }

    // 5. Match by stream key in captured segments
    if (videoState.allSegments && videoState.allSegments.length > 0 && meta.mediaKey) {
      if (videoState.allSegments.some(s => streamUrlMatchesKey(s, meta.mediaKey))) {
        return true;
      }
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

        function scan(node, depth = 0, currentPostActivityUrn = null) {
          if (!node || depth > 12 || typeof node !== 'object') return;

          let postUrn = currentPostActivityUrn;
          const checkUrnForActivity = (val) => {
            if (!val || typeof val !== 'string') return null;
            const m = val.match(/urn:li:(?:activity|ugcPost|share):([0-9]{10,})/i);
            return m ? m[1] : null;
          };

          if (!postUrn) {
            postUrn = checkUrnForActivity(node.urn) ||
                      checkUrnForActivity(node.entityUrn) ||
                      checkUrnForActivity(node['$id']);
          }

          if (node.videoPlayMetadata && typeof node.videoPlayMetadata === 'object') {
            collected.push({ parent: node, vpm: node.videoPlayMetadata, activityUrn: postUrn });
          }
          if (Array.isArray(node.progressiveStreams) || Array.isArray(node.adaptiveStreams)) {
            collected.push({ parent: node, vpm: node, activityUrn: postUrn });
          }
          if (Array.isArray(node)) {
            for (const item of node) scan(item, depth + 1, postUrn);
          } else {
            for (const k of Object.keys(node)) {
              if (k === 'videoPlayMetadata') continue;
              scan(node[k], depth + 1, postUrn);
            }
          }
        }

        scan(json);

        for (const item of collected) {
          const vpm = item.vpm;
          const parent = item.parent || {};

          let mediaKey = null;
          const checkMediaVal = (val) => {
            if (!val || typeof val !== 'string') return null;
            const m = val.match(/(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i) ||
                      val.match(/^([CD][A-Za-z0-9_-]{14,})$/);
            return m ? m[1] : null;
          };

          mediaKey = checkMediaVal(vpm.mediaUrn) ||
                     checkMediaVal(vpm.entityUrn) ||
                     checkMediaVal(parent.mediaUrn) ||
                     checkMediaVal(parent.entityUrn) ||
                     checkMediaVal(parent.urn) ||
                     checkMediaVal(parent['$id']);

          let activityUrn = item.activityUrn;
          if (!activityUrn) {
            const checkActVal = (val) => {
              if (!val || typeof val !== 'string') return null;
              const m = val.match(/urn:li:(?:activity|ugcPost|share):([0-9]{10,})/i);
              return m ? m[1] : null;
            };
            activityUrn = checkActVal(parent.urn) || checkActVal(parent.entityUrn) || checkActVal(parent['$id']);
          }

          const progStreams = vpm.progressiveStreams || [];
          let bestProgUrl = null;
          if (progStreams.length > 0) {
            const sorted = progStreams.slice().sort((a, b) => {
              const resA = (a.width || 0) * (a.height || 0);
              const resB = (b.width || 0) * (b.height || 0);
              if (resA !== resB) return resB - resA;
              return (b.bitRate || 0) - (a.bitRate || 0);
            });
            for (const pItem of sorted) {
              if (!pItem) continue;
              const u = extractMediaUrlFromItem(pItem);
              if (u && typeof u === 'string' && isGenuineProgressiveMp4Url(u)) {
                bestProgUrl = u;
                if (!mediaKey) mediaKey = extractStreamKey(u);
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
            const proto = String(s.protocol || s.streamType || s.protocolType || s.format || s.type || '').toUpperCase();
            if (proto.includes('HLS') || u.includes('.m3u8') || u.includes('/hls/')) {
              if (!hlsUrl) hlsUrl = u;
            } else if (proto.includes('DASH') || u.includes('/dash/') || u.includes('.mpd')) {
              if (!dashUrl) dashUrl = u;
            }
            if (!mediaKey) mediaKey = extractStreamKey(u);
          }

          if (!hlsUrl) {
            const candHls = vpm.masterPlaylistUrl || vpm.hlsUrl || vpm.adaptiveHlsUrl || parent.masterPlaylistUrl || parent.hlsUrl || parent.adaptiveHlsUrl;
            if (candHls) hlsUrl = extractMediaUrlFromItem(candHls);
          }
          if (!dashUrl) {
            const candDash = vpm.dashUrl || vpm.adaptiveDashUrl || parent.dashUrl || parent.adaptiveDashUrl;
            if (candDash) dashUrl = extractMediaUrlFromItem(candDash);
          }

          const dur = vpm.duration ? (vpm.duration > 1000 ? vpm.duration / 1000 : vpm.duration) : 0;

          if (bestProgUrl || hlsUrl || dashUrl) {
            results.push({
              entityUrn: mediaKey ? `urn:li:digitalmediaAsset:${mediaKey}` : (activityUrn ? `urn:li:activity:${activityUrn}` : ''),
              mediaKey: mediaKey || null,
              activityUrn: activityUrn || null,
              progressiveUrl: bestProgUrl,
              manifestUrl: hlsUrl || dashUrl,
              hlsUrl,
              dashUrl,
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

  function resetVideoStateForNewStream(state, newSrc) {
    const curSrc = newSrc || (state.video ? (state.video.currentSrc || state.video.src || '') : '');
    state.currentBlobUrl = curSrc;
    state.progressiveUrl = null;
    state.hlsUrl = null;
    state.dashUrl = null;
    state.dashXml = null;
    state.manifestUrl = null;
    state.manifestXml = null;
    state.allSegments = [];
    state.capturedChunks = [];
    state.initChunk = null;
    state.initSegmentUrl = null;
    state.isKept = false;
    state.keptFilename = null;
    state.isDownloading = false;
    state.duration = 0;
    if (state.mainBtn) {
      const textEl = state.mainBtn.querySelector('.vbs-btn-text');
      if (textEl) {
        textEl.textContent = 'Keep Video';
        textEl.style.display = 'none';
      }
    }
    if (state.video) {
      const info = extractVideoEntityInfoFromDom(state.video);
      state.entityKey = info.primaryKey || '';
      state.mediaKey = info.mediaKey || '';
      state.activityUrn = info.activityUrn || '';
      state.allKeys = new Set(info.allKeys);
      state.poster = state.video.getAttribute('poster') || '';
    }
  }

  function registerVideo(video) {
    if (videoRegistry.has(video)) {
      const existingState = videoRegistry.get(video);
      const info = extractVideoEntityInfoFromDom(video);
      const curSrc = video.currentSrc || video.src || '';
      const curPoster = video.getAttribute('poster') || '';

      const activityChanged = info.activityUrn && existingState.activityUrn && info.activityUrn !== existingState.activityUrn;
      const mediaKeyChanged = info.mediaKey && existingState.mediaKey && !entityKeysMatch(info.mediaKey, existingState.mediaKey);
      const posterChanged = curPoster && existingState.poster && curPoster !== existingState.poster;

      if (activityChanged || mediaKeyChanged || posterChanged) {
        console.log(`[Garrett] Video element recycled for new post (old activity=${existingState.activityUrn}, new activity=${info.activityUrn})`);
        resetVideoStateForNewStream(existingState, curSrc);
        existingState.poster = curPoster;
        existingState.activityUrn = info.activityUrn;
        existingState.mediaKey = info.mediaKey;
        existingState.entityKey = info.primaryKey || info.mediaKey || info.activityUrn;
        existingState.allKeys = new Set(info.allKeys);

        // Pre-check discovered network metadata and embedded JSON for this new video
        try {
          const allMeta = [...discoveredMetadataCache, ...extractAllEmbeddedVideoMetadata()];
          for (const m of allMeta) {
            if (matchesVideoMetadata(existingState, m)) {
              if (m.progressiveUrl) existingState.progressiveUrl = m.progressiveUrl;
              if (m.hlsUrl) {
                existingState.hlsUrl = m.hlsUrl;
                existingState.manifestUrl = m.hlsUrl;
              } else if (m.manifestUrl && (m.manifestUrl.includes('.m3u8') || m.manifestUrl.includes('/hls/'))) {
                existingState.hlsUrl = m.manifestUrl;
                existingState.manifestUrl = m.manifestUrl;
              } else if (m.dashUrl || m.manifestUrl) {
                existingState.dashUrl = m.dashUrl || m.manifestUrl;
                if (!existingState.hlsUrl && (!existingState.manifestUrl || !existingState.manifestUrl.includes('.m3u8'))) {
                  existingState.manifestUrl = existingState.dashUrl;
                }
              }
              if (m.mediaKey) existingState.mediaKey = m.mediaKey;
              if (m.duration && m.duration > 0 && (!existingState.duration || existingState.duration <= 5)) existingState.duration = m.duration;
              if (m.progressiveUrl) break;
            }
          }
        } catch (e) {}
        if (!existingState.overlayBtn || !existingState.overlayBtn.isConnected) {
          createOverlayUI(existingState);
        }
        notifyBackground(existingState);
      } else {
        if (!existingState.activityUrn && info.activityUrn) {
          existingState.activityUrn = info.activityUrn;
          if (!existingState.entityKey) existingState.entityKey = info.activityUrn;
        }
        if (!existingState.mediaKey && info.mediaKey) {
          existingState.mediaKey = info.mediaKey;
          if (!existingState.entityKey || /^\d+$/.test(existingState.entityKey)) existingState.entityKey = info.mediaKey;
        }
        if (info.allKeys) {
          for (const k of info.allKeys) existingState.allKeys.add(k);
        }
        if (!existingState.poster && curPoster) {
          existingState.poster = curPoster;
        }
        if (!existingState.overlayBtn || !existingState.overlayBtn.isConnected) {
          createOverlayUI(existingState);
        }
      }
      return;
    }

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
      currentBlobUrl: video.currentSrc || video.src || '',
      progressiveUrl: null,
      hlsUrl: null,
      dashUrl: null,
      dashXml: null,
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
          if (m.hlsUrl) {
            state.hlsUrl = m.hlsUrl;
            state.manifestUrl = m.hlsUrl;
          } else if (m.manifestUrl && (m.manifestUrl.includes('.m3u8') || m.manifestUrl.includes('/hls/'))) {
            state.hlsUrl = m.manifestUrl;
            state.manifestUrl = m.manifestUrl;
          } else if (m.dashUrl || m.manifestUrl) {
            state.dashUrl = m.dashUrl || m.manifestUrl;
            if (!state.hlsUrl && (!state.manifestUrl || !state.manifestUrl.includes('.m3u8'))) {
              state.manifestUrl = state.dashUrl;
            }
          }
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
      const curSrc = video.currentSrc || video.src || '';
      if (curSrc && state.currentBlobUrl && curSrc !== state.currentBlobUrl) {
        resetVideoStateForNewStream(state, curSrc);
      } else if (curSrc && !state.currentBlobUrl) {
        state.currentBlobUrl = curSrc;
      }
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

    const onSrcChange = () => {
      const newSrc = video.currentSrc || video.src || '';
      if (newSrc && newSrc !== state.currentBlobUrl) {
        console.log(`[Garrett] Video source transition detected (${state.currentBlobUrl} -> ${newSrc}). Purging stale stream state.`);
        resetVideoStateForNewStream(state, newSrc);
        onUserPlay();
      }
    };

    video.addEventListener('loadstart', onSrcChange);
    video.addEventListener('emptied', onSrcChange);
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
        mediaKey: state.mediaKey || '',
        activityUrn: state.activityUrn || '',
        isBlob: src.startsWith('blob:'),
        poster: state.poster,
        duration: realDur,
        width: v ? (v.videoWidth || 0) : 0,
        height: v ? (v.videoHeight || 0) : 0,
        format: state.progressiveUrl ? 'MP4' : (state.manifestUrl ? (state.manifestUrl.includes('.m3u8') ? 'HLS' : 'DASH') : (src.startsWith('blob:') ? 'DASH' : 'MP4')),
        streamUrl: state.progressiveUrl || state.manifestUrl || src,
        hasProgressive: !!state.progressiveUrl,
        hasManifest: !!state.manifestUrl
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
    const parent = video ? video.parentElement : null;
    if (!parent) return;

    const isYouTube = location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be') || !!(video && video.closest('#movie_player, .html5-video-player'));
    const isShorts = isYouTube && (location.pathname.includes('/shorts/') || !!(video && video.closest('ytd-reel-video-renderer, shorts-video, ytd-shorts')));

    let targetParent = parent;
    if (isYouTube) {
      const ytPlayer = video.closest('#movie_player, .html5-video-player');
      if (ytPlayer) targetParent = ytPlayer;
    }

    const parentPos = window.getComputedStyle(targetParent).position;
    if (parentPos === 'static') {
      targetParent.style.position = 'relative';
    }

    // Clean up any existing overlay buttons on this specific parent
    targetParent.querySelectorAll('.vbs-overlay-btn, .vbs-btn-group, .vbs-action-pill').forEach(el => el.remove());

    // Single sleek action button: [ Keep Video ] with open hand icon
    const btn = document.createElement('button');
    btn.className = 'vbs-overlay-btn';
    if (isYouTube) {
      btn.classList.add('vbs-youtube-overlay');
      if (isShorts) {
        btn.classList.add('vbs-shorts-overlay');
      }
    }
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

    targetParent.appendChild(btn);
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
    if (domInfo.mediaKey && (!state.mediaKey || state.mediaKey !== domInfo.mediaKey)) {
      state.mediaKey = domInfo.mediaKey;
    }
    if (domInfo.activityUrn && (!state.activityUrn || state.activityUrn !== domInfo.activityUrn)) {
      state.activityUrn = domInfo.activityUrn;
    }
    if (domInfo.primaryKey) state.entityKey = domInfo.primaryKey;
    const entityKey = state.mediaKey || state.entityKey;
    state.entityKey = entityKey;
    const duration = resolveRealVideoDuration(state);

    // Fast Path -1: Direct progressive URL discovered from DOM data-sources attribute
    if (domInfo.progressiveUrl && isGenuineProgressiveMp4Url(domInfo.progressiveUrl)) {
      state.progressiveUrl = domInfo.progressiveUrl;
      return {
        progressiveUrl: domInfo.progressiveUrl,
        isStream: false,
        format: 'DIRECT',
        streamKey: state.mediaKey || entityKey
      };
    }

    // Fast Path 0: Already cached progressive MP4 URL (validate it matches this video's mediaKey)
    if (state.progressiveUrl) {
      const progKey = extractStreamKey(state.progressiveUrl);
      if (!state.mediaKey || !progKey || entityKeysMatch(state.mediaKey, progKey)) {
        return {
          progressiveUrl: state.progressiveUrl,
          isStream: false,
          format: 'DIRECT',
          streamKey: state.mediaKey || entityKey
        };
      } else {
        state.progressiveUrl = null;
      }
    }

    // Trigger immediate React Fiber or YouTube query
    if (currentSrc.startsWith('blob:') || !state.progressiveUrl) {
      const isYouTube = location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be') || !!(video && video.closest('#movie_player, .html5-video-player'));
      if (isYouTube) {
        window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_YOUTUBE_STREAM__', {
          detail: { videoId: state.id, mediaKey: state.mediaKey }
        }));
      } else {
        window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
          detail: { videoId: state.id, blobUrl: currentSrc }
        }));
      }
    }

    // Fast Path 1: Check React Stream Cache
    const rMetaFast = (state.id && reactStreamCache.get(state.id)) || (currentSrc && reactStreamCache.get(currentSrc));
    if (rMetaFast && matchesVideoMetadata(state, rMetaFast)) {
      if (rMetaFast.duration && rMetaFast.duration > 0 && (!state.duration || state.duration <= 5)) {
        state.duration = rMetaFast.duration;
      }
      if (rMetaFast.progressiveUrl) {
        state.progressiveUrl = rMetaFast.progressiveUrl;
        return {
          progressiveUrl: rMetaFast.progressiveUrl,
          isStream: false,
          format: 'DIRECT',
          streamKey: rMetaFast.mediaKey || state.mediaKey || entityKey
        };
      }
      const fastHls = rMetaFast.hlsUrl || ((rMetaFast.manifestUrl && (rMetaFast.manifestUrl.includes('.m3u8') || rMetaFast.manifestUrl.includes('/hls/'))) ? rMetaFast.manifestUrl : null);
      if (fastHls) {
        state.hlsUrl = fastHls;
        state.manifestUrl = fastHls;
        return {
          url: fastHls,
          manifestXml: '',
          isStream: true,
          format: 'HLS',
          streamKey: rMetaFast.mediaKey || state.mediaKey || entityKey,
          allSegments: []
        };
      }
      if (rMetaFast.manifestUrl && !state.manifestUrl) {
        state.dashUrl = rMetaFast.manifestUrl;
        state.manifestUrl = rMetaFast.manifestUrl;
      }
    }

    // Fast Path 2: Check Discovered Network Metadata & Embedded DOM JSON
    try {
      const allMeta = [...discoveredMetadataCache, ...extractAllEmbeddedVideoMetadata()];
      for (const m of allMeta) {
        if (matchesVideoMetadata(state, m)) {
          if (m.mediaKey) state.mediaKey = m.mediaKey;
          if (m.activityUrn) state.activityUrn = m.activityUrn;
          if (m.duration && m.duration > 0 && (!state.duration || state.duration <= 5)) {
            state.duration = m.duration;
          }
          if (m.progressiveUrl) {
            state.progressiveUrl = m.progressiveUrl;
            return {
              progressiveUrl: m.progressiveUrl,
              isStream: false,
              format: 'DIRECT',
              streamKey: m.mediaKey || state.mediaKey || state.entityKey
            };
          }
          const candHls = m.hlsUrl || ((m.manifestUrl && (m.manifestUrl.includes('.m3u8') || m.manifestUrl.includes('/hls/'))) ? m.manifestUrl : null);
          if (candHls) {
            state.hlsUrl = candHls;
            state.manifestUrl = candHls;
            return {
              url: candHls,
              manifestXml: '',
              isStream: true,
              format: 'HLS',
              streamKey: m.mediaKey || state.mediaKey || state.entityKey,
              allSegments: []
            };
          }
          if (m.manifestUrl && !state.manifestUrl) {
            state.dashUrl = m.manifestUrl;
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

    // Trigger React Fiber or YouTube query to pageHook in MAIN world
    if (currentSrc.startsWith('blob:')) {
      const isYouTube = location.hostname.includes('youtube.com') || location.hostname.includes('youtu.be') || !!(video && video.closest('#movie_player, .html5-video-player'));
      if (isYouTube) {
        window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_YOUTUBE_STREAM__', {
          detail: { videoId: state.id, mediaKey: state.mediaKey }
        }));
      } else {
        window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
          detail: { videoId: state.id, blobUrl: currentSrc }
        }));
      }
    }

    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      // Check React Cache again if arrived asynchronously
      const rMetaAsync = (state.id && reactStreamCache.get(state.id)) || (currentSrc && reactStreamCache.get(currentSrc));
      if (rMetaAsync && matchesVideoMetadata(state, rMetaAsync)) {
        if (rMetaAsync.progressiveUrl) {
          state.progressiveUrl = rMetaAsync.progressiveUrl;
          return {
            progressiveUrl: rMetaAsync.progressiveUrl,
            isStream: false,
            format: 'DIRECT',
            streamKey: rMetaAsync.mediaKey || state.mediaKey || state.entityKey
          };
        }
        const asyncHls = rMetaAsync.hlsUrl || ((rMetaAsync.manifestUrl && (rMetaAsync.manifestUrl.includes('.m3u8') || rMetaAsync.manifestUrl.includes('/hls/'))) ? rMetaAsync.manifestUrl : null);
        if (asyncHls) {
          state.hlsUrl = asyncHls;
          state.manifestUrl = asyncHls;
          return {
            url: asyncHls,
            manifestXml: '',
            isStream: true,
            format: 'HLS',
            streamKey: rMetaAsync.mediaKey || state.mediaKey || state.entityKey,
            allSegments: []
          };
        }
        if (rMetaAsync.manifestUrl && !state.manifestUrl) {
          state.dashUrl = rMetaAsync.manifestUrl;
          state.manifestUrl = rMetaAsync.manifestUrl;
        }
      }

      // Check performance resource entries for manifests or progressive MP4s
      try {
        if (state.allSegments && state.allSegments.length > 0) {
          for (const seg of state.allSegments) {
            const k = extractStreamKey(seg);
            if (k) {
              if (!state.mediaKey) state.mediaKey = k;
              if (state.allKeys) state.allKeys.add(k);
              break;
            }
          }
        }

        const resEntries = performance.getEntriesByType('resource');
        for (let i = resEntries.length - 1; i >= 0; i--) {
          const name = resEntries[i].name;
          if (isNonMediaUrl(name)) continue;

          const nameKey = extractStreamKey(name);
          if (!nameKey) continue;
          let matchesKey = state.mediaKey ? entityKeysMatch(state.mediaKey, nameKey) : false;
          if (!matchesKey && state.allSegments && state.allSegments.length > 0) {
            matchesKey = state.allSegments.some(s => streamUrlMatchesKey(s, nameKey));
          }

          if (matchesKey) {
            const isClaimedByOther = Array.from(videoRegistry.values()).some(other => other !== state && (other.progressiveUrl === name || other.manifestUrl === name));
            if (isClaimedByOther) continue;
            if (!state.mediaKey) state.mediaKey = nameKey;

            if (isGenuineProgressiveMp4Url(name)) {
              state.progressiveUrl = name;
              return {
                progressiveUrl: name,
                isStream: false,
                format: 'DIRECT',
                streamKey: state.mediaKey || state.entityKey
              };
            }
            const isHls = (name.includes('.m3u8') || name.includes('/hls/')) && !name.includes('.m4s') && !name.includes('.ts');
            const isDash = (name.includes('.mpd') || name.includes('/dash/') || (name.includes('/playlist/vid/') && name.includes('manifest'))) &&
              !name.includes('.m4s') && !name.includes('.ts') && !name.includes('.init') && !name.includes('/init') && !/\/[0-9]+\/[0-9]+(?:\?|$)/.test(name);
            if (isHls) {
              if (queue) queue.registerManifest(name);
              state.hlsUrl = name;
              state.manifestUrl = name;
            } else if (!state.hlsUrl && (!state.manifestUrl || !state.manifestUrl.includes('.m3u8')) && isDash) {
              if (queue) queue.registerManifest(name);
              state.dashUrl = name;
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
      const expectedSegments = (state.duration && state.duration > 5) ? Math.ceil(state.duration / 4.5) : 15;
      const hasSubstantialSegments = state.allSegments && state.allSegments.length >= Math.max(6, Math.floor(expectedSegments * 0.85));
      if (Date.now() - startTime >= 2000 && (state.manifestUrl || hasSubstantialSegments)) {
        break;
      }

      await new Promise(r => setTimeout(r, 150));
    }

    // Return manifest if locked (prioritizing HLS)
    const finalManifest = state.hlsUrl || state.manifestUrl;
    if (finalManifest) {
      const isHls = finalManifest.includes('.m3u8') || finalManifest.includes('/hls/');
      return {
        url: finalManifest,
        manifestXml: (!isHls ? state.dashXml : '') || '',
        isStream: true,
        format: isHls ? 'HLS' : 'DASH',
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
          if (e && e.message && (e.message.includes('404') || e.message.includes('410'))) {
            throw e;
          }
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
        initBuffer: (state.initChunk && isInitBox(state.initChunk)) ? state.initChunk : null
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

      // Priority 0.5: If an authentic manifest exists, assemble full manifest stream instead of partial segments
      let resolvedManifest = state.manifestUrl;
      let resolvedXml = state.manifestXml || '';

      if (!resolvedManifest && state.mediaKey) {
        for (const mf of discoveredManifestCache) {
          if (entityKeysMatch(state.mediaKey, mf.streamKey)) {
            resolvedManifest = mf.url;
            resolvedXml = mf.text;
            state.manifestUrl = mf.url;
            state.manifestXml = mf.text;
            break;
          }
        }
      }

      if (!resolvedManifest) {
        try {
          const resEntries = performance.getEntriesByType('resource');
          for (let i = resEntries.length - 1; i >= 0; i--) {
            const name = resEntries[i].name;
            if (isNonMediaUrl(name)) continue;
            const isHls = (name.includes('.m3u8') || name.includes('/hls/')) && !name.includes('.m4s') && !name.includes('.ts');
            if (isHls) {
              const nameKey = extractStreamKey(name);
              if (nameKey && ((state.mediaKey && entityKeysMatch(state.mediaKey, nameKey)) || (state.entityKey && entityKeysMatch(state.entityKey, nameKey)))) {
                resolvedManifest = name;
                state.manifestUrl = name;
                break;
              }
            }
          }
        } catch (e) {}
      }

      if (resolvedManifest) {
        state.isDownloading = false;
        return await downloadStreamInPage(state, resolvedManifest, resolvedXml);
      }

      // Collect all candidate URLs from arguments, state.allSegments, and performance resource entries
      const candidateSet = new Set();
      if (Array.isArray(segmentUrls)) {
        for (const u of segmentUrls) if (u && typeof u === 'string') candidateSet.add(u);
      }
      if (Array.isArray(state.allSegments)) {
        for (const u of state.allSegments) if (u && typeof u === 'string') candidateSet.add(u);
      }

      try {
        const resEntries = performance.getEntriesByType('resource');
        for (let i = resEntries.length - 1; i >= 0; i--) {
          const name = resEntries[i].name;
          if (isNonMediaUrl(name)) continue;
          if (name.includes('.m4s') || name.includes('.ts') || name.includes('/segment/') || /\/[0-9]+\/[0-9]+(?:\?|$)/.test(name)) {
            let matches = (state.mediaKey && streamUrlMatchesKey(name, state.mediaKey)) ||
                          (state.entityKey && streamUrlMatchesKey(name, state.entityKey));
            if (!matches && candidateSet.size > 0) {
              for (const existingUrl of candidateSet) {
                const sampleKey = extractStreamKey(existingUrl);
                if (sampleKey && streamUrlMatchesKey(name, sampleKey)) {
                  matches = true;
                  break;
                }
              }
            }
            if (matches) candidateSet.add(name);
          }
        }
      } catch (e) {}

      const allCandidateUrls = Array.from(candidateSet);
      if (allCandidateUrls.length === 0) {
        throw new Error('No media segments available to assemble.');
      }

      // Group candidate URLs by stream representation to prevent mixing codecs/resolutions
      const repGroups = new Map();
      for (const url of allCandidateUrls) {
        // LinkedIn pattern: .../<variant>/<repId>/<seq>/<ts>?...
        const liMatch = url.match(/^(https?:\/\/[^\?#]+\/([^\/]+)\/([^\/]+))\/\d+\/\d+/i);
        const genMatch = url.match(/^(https?:\/\/[^\?#]+\/)([^\/?#]+)/i);
        const repKey = liMatch ? liMatch[1] : (genMatch ? genMatch[1] : url.split('?')[0]);
        if (!repGroups.has(repKey)) repGroups.set(repKey, []);
        repGroups.get(repKey).push(url);
      }

      // Select best representation: prefer AVC (universally playable) if present, else representation with most segments
      let chosenRepKey = null;
      let chosenUrls = [];
      for (const [key, urls] of repGroups.entries()) {
        const keyLower = key.toLowerCase();
        const isAvc = !keyLower.includes('av1') && (keyLower.includes('avc') || keyLower.includes('h264') || keyLower.includes('2mbps') || keyLower.includes('720p'));
        if (!chosenRepKey) {
          chosenRepKey = key;
          chosenUrls = urls;
        } else {
          const chosenLower = chosenRepKey.toLowerCase();
          const chosenIsAvc = !chosenLower.includes('av1') && (chosenLower.includes('avc') || chosenLower.includes('h264') || chosenLower.includes('2mbps'));
          if (isAvc && !chosenIsAvc && urls.length >= 3) {
            chosenRepKey = key;
            chosenUrls = urls;
          } else if (isAvc === chosenIsAvc && urls.length > chosenUrls.length) {
            chosenRepKey = key;
            chosenUrls = urls;
          }
        }
      }

      // Sort and deduplicate selected representation URLs by sequence index
      const seqMap = new Map();
      let initSegmentUrl = null;

      for (const u of chosenUrls) {
        const mLi = u.match(/\/(\d+)\/\d+(?:\?|$)/);
        const mGen = u.match(/(?:segment|chunk|seg)[_-]?(\d+)/i) || u.match(/\/(\d+)\.(?:m4s|ts|mp4)/i);
        const seq = mLi ? parseInt(mLi[1], 10) : (mGen ? parseInt(mGen[1], 10) : null);
        if (seq !== null) {
          if (seq === 1 && (u.includes('init') || u.includes('/1/'))) {
            initSegmentUrl = u;
          }
          if (!seqMap.has(seq)) seqMap.set(seq, u);
        } else {
          if (u.includes('init') && !initSegmentUrl) initSegmentUrl = u;
          else seqMap.set(seqMap.size + 100, u);
        }
      }

      const sortedSeqs = Array.from(seqMap.keys()).sort((a, b) => a - b);
      let urlsToDownload = sortedSeqs.map(k => seqMap.get(k));

      // Ensure init segment is at index 0
      if (initSegmentUrl && urlsToDownload[0] !== initSegmentUrl) {
        urlsToDownload = urlsToDownload.filter(u => u !== initSegmentUrl);
        urlsToDownload.unshift(initSegmentUrl);
      }

      // Check segment sequence coverage against expected presentation duration
      const segDuration = 4.0;
      const expectedMinChunks = (realDur > 10) ? Math.max(3, Math.floor(realDur / (segDuration + 0.5))) : 3;

      if (realDur > 12 && urlsToDownload.length < Math.floor(expectedMinChunks * 0.85)) {
        const curSrc = state.video ? (state.video.currentSrc || state.video.src || '') : '';
        window.dispatchEvent(new CustomEvent('__GARRETT_QUERY_REACT_STREAM__', {
          detail: { videoId: state.id, blobUrl: curSrc }
        }));
        window.dispatchEvent(new CustomEvent('__GARRETT_REQUEST_CACHED_TELEMETRY__'));
        await new Promise(r => setTimeout(r, 600));

        if (state.progressiveUrl && isGenuineProgressiveMp4Url(state.progressiveUrl)) {
          state.isDownloading = false;
          return await keepVideoNow(state);
        }

        if (state.manifestUrl) {
          state.isDownloading = false;
          return await downloadStreamInPage(state, state.manifestUrl, state.manifestXml);
        }

        if (urlsToDownload.length < Math.min(expectedMinChunks - 1, 6)) {
          showToast(`Stream buffering: Garrett has captured ${urlsToDownload.length} segments (~${Math.round(urlsToDownload.length * segDuration)}s). Please let the video play to finish buffering, then click Keep Video.`, 5500);
          if (textEl) textEl.textContent = 'Keep Video';
          state.isDownloading = false;
          return;
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
          if (e && e.message && (e.message.includes('404') || e.message.includes('410'))) {
            throw e;
          }
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

      const initBufToUse = (state.initChunk && isInitBox(state.initChunk)) ? state.initChunk : null;

      const result = await assembler.assembleSegments(urlsToDownload, 'video/mp4', 'mp4', onProgress, customFetchBuffer, {
        allowTrailingLoss: true,
        initBuffer: initBufToUse
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

    // Refresh live DOM entity keys right before download
    if (state.video && state.video.isConnected) {
      const liveInfo = extractVideoEntityInfoFromDom(state.video);
      if (liveInfo.mediaKey && (!state.mediaKey || state.mediaKey !== liveInfo.mediaKey)) {
        state.mediaKey = liveInfo.mediaKey;
      }
      if (liveInfo.activityUrn && (!state.activityUrn || state.activityUrn !== liveInfo.activityUrn)) {
        state.activityUrn = liveInfo.activityUrn;
      }
      if (liveInfo.primaryKey) state.entityKey = liveInfo.primaryKey;
    }

    // Safety guard: Clear stale progressiveUrl or manifestUrl if they don't match this video's mediaKey
    if (state.progressiveUrl && state.mediaKey) {
      const progStreamKey = extractStreamKey(state.progressiveUrl);
      if (progStreamKey && !entityKeysMatch(state.mediaKey, progStreamKey)) {
        console.warn(`[Garrett] Cleared mismatched progressiveUrl (${progStreamKey} !== ${state.mediaKey})`);
        state.progressiveUrl = null;
      }
    }
    if (state.manifestUrl && state.mediaKey) {
      const manStreamKey = extractStreamKey(state.manifestUrl);
      if (manStreamKey && !entityKeysMatch(state.mediaKey, manStreamKey)) {
        console.warn(`[Garrett] Cleared mismatched manifestUrl (${manStreamKey} !== ${state.mediaKey})`);
        state.manifestUrl = null;
        state.manifestXml = null;
      }
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
      window.dispatchEvent(new CustomEvent('__GARRETT_REQUEST_CACHED_TELEMETRY__'));
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
      let manifestUrl = state.hlsUrl || (stream && stream.format === 'HLS' ? stream.url : null) || (stream && stream.url) || state.manifestUrl;
      let manifestXml = (manifestUrl === state.dashUrl ? (stream && stream.manifestXml) || state.manifestXml : '') || '';

      // If manifest URL was not yet set, check discoveredManifestCache first, then performance resource entries
      if (!manifestUrl && state.mediaKey) {
        for (const mf of discoveredManifestCache) {
          if (entityKeysMatch(state.mediaKey, mf.streamKey)) {
            const isMfHls = mf.url.includes('.m3u8') || mf.url.includes('/hls/');
            if (isMfHls) {
              manifestUrl = mf.url;
              manifestXml = mf.text;
              state.hlsUrl = mf.url;
              state.manifestUrl = mf.url;
              break;
            } else if (!manifestUrl) {
              manifestUrl = mf.url;
              manifestXml = mf.text;
              state.dashUrl = mf.url;
              state.manifestUrl = mf.url;
            }
          }
        }
      }
      if (!manifestUrl && state.allSegments && state.allSegments.length > 0) {
        for (const seg of state.allSegments) {
          const segKey = extractStreamKey(seg);
          if (!segKey) continue;
          for (const mf of discoveredManifestCache) {
            if (entityKeysMatch(segKey, mf.streamKey)) {
              const isMfHls = mf.url.includes('.m3u8') || mf.url.includes('/hls/');
              if (isMfHls) {
                manifestUrl = mf.url;
                manifestXml = mf.text;
                state.hlsUrl = mf.url;
                state.manifestUrl = mf.url;
                if (!state.mediaKey) state.mediaKey = segKey;
                break;
              } else if (!manifestUrl) {
                manifestUrl = mf.url;
                manifestXml = mf.text;
                state.dashUrl = mf.url;
                state.manifestUrl = mf.url;
                if (!state.mediaKey) state.mediaKey = segKey;
              }
            }
          }
          if (manifestUrl && (manifestUrl.includes('.m3u8') || manifestUrl.includes('/hls/'))) break;
        }
      }

      if (!manifestUrl && state.mediaKey) {
        try {
          const resEntries = performance.getEntriesByType('resource');
          for (let i = resEntries.length - 1; i >= 0; i--) {
            const name = resEntries[i].name;
            if (isNonMediaUrl(name)) continue;
            const isHls = (name.includes('.m3u8') || name.includes('/hls/')) && !name.includes('.m4s') && !name.includes('.ts');
            const isDash = (name.includes('.mpd') || name.includes('/dash/') || (name.includes('/playlist/vid/') && name.includes('manifest'))) &&
              !name.includes('.m4s') && !name.includes('.ts') && !name.includes('.init') && !name.includes('/init') && !/\/[0-9]+\/[0-9]+(?:\?|$)/.test(name);
            if (isHls || isDash) {
              const isClaimedByOther = Array.from(videoRegistry.values()).some(other => other !== state && (other.progressiveUrl === name || other.manifestUrl === name));
              if (isClaimedByOther) continue;

              const nameKey = extractStreamKey(name);
              if (nameKey && entityKeysMatch(state.mediaKey, nameKey)) {
                if (isHls) {
                  manifestUrl = name;
                  state.hlsUrl = name;
                  state.manifestUrl = name;
                  if (queue) queue.registerManifest(name);
                  break;
                } else if (!manifestUrl && !state.hlsUrl) {
                  manifestUrl = name;
                  state.dashUrl = name;
                  state.manifestUrl = name;
                  if (queue) queue.registerManifest(name);
                }
              }
            }
          }
        } catch (e) {}
      }

      // If manifest is DASH, attempt an automated HLS probe before downloading
      if (manifestUrl && (manifestUrl.includes('.mpd') || manifestUrl.includes('/dash/')) && !state.hlsUrl) {
        try {
          const hlsProbeUrl = manifestUrl
            .replace(/\/dash\/[^\/]+\/manifest\.mpd/i, '/hls/master.m3u8')
            .replace(/\/dash\/manifest\.mpd/i, '/hls/master.m3u8');
          if (hlsProbeUrl !== manifestUrl) {
            const probeText = await customFetchText(hlsProbeUrl);
            if (probeText && probeText.includes('#EXTM3U')) {
              console.log('[Garrett] Auto-upgraded DASH manifest to complete HLS VOD playlist:', hlsProbeUrl);
              manifestUrl = hlsProbeUrl;
              manifestXml = probeText;
              state.hlsUrl = hlsProbeUrl;
              state.manifestUrl = hlsProbeUrl;
            }
          }
        } catch (probeErr) {}
      }

      if (manifestUrl) {
        try {
          await downloadStreamInPage(state, manifestUrl, manifestXml);
          return;
        } catch (streamErr) {
          console.warn('[Garrett] Manifest download failed, falling back to segment queue:', streamErr.message);
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

            const nameKey = extractStreamKey(name);
            if (!nameKey) continue;
            let matchesKey = state.mediaKey ? entityKeysMatch(state.mediaKey, nameKey) : false;
            if (!matchesKey && state.allSegments && state.allSegments.length > 0) {
              matchesKey = state.allSegments.some(s => streamUrlMatchesKey(s, nameKey));
            }
            if (!matchesKey) continue;

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
    // 1. Clean up disconnected / unmounted video elements
    for (const [v, state] of videoRegistry.entries()) {
      if (!v || !v.isConnected) {
        if (state.overlayBtn) state.overlayBtn.remove();
        videoRegistry.delete(v);
      }
    }
    // 2. Discover and register current videos in the DOM
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
  window.dispatchEvent(new CustomEvent('__GARRETT_REQUEST_CACHED_TELEMETRY__'));

  // YouTube SPA navigation listeners
  if (typeof window !== 'undefined') {
    window.addEventListener('yt-navigate-finish', () => {
      setTimeout(scanForVideos, 300);
      setTimeout(scanForVideos, 1200);
    });
    window.addEventListener('yt-player-updated', () => {
      setTimeout(scanForVideos, 300);
    });
  }

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
          mediaKey: state.mediaKey || '',
          activityUrn: state.activityUrn || '',
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
      let state = null;
      if (request.videoId) {
        state = Array.from(videoRegistry.values()).find(s => s.id === request.videoId);
      }
      if (!state && !request.videoId) {
        state = Array.from(videoRegistry.values())[0];
      }
      if (!state && request.streamUrl) {
        state = {
          id: request.videoId || `vbs-ext-${Date.now()}`,
          video: null,
          entityKey: '',
          mediaKey: extractStreamKey(request.streamUrl) || '',
          activityUrn: '',
          allKeys: new Set(),
          poster: '',
          progressiveUrl: null,
          manifestUrl: null,
          isDownloading: false,
          overlayBtn: null,
          mainBtn: null
        };
      }
      if (state) {
        if (request.progressiveUrl && (!state.mediaKey || streamUrlMatchesKey(request.progressiveUrl, state.mediaKey))) {
          state.progressiveUrl = request.progressiveUrl;
        }
        if (request.streamUrl) {
          if (isGenuineProgressiveMp4Url(request.streamUrl)) {
            if (!state.mediaKey || streamUrlMatchesKey(request.streamUrl, state.mediaKey)) {
              state.progressiveUrl = request.streamUrl;
            }
          } else if (!state.progressiveUrl && (request.streamUrl.includes('.mpd') || request.streamUrl.includes('/dash/') || request.streamUrl.includes('.m3u8'))) {
            if (!state.mediaKey || streamUrlMatchesKey(request.streamUrl, state.mediaKey)) {
              state.manifestUrl = request.streamUrl;
            }
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
      let state = null;
      if (request.videoId) {
        state = Array.from(videoRegistry.values()).find(s => s.id === request.videoId);
      }
      if (!state && !request.videoId) {
        state = Array.from(videoRegistry.values())[0];
      }
      if (state) {
        const dlUrl = state.progressiveUrl || (state.video ? (state.video.currentSrc || state.video.src || '') : '');
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
      let state = null;
      if (request.videoId) {
        state = Array.from(videoRegistry.values()).find(s => s.id === request.videoId);
      }
      if (!state && !request.videoId) {
        state = Array.from(videoRegistry.values())[0];
      }
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
      const streamUrl = request.stream.url;
      if (streamUrl) {
        const streamKey = extractStreamKey(streamUrl);
        const isHls = streamUrl.includes('.m3u8') || streamUrl.includes('/hls/');
        for (const state of videoRegistry.values()) {
          const matches = (streamKey && state.mediaKey && entityKeysMatch(state.mediaKey, streamKey)) ||
                          (streamKey && state.allKeys && Array.from(state.allKeys).some(k => entityKeysMatch(k, streamKey)));
          if (matches) {
            if (isHls) {
              state.hlsUrl = streamUrl;
              state.manifestUrl = streamUrl;
            } else {
              state.dashUrl = streamUrl;
              if (!state.hlsUrl && (!state.manifestUrl || !state.manifestUrl.includes('.m3u8'))) {
                state.manifestUrl = streamUrl;
              }
            }
          }
        }
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
      if (streamKey) {
        for (const state of videoRegistry.values()) {
          if (state.mediaKey && entityKeysMatch(state.mediaKey, streamKey)) {
            state.progressiveUrl = request.url;
          } else if (streamUrlMatchesKey(request.url, state.entityKey) || (state.allKeys && Array.from(state.allKeys).some(k => streamUrlMatchesKey(request.url, k)))) {
            state.progressiveUrl = request.url;
            if (!state.mediaKey) state.mediaKey = streamKey;
          }
        }
      }
      sendResponse({ received: true });
      return true;
    }
  });
}

})();
