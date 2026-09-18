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
      dlBtn.disabled = true;
      dlBtn.classList.add('loading');
      dlBtn.innerHTML = `
        <svg class="spinning" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="2" x2="12" y2="6"/>
          <line x1="12" y1="18" x2="12" y2="22"/>
          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/>
          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
          <line x1="2" y1="12" x2="6" y2="12"/>
          <line x1="18" y1="12" x2="22" y2="12"/>
          <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/>
          <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
        </svg>
      `;

      if (video.isNetworkFallback && video.streamUrl) {
        chrome.runtime.sendMessage({
          action: 'downloadUrl',
          url: video.streamUrl,
          filename: `video_${Date.now()}.mp4`
        });
        dlBtn.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        `;
        setTimeout(() => { dlBtn.disabled = false; }, 3000);
      } else {
        try {
          await chrome.tabs.sendMessage(tabId, {
            action: 'harvestVideo',
            videoId: video.id
          }, { frameId: video.frameId || 0 });

          dlBtn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          `;
          setTimeout(() => { dlBtn.disabled = false; }, 3000);
        } catch (err) {
          console.error('[Garrett] Download error:', err);
          dlBtn.disabled = false;
          dlBtn.classList.remove('loading');
          dlBtn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          `;
        }
      }
    });

    videoList.appendChild(card);
  }

  refreshBtn.addEventListener('click', loadData);
  loadData();
});
