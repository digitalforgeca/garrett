// Garrett — Stream Keeper: Background Service Worker
// Synchronous import of engine libraries
importScripts('streamAssembler.js', 'garrettQueue.js', 'keeper.js');

const queue = globalThis.GarrettQueue.queue;
const { extractStreamKey, extractSegmentIndex } = globalThis.GarrettQueue;

// Map of tabId -> Map of videoId -> VideoData (DOM detected)
const domVideosByTab = new Map();

function sanitizeFilename(name) {
  return name.replace(/[/\\?%*:|"<>]/g, '-').trim().substring(0, 120);
}

function updateBadgeForTab(tabId) {
  if (!tabId || tabId < 0) return;
  const domCount = domVideosByTab.has(tabId) ? domVideosByTab.get(tabId).size : 0;
  const netStreams = queue.getStreamsForTab(tabId);
  const total = Math.max(domCount, netStreams.length);

  if (total > 0) {
    chrome.action.setBadgeText({ text: String(total), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#D4AF37', tabId }); // Keeper Gold
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

// Clean up when tab is updated or closed
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    domVideosByTab.delete(tabId);
    updateBadgeForTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  domVideosByTab.delete(tabId);
});

function isNonMediaUrl(url, contentType = '') {
  if (!url || typeof url !== 'string') return true;
  const clean = url.split('?')[0].toLowerCase();
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('text/') ||
    contentType.includes('javascript') ||
    contentType.includes('json') ||
    clean.includes('/dms/image/') ||
    clean.includes('company-logo') ||
    clean.includes('profile-displayphoto') ||
    clean.includes('feedshare-shrink') ||
    clean.includes('videocover') ||
    clean.includes('/li/track') ||
    /\.(jpg|jpeg|png|webp|gif|svg|ico|css|js|woff|woff2|map)$/i.test(clean)
  );
}

// Sniff video requests across all tabs
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const url = details.url;
    const cleanUrl = url.split('?')[0].toLowerCase();

    let contentType = '';
    let contentDisposition = '';
    let contentLength = 0;

    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = h.name.toLowerCase();
        if (name === 'content-type' && h.value) contentType = h.value.toLowerCase();
        if (name === 'content-disposition' && h.value) contentDisposition = h.value.toLowerCase();
        if (name === 'content-length' && h.value) contentLength = parseInt(h.value, 10) || 0;
      }
    }

    // 0. QUICK REJECT: Non-media assets (images, styles, scripts, fonts, analytics)
    if (isNonMediaUrl(url, contentType)) return;

    // 1. FIRST: Detect Stream Manifests (MPEG-DASH or HLS)
    const isDash =
      contentType.includes('dash+xml') ||
      cleanUrl.endsWith('.mpd') ||
      cleanUrl.includes('.mpd') ||
      cleanUrl.endsWith('/dash') ||
      (cleanUrl.includes('playlist.mpd'));

    const isHls =
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      cleanUrl.endsWith('.m3u8') ||
      cleanUrl.includes('.m3u8');

    if (isDash || isHls) {
      const record = queue.registerManifest(url, '', {
        tabId: details.tabId,
        format: isDash ? 'DASH' : 'HLS',
        contentType
      });

      updateBadgeForTab(details.tabId);

      chrome.tabs.sendMessage(details.tabId, {
        action: 'streamDiscovered',
        stream: record ? (record.toJSON ? record.toJSON() : record) : { url, format: isDash ? 'DASH' : 'HLS', isStream: true }
      }).catch(() => {});
      return;
    }

    // 2. Detect Media Segments and Init Boxes
    const isSegmentOrInit =
      contentType.includes('iso.segment') ||
      contentType.includes('video/mp4') ||
      contentType.includes('video/mp2t') ||
      contentType.includes('audio/mp4') ||
      contentDisposition.includes('filename="init') ||
      contentDisposition.includes('output_hls') ||
      cleanUrl.endsWith('.m4s') ||
      cleanUrl.endsWith('.ts') ||
      cleanUrl.endsWith('.init') ||
      cleanUrl.includes('init.mp4') ||
      (url.includes('/playlist/vid/') && /\/[0-9]+\/[0-9]+(\?|$)/.test(url));

    if (isSegmentOrInit) {
      const record = queue.registerSegment(url, {
        tabId: details.tabId,
        byteLength: contentLength
      });

      if (record) {
        chrome.tabs.sendMessage(details.tabId, {
          action: 'segmentDiscovered',
          url,
          streamKey: record.entityKey || record.streamKey
        }).catch(() => {});
      }
      return;
    }

    // 3. Detect Progressive MP4 Streams
    const isProgressiveMp4 =
      (cleanUrl.includes('/playlist/vid/v2/') || cleanUrl.includes('/playlist/vid/')) &&
      !cleanUrl.includes('/dash/') &&
      !cleanUrl.includes('/hls/') &&
      !cleanUrl.endsWith('.m4s') &&
      !cleanUrl.endsWith('.ts') &&
      !cleanUrl.endsWith('.init') &&
      !cleanUrl.endsWith('/init') &&
      !cleanUrl.endsWith('.mpd') &&
      !cleanUrl.endsWith('.m3u8') &&
      !/\/[0-9]+\/[0-9]+$/.test(cleanUrl) &&
      !cleanUrl.includes('videocover');

    if (isProgressiveMp4) {
      updateBadgeForTab(details.tabId);
      chrome.tabs.sendMessage(details.tabId, {
        action: 'progressiveDiscovered',
        url
      }).catch(() => {});
      return;
    }

    // 4. Detect Direct Standalone Video Files (Full MP4 / WebM files)
    const isDirectVideo =
      (contentType.startsWith('video/') && contentLength > 65536) ||
      ((cleanUrl.endsWith('.mp4') || cleanUrl.endsWith('.webm') || cleanUrl.endsWith('.m4v')) && contentLength > 65536);

    if (isDirectVideo) {
      updateBadgeForTab(details.tabId);

      chrome.tabs.sendMessage(details.tabId, {
        action: 'streamDiscovered',
        stream: {
          url,
          type: 'Direct MP4 Video',
          format: 'DIRECT',
          isStream: false,
          isHls: false,
          timestamp: Date.now()
        }
      }).catch(() => {});
      return;
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : message.tabId;

  // Register Video Element from DOM
  if (message.action === 'registerVideo') {
    if (tabId) {
      if (!domVideosByTab.has(tabId)) {
        domVideosByTab.set(tabId, new Map());
      }
      domVideosByTab.get(tabId).set(message.video.id, {
        ...message.video,
        frameId: sender.frameId || 0
      });

      // If video has blobUrl, register directly in queue indexed by blob
      if (message.video.src && message.video.src.startsWith('blob:')) {
        queue.registerBlobStream(message.video.src, {
          tabId,
          videoId: message.video.id,
          entityKey: message.video.entityKey,
          duration: message.video.duration,
          width: message.video.width,
          height: message.video.height,
          poster: message.video.poster
        });
      }

      updateBadgeForTab(tabId);
    }
    sendResponse({ success: true });
    return true;
  }

  // Register Blob Stream
  if (message.action === 'registerBlobStream') {
    if (message.record && message.record.blobUrl) {
      queue.registerBlobStream(message.record.blobUrl, {
        tabId: tabId || message.tabId,
        ...message.record
      });
      if (tabId) updateBadgeForTab(tabId);
    }
    sendResponse({ success: true });
    return true;
  }

  // Get Sorted Playlist of URLs for a specific blobUrl
  if (message.action === 'getPlaylistForBlob') {
    const playlist = queue.getPlaylistForBlob(message.blobUrl);
    sendResponse({ success: true, playlist });
    return true;
  }

  if (message.action === 'unregisterVideo') {
    if (tabId && domVideosByTab.has(tabId)) {
      domVideosByTab.get(tabId).delete(message.videoId);
      updateBadgeForTab(tabId);
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'registerManifest') {
    const record = queue.registerManifest(message.url, message.content || '', {
      tabId: tabId || message.tabId,
      entityKey: message.entityKey
    });
    if (tabId) updateBadgeForTab(tabId);
    sendResponse({ success: true, stream: record ? (record.toJSON ? record.toJSON() : record) : null });
    return true;
  }

  if (message.action === 'registerSegment') {
    const record = queue.registerSegment(message.url, {
      tabId: tabId || message.tabId,
      blobUrl: message.blobUrl,
      entityKey: message.entityKey
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'getStreamsForTab') {
    const targetTabId = tabId || message.tabId;
    const streams = queue.getStreamsForTab(targetTabId);
    sendResponse({ streams });
    return true;
  }

  if (message.action === 'getStreamForVideo') {
    const stream = queue.findStreamForVideo(message.videoInfo);
    sendResponse({ success: true, stream: stream ? (stream.toJSON ? stream.toJSON() : stream) : null });
    return true;
  }

  // Comprehensive media listing for popup UI
  if (message.action === 'getVideosForTab') {
    const targetTabId = message.tabId;
    const domList = [];
    if (domVideosByTab.has(targetTabId)) {
      domVideosByTab.get(targetTabId).forEach((v) => domList.push(v));
    }

    const netList = queue.getStreamsForTab(targetTabId);

    sendResponse({
      domVideos: domList,
      networkStreams: netList
    });
    return true;
  }

  if (message.action === 'downloadUrl') {
    const filename = sanitizeFilename(message.filename || `video_${Date.now()}.mp4`);
    chrome.downloads.download({
      url: message.url,
      filename: filename,
      saveAs: message.saveAs ?? false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Download error:', chrome.runtime.lastError.message);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }

  if (message.action === 'fetchText') {
    fetch(message.url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => sendResponse({ success: true, text }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'fetchBuffer') {
    fetch(message.url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunkSz = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSz) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSz));
        }
        sendResponse({ success: true, data: btoa(binary) });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
