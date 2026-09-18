// Garrett - Popup Controller
const downloadHlsStream = (globalThis.GarrettStreamAssembler && globalThis.GarrettStreamAssembler.downloadStream) || null;
const getRandomKeeperQuote = (globalThis.GarrettKeeper && globalThis.GarrettKeeper.getRandomKeeperQuote) || (() => ({ quote: "What is merely watched is soon forgotten. What is taken is kept.", source: "Keeper Annuary, Ch. VII" }));

document.addEventListener('DOMContentLoaded', () => {
  const statusBar = document.getElementById('status-bar');
  const networkSection = document.getElementById('network-section');
  const networkList = document.getElementById('network-list');
  const domSection = document.getElementById('dom-section');
  const domList = document.getElementById('dom-list');
  const emptyState = document.getElementById('empty-state');
  const refreshBtn = document.getElementById('refresh-btn');

  function formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function ensureContentScriptInjected(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    } catch {
      try {
        await chrome.scripting.insertCSS({
          target: { tabId, allFrames: true },
          files: ['content.css']
        });
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ['keeper.js', 'streamAssembler.js', 'garrettQueue.js', 'content.js']
        });
      } catch (err) {
        console.warn('Could not inject content script:', err);
      }
    }
  }

  async function loadData() {
    statusBar.textContent = 'Scanning active tab for media...';
    networkSection.style.display = 'none';
    domSection.style.display = 'none';
    emptyState.style.display = 'none';
    networkList.innerHTML = '';
    domList.innerHTML = '';

    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      statusBar.textContent = 'No active tab found.';
      emptyState.style.display = 'block';
      return;
    }

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('brave://') || tab.url.startsWith('about:')) {
      statusBar.textContent = 'Extensions cannot run on internal browser pages.';
      emptyState.style.display = 'block';
      return;
    }

    await ensureContentScriptInjected(tab.id);

    let domVideos = [];
    try {
      const tabResp = await chrome.tabs.sendMessage(tab.id, { action: 'scanAndGetVideos' });
      if (tabResp && tabResp.videos) {
        domVideos = tabResp.videos;
      }
    } catch (e) {}

    // Query background service worker for all detected media on this tab
    chrome.runtime.sendMessage({ action: 'getVideosForTab', tabId: tab.id }, (response) => {
      const netStreams = (response && response.networkStreams) || [];
      const bgDom = (response && response.domVideos) || [];
      if (domVideos.length === 0 && bgDom.length > 0) {
        domVideos = bgDom;
      }

      const totalCount = domVideos.length + netStreams.length;

      if (totalCount === 0) {
        statusBar.textContent = '0 videos detected yet.';
        emptyState.style.display = 'block';
      } else {
        statusBar.textContent = `Found ${totalCount} media source${totalCount > 1 ? 's' : ''}:`;
        emptyState.style.display = 'none';

        if (netStreams && netStreams.length > 0) {
          renderNetworkStreams(netStreams);
        }
        if (domVideos && domVideos.length > 0) {
          renderDomVideos(domVideos, tab.id);
        }
      }
    });
  }

  function renderNetworkStreams(streams) {
    networkSection.style.display = 'block';
    networkList.innerHTML = '';

    streams.forEach((stream, index) => {
      const card = document.createElement('div');
      card.className = 'stream-card';

      const displayUrl = stream.blobUrl || stream.url || stream.streamKey || '';
      const shortUrl = displayUrl.length > 45 ? displayUrl.substring(0, 45) + '...' : displayUrl;
      const isStream = stream.isStream ?? stream.isHls ?? true;
      const formatLabel = stream.format || (stream.isHls ? 'HLS' : 'DASH');
      const playlistUrls = stream.playlistUrls || (stream.segments ? stream.segments.map(s => s.url) : []);
      const segCount = stream.segmentCount || playlistUrls.length;

      card.innerHTML = `
        <div class="stream-card-header">
          <span class="stream-title">Stream #${index + 1} (${formatLabel})</span>
          <span class="card-badge ${stream.manifestUrl ? 'badge-blob' : 'badge-mp4'}">${stream.manifestUrl ? 'Manifest Ready' : 'Segment Queue'}</span>
        </div>
        <div class="video-meta">
          <div style="grid-column: span 3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            Index: <span>${shortUrl}</span>
          </div>
          ${segCount > 0 ? `<div>Queued: <span>${segCount} segments</span></div>` : ''}
          ${stream.duration ? `<div>Duration: <span>${formatTime(stream.duration)}</span></div>` : ''}
        </div>
        <div class="stream-actions">
          ${isStream ? `
            <button class="btn btn-hls hls-dl-btn">
              ⚡ Fast Download Full Video (${formatLabel})
            </button>
          ` : `
            <button class="btn btn-primary stream-dl-btn">
              ⚡ Download Video File (MP4)
            </button>
          `}
        </div>
      `;

      // Direct MP4 Download
      const directBtn = card.querySelector('.stream-dl-btn');
      if (directBtn) {
        directBtn.addEventListener('click', () => {
          chrome.runtime.sendMessage({
            action: 'downloadUrl',
            url: stream.url,
            filename: `video_${Date.now()}.mp4`
          });
          window.close();
        });
      }

      // Fast HLS/DASH Segment Assembler Download
      const hlsBtn = card.querySelector('.hls-dl-btn');
      if (hlsBtn) {
        hlsBtn.addEventListener('click', async () => {
          const actionContainer = card.querySelector('.stream-actions');
          actionContainer.innerHTML = `
            <div class="hls-progress-container">
              <div class="hls-progress-header">
                <span>Downloading chunks in parallel...</span>
                <b class="hls-pct">0%</b>
              </div>
              <div class="hls-progress-track">
                <div class="hls-progress-fill"></div>
              </div>
            </div>
          `;

          const pctEl = actionContainer.querySelector('.hls-pct');
          const fillEl = actionContainer.querySelector('.hls-progress-fill');

          try {
            const customFetchText = async (u) => {
              try {
                const r = await fetch(u);
                if (r.ok) return await r.text();
                throw new Error(`HTTP ${r.status}`);
              } catch (e) {
                const bg = await chrome.runtime.sendMessage({ action: 'fetchText', url: u });
                if (bg && bg.success && bg.text) return bg.text;
                throw e;
              }
            };

            const customFetchBuffer = async (u) => {
              try {
                const r = await fetch(u);
                if (r.ok) return await r.arrayBuffer();
                throw new Error(`HTTP ${r.status}`);
              } catch (e) {
                const bg = await chrome.runtime.sendMessage({ action: 'fetchBuffer', url: u });
                if (bg && bg.success && bg.data) {
                  const bin = atob(bg.data);
                  const buf = new Uint8Array(bin.length);
                  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
                  return buf.buffer;
                }
                throw e;
              }
            };

            let result;
            const assembler = globalThis.GarrettStreamAssembler;
            const manifestUrl = stream.manifestUrl || stream.url;

            if (manifestUrl && (manifestUrl.includes('.mpd') || manifestUrl.includes('/dash/') || manifestUrl.includes('.m3u8'))) {
              result = await assembler.downloadStream(manifestUrl, (completed, total) => {
                const percent = Math.round((completed / total) * 100);
                pctEl.textContent = `${percent}% (${completed}/${total})`;
                fillEl.style.width = `${percent}%`;
              }, { manifestText: stream.manifestXml, customFetchText, customFetchBuffer });
            } else if (playlistUrls && playlistUrls.length > 0) {
              result = await assembler.assembleSegments(playlistUrls, 'video/mp4', 'mp4', (completed, total) => {
                const percent = Math.round((completed / total) * 100);
                pctEl.textContent = `${percent}% (${completed}/${total})`;
                fillEl.style.width = `${percent}%`;
              }, customFetchBuffer);
            } else {
              throw new Error('Stream manifest not yet cached. Play the video for a second to cache the playlist.');
            }

            actionContainer.innerHTML = `
              <div style="color: #34d399; font-size: 11px; font-weight: 600; text-align: center; padding: 4px;">
                🎉 Assembled ${formatBytes(result.totalBytes)}! Saving file...
              </div>
            `;

            // Trigger download via object URL in popup DOM
            const url = URL.createObjectURL(result.blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `stream_${Date.now()}.${result.ext}`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
              a.remove();
              URL.revokeObjectURL(url);
            }, 30000);

          } catch (err) {
            console.error('HLS download error:', err);
            actionContainer.innerHTML = `
              <div style="color: #f87171; font-size: 10px; padding: 4px;">
                ⚠️ HLS assembly error: ${err.message}
              </div>
            `;
          }
        });
      }

      networkList.appendChild(card);
    });
  }

  function renderDomVideos(videos, tabId) {
    domSection.style.display = 'block';
    domList.innerHTML = '';

    videos.forEach((video, index) => {
      const card = document.createElement('div');
      card.className = 'video-card';

      const typeLabel = video.isBlob
        ? (video.isDirectBlob ? 'Direct File Blob' : 'MediaSource Stream')
        : (video.src ? 'Direct URL' : 'Embedded Player');
      const badgeClass = video.isBlob ? 'badge-blob' : 'badge-mp4';
      const res = (video.width && video.height) ? `${video.width}x${video.height}` : 'Auto';
      const dur = formatTime(video.duration);

      card.innerHTML = `
        <div class="video-card-header">
          <span class="video-title">Video Player #${index + 1}</span>
          <span class="card-badge ${badgeClass}">${typeLabel}</span>
        </div>
        <div class="video-meta">
          <div>Res: <span>${res}</span></div>
          <div>Duration: <span>${dur}</span></div>
          <div>Muted: <span>${video.muted ? 'Yes 🔇' : 'No 🔊'}</span></div>
        </div>
        <div class="card-actions">
          ${(!video.isBlob || video.isDirectBlob) && video.src ? `
            <button class="btn btn-primary direct-btn" data-id="${video.id}" data-frame="${video.frameId || 0}">
              ⚡ Direct Download (MP4)
            </button>
          ` : ''}

          <button class="btn btn-hls harvest-btn" data-id="${video.id}" data-frame="${video.frameId || 0}">
            🗝️ Keep Video (Full Stream)
          </button>
        </div>
      `;

      const directBtn = card.querySelector('.direct-btn');
      if (directBtn) {
        directBtn.addEventListener('click', () => {
          chrome.tabs.sendMessage(tabId, {
            action: 'directDownload',
            videoId: video.id
          }, { frameId: video.frameId || 0 });
          window.close();
        });
      }

      const harvestBtn = card.querySelector('.harvest-btn');
      if (harvestBtn) {
        harvestBtn.addEventListener('click', () => {
          chrome.tabs.sendMessage(tabId, {
            action: 'harvestVideo',
            videoId: video.id
          }, { frameId: video.frameId || 0 });
          window.close();
        });
      }

      domList.appendChild(card);
    });
  }

  // Keeper Lore Quote Cycling
  const keeperBox = document.getElementById('keeper-box');
  const quoteEl = document.getElementById('k-quote');
  const sourceEl = document.getElementById('k-source');

  function updateKeeperQuote() {
    if (quoteEl && sourceEl) {
      const q = getRandomKeeperQuote();
      quoteEl.textContent = `"${q.quote}"`;
      sourceEl.textContent = `— ${q.source}`;
    }
  }

  if (keeperBox) {
    keeperBox.addEventListener('click', updateKeeperQuote);
  }
  updateKeeperQuote();

  refreshBtn.addEventListener('click', loadData);
  loadData();
});
