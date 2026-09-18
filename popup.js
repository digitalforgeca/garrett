// Garrett — Video Keeper: Popup Controller
document.addEventListener('DOMContentLoaded', () => {
  const statusBar = document.getElementById('status-bar');
  const videoList = document.getElementById('video-list');
  const emptyState = document.getElementById('empty-state');
  const refreshBtn = document.getElementById('refresh-btn');

  function formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return '';
    const totalSecs = Math.floor(seconds);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hours > 0) {
      return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

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
        console.warn('[Garrett] Script injection check:', err);
      }
    }
  }

  async function loadData() {
    statusBar.innerHTML = '<span>Scanning page for videos...</span>';
    emptyState.style.display = 'none';
    videoList.innerHTML = '';

    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      statusBar.innerHTML = '<span>No active tab found</span>';
      emptyState.style.display = 'block';
      return;
    }

    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('brave://') || tab.url.startsWith('about:') || tab.url.startsWith('edge://'))) {
      statusBar.innerHTML = '<span>Extensions cannot run on internal browser pages</span>';
      emptyState.style.display = 'block';
      return;
    }

    await ensureContentScriptInjected(tab.id);

    let domVideos = [];
    try {
      const tabResp = await chrome.tabs.sendMessage(tab.id, { action: 'scanAndGetVideos' });
      if (tabResp && Array.isArray(tabResp.videos)) {
        domVideos = tabResp.videos;
      }
    } catch (e) {}

    chrome.runtime.sendMessage({ action: 'getVideosForTab', tabId: tab.id }, (response) => {
      const bgDom = (response && response.domVideos) || [];
      const netStreams = (response && response.networkStreams) || [];

      // Consolidate DOM video items
      let videos = domVideos.length > 0 ? domVideos : bgDom;

      // If no DOM videos detected yet, check for network streams (standalone media)
      if (videos.length === 0 && netStreams.length > 0) {
        videos = netStreams.map((ns, idx) => ({
          id: ns.streamKey || `stream_${idx}`,
          src: ns.url || ns.blobUrl || '',
          duration: ns.duration || 0,
          width: ns.width || 0,
          height: ns.height || 0,
          muted: false,
          format: ns.format || (ns.isHls ? 'HLS' : 'DASH'),
          streamUrl: ns.manifestUrl || ns.url || ns.blobUrl || '',
          entityKey: ns.entityKey || ns.streamKey,
          isNetworkFallback: true
        }));
      }

      if (videos.length === 0) {
        statusBar.innerHTML = '<span>0 videos detected</span>';
        emptyState.style.display = 'block';
        return;
      }

      statusBar.innerHTML = `<span>${videos.length} video${videos.length > 1 ? 's' : ''} detected</span>`;
      emptyState.style.display = 'none';

      videos.forEach((vid, idx) => {
        const matchedStream = netStreams.find(s =>
          (vid.entityKey && (s.entityKey === vid.entityKey || s.streamKey === vid.entityKey)) ||
          (vid.src && (s.blobUrl === vid.src || s.url === vid.src))
        );
        renderVideoCard(vid, idx, matchedStream, tab.id);
      });
    });
  }

  function renderVideoCard(video, index, matchedStream, tabId) {
    const card = document.createElement('div');
    card.className = 'video-card';

    const durationText = formatTime(video.duration);
    const resText = (video.width && video.height) ? `${video.width}x${video.height}` : '';
    const audioText = video.muted ? 'Audio: No' : 'Audio: Yes';

    const streamFormat = video.format ||
      (matchedStream ? (matchedStream.format || (matchedStream.isHls ? 'HLS' : 'DASH')) : (video.isBlob ? 'DASH' : 'MP4'));
    const streamUrl = (matchedStream && (matchedStream.manifestUrl || matchedStream.url || matchedStream.blobUrl)) ||
      video.streamUrl || video.src || '';
    const streamKey = video.entityKey || (matchedStream && (matchedStream.entityKey || matchedStream.streamKey)) || '';

    // Build meta chips
    const metaParts = [];
    if (durationText) metaParts.push(`<span class="meta-item">${durationText}</span>`);
    if (resText) metaParts.push(`<span class="meta-item">${resText}</span>`);
    metaParts.push(`<span class="meta-item">${audioText}</span>`);

    card.innerHTML = `
      <div class="video-card-top">
        <div class="video-info">
          <div class="video-title-row">
            <span class="video-title">Video ${index + 1}</span>
          </div>
          <div class="video-meta-inline">
            ${metaParts.join('<span class="meta-dot">·</span>')}
          </div>
        </div>
        <div class="video-actions">
          <button class="action-icon-btn inspect-btn" title="Inspect stream details">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
          <button class="action-icon-btn download-btn" title="Download video">
            <svg class="dl-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="stream-details-drawer" style="display: none;">
        <div class="drawer-field">
          <span class="drawer-label">Format</span>
          <span class="drawer-val drawer-badge">${streamFormat}</span>
        </div>
        <div class="drawer-field">
          <span class="drawer-label">Stream URL</span>
          <div class="drawer-url-box">
            <span class="drawer-val drawer-url" title="${streamUrl}">${streamUrl || 'Pending stream lock...'}</span>
            ${streamUrl ? `
              <button class="copy-url-btn" title="Copy URL">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
            ` : ''}
          </div>
        </div>
        ${streamKey ? `
        <div class="drawer-field">
          <span class="drawer-label">URN / Key</span>
          <span class="drawer-val drawer-key">${streamKey}</span>
        </div>` : ''}
      </div>
    `;

    // Toggle drawer on inspect button click
    const inspectBtn = card.querySelector('.inspect-btn');
    const drawer = card.querySelector('.stream-details-drawer');
    inspectBtn.addEventListener('click', () => {
      const isOpen = drawer.style.display !== 'none';
      drawer.style.display = isOpen ? 'none' : 'flex';
      inspectBtn.classList.toggle('active', !isOpen);
    });

    // Copy URL button
    const copyBtn = card.querySelector('.copy-url-btn');
    if (copyBtn && streamUrl) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(streamUrl);
        copyBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        `;
        setTimeout(() => {
          copyBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          `;
        }, 1500);
      });
    }

    // Download action
    const dlBtn = card.querySelector('.download-btn');
    dlBtn.addEventListener('click', async () => {
      if (dlBtn.disabled) return;
      dlBtn.disabled = true;
      dlBtn.classList.add('loading');

      const updateDlStatus = (text, isSpinning = true) => {
        dlBtn.innerHTML = `
          <div style="display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; color: #38bdf8;">
            ${isSpinning ? `<svg class="spinning" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="2" x2="12" y2="6"/>
              <line x1="12" y1="18" x2="12" y2="22"/>
              <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/>
              <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
              <line x1="2" y1="12" x2="6" y2="12"/>
              <line x1="18" y1="12" x2="22" y2="12"/>
              <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/>
              <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
            </svg>` : ''}
            <span>${text}</span>
          </div>
        `;
      };

      const showSuccess = () => {
        dlBtn.classList.remove('loading');
        dlBtn.disabled = false;
        dlBtn.title = 'Saved!';
        dlBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        `;
      };

      const showError = (errMsg) => {
        console.error('[Garrett] Download error:', errMsg);
        dlBtn.disabled = false;
        dlBtn.classList.remove('loading');
        dlBtn.title = errMsg || 'Download error';
        dlBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        `;
        setTimeout(() => {
          dlBtn.title = 'Download video';
          dlBtn.innerHTML = `
            <svg class="dl-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          `;
        }, 3500);
      };

      updateDlStatus('0%');

      // Listen for progress messages from content script
      const progressListener = (msg) => {
        if (msg.action === 'streamProgress' && (msg.videoId === video.id || !msg.videoId)) {
          updateDlStatus(`${msg.pct}%`);
        }
        if (msg.action === 'streamCompleted' && (msg.videoId === video.id || !msg.videoId)) {
          showSuccess();
          chrome.runtime.onMessage.removeListener(progressListener);
        }
      };
      chrome.runtime.onMessage.addListener(progressListener);

      // 1. Try delegating to content script if available
      let tabSuccess = false;
      if (!video.isNetworkFallback && tabId) {
        try {
          const tabResp = await chrome.tabs.sendMessage(tabId, {
            action: 'harvestVideo',
            videoId: video.id,
            streamUrl: streamUrl,
            format: streamFormat,
            manifestXml: matchedStream?.manifestXml
          }, { frameId: video.frameId || 0 });

          if (tabResp && tabResp.success) {
            tabSuccess = true;
            showSuccess();
            chrome.runtime.onMessage.removeListener(progressListener);
            return;
          }
        } catch (e) {
          console.warn('[Garrett] Tab harvest response:', e);
        }
      }

      // 2. Direct Assembler in Popup (runs if tab didn't finish or fallback)
      if (!tabSuccess) {
        try {
          const assembler = globalThis.GarrettStreamAssembler;
          const targetUrl = streamUrl || (matchedStream && (matchedStream.manifestUrl || matchedStream.url)) || video.streamUrl || video.src;

          if (!targetUrl || targetUrl.startsWith('blob:')) {
            showError('Stream buffering: Play 2s of video first');
            chrome.runtime.onMessage.removeListener(progressListener);
            return;
          }

          // Direct Progressive MP4
          if (targetUrl.endsWith('.mp4') || targetUrl.includes('/mp4-') || targetUrl.includes('mp4_')) {
            updateDlStatus('Saving...', true);
            chrome.runtime.sendMessage({
              action: 'downloadUrl',
              url: targetUrl,
              filename: `video_${Date.now()}.mp4`
            }, (resp) => {
              if (resp && resp.success) showSuccess();
              else showError((resp && resp.error) || 'Download failed');
            });
            chrome.runtime.onMessage.removeListener(progressListener);
            return;
          }

          // DASH or HLS Manifest
          if (targetUrl.includes('.mpd') || targetUrl.includes('/dash/') || targetUrl.includes('.m3u8')) {
            updateDlStatus('0%');
            const result = await assembler.downloadStream(targetUrl, (completed, total, pct) => {
              updateDlStatus(`${pct}%`);
            }, {
              manifestText: matchedStream?.manifestXml,
              customFetchText,
              customFetchBuffer
            });

            updateDlStatus('Saving...', true);
            const blobUrl = URL.createObjectURL(result.blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = blobUrl;
            a.download = `video_${Date.now()}.${result.ext || 'mp4'}`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
              a.remove();
              URL.revokeObjectURL(blobUrl);
            }, 30000);

            showSuccess();
            chrome.runtime.onMessage.removeListener(progressListener);
            return;
          }

          showError('Unrecognized stream format');
        } catch (err) {
          showError(err.message);
        } finally {
          chrome.runtime.onMessage.removeListener(progressListener);
        }
      }
    });

    videoList.appendChild(card);
  }

  refreshBtn.addEventListener('click', loadData);
  loadData();
});
