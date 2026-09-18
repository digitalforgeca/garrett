// Garrett — Stream Keeper: Universal Stream Assembler (HLS & MPEG-DASH)
// Designed to run in Content Scripts (DOM), Service Workers (background), or Node.js

(function (root, factory) {
  const exportsObj = factory();
  if (typeof globalThis !== 'undefined') {
    globalThis.GarrettStreamAssembler = exportsObj;
  }
  if (typeof root !== 'undefined') {
    root.GarrettStreamAssembler = exportsObj;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = exportsObj;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /**
   * Universal URL resolver that preserves authenticated CDN query parameters
   * (e.g., ?e=...&v=beta&t=...) when resolving relative manifest segment URLs.
   */
  function resolveUrl(relativeOrAbsolute, baseUrl) {
    if (!relativeOrAbsolute) return '';
    if (!baseUrl) return relativeOrAbsolute;
    try {
      const resolved = new URL(relativeOrAbsolute, baseUrl);
      if (!resolved.search && baseUrl.includes('?')) {
        const baseObj = new URL(baseUrl);
        resolved.search = baseObj.search;
      }
      return resolved.href;
    } catch {
      return relativeOrAbsolute;
    }
  }

  /**
   * Parse an HLS (m3u8) playlist.
   */
  function parseM3U8(content, baseUrl) {
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

    // Master playlist containing multiple quality variants
    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
    if (isMaster) {
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const line = lines[i];
          const bwMatch = line.match(/BANDWIDTH=(\d+)/);
          const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          const codecsMatch = line.match(/CODECS=["']([^"']+)["']/);
          const codecs = codecsMatch ? codecsMatch[1].toLowerCase() : '';
          const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
          const width = resMatch ? parseInt(resMatch[1], 10) : 0;
          const height = resMatch ? parseInt(resMatch[2], 10) : 0;

          const uriLine = lines[i + 1];
          if (uriLine && !uriLine.startsWith('#')) {
            const uri = resolveUrl(uriLine, baseUrl);
            const isAvc = (codecs.includes('avc') || codecs.includes('h264')) && !codecs.includes('av01');
            const hasAudio = codecs.includes('mp4a') || codecs.includes('aac');
            variants.push({ uri, bw, codecs, width, height, isAvc, hasAudio });
          }
        }
      }

      // Sort variants: Prefer AVC/H.264 for universal playback compatibility, then resolution, then bandwidth
      variants.sort((a, b) => {
        if (a.isAvc !== b.isAvc) return a.isAvc ? -1 : 1;
        const resA = a.width * a.height;
        const resB = b.width * b.height;
        if (resA !== resB) return resB - resA;
        return b.bw - a.bw;
      });

      const best = variants[0];
      return { type: 'master', nextUrl: best ? best.uri : baseUrl };
    }

    // Media playlist with segment URLs
    let initUri = null;
    const segments = [];

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MAP:')) {
        const match = line.match(/URI=["']([^"']+)["']/);
        if (match) {
          initUri = resolveUrl(match[1], baseUrl);
        }
      } else if (!line.startsWith('#') && line.length > 0) {
        segments.push(resolveUrl(line, baseUrl));
      }
    }

    return {
      type: 'media',
      initUri,
      segments
    };
  }

  /**
   * Helper to extract an attribute from an XML tag string.
   */
  function getAttr(tagAttrs, name) {
    const m = new RegExp('\\b' + name + '=["\']([^"\']*)["\']', 'i').exec(tagAttrs);
    return m ? m[1] : '';
  }

  /**
   * Parse an MPEG-DASH (.mpd) XML manifest.
   * Thoroughly inspects AdaptationSet and Representation elements.
   * Handles both <SegmentList> and <SegmentTemplate> structures.
   */
  function parseDashMpd(xmlText, baseUrl) {
    const representations = [];

    // Parse each AdaptationSet block
    const adaptRegex = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let adaptMatch;

    while ((adaptMatch = adaptRegex.exec(xmlText)) !== null) {
      const adaptAttrs = adaptMatch[1];
      const adaptBody = adaptMatch[2];

      const adaptContentType = getAttr(adaptAttrs, 'contentType').toLowerCase();
      const adaptMime = getAttr(adaptAttrs, 'mimeType').toLowerCase();
      const adaptCodecs = getAttr(adaptAttrs, 'codecs').toLowerCase();

      // Look for SegmentTemplate defined at AdaptationSet level if any
      const adaptTemplateMatch = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/i.exec(adaptBody);

      // Parse each Representation within this AdaptationSet
      const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi;
      let repMatch;

      while ((repMatch = repRegex.exec(adaptBody)) !== null) {
        const repAttrs = repMatch[1];
        const repBody = repMatch[2];

        const id = getAttr(repAttrs, 'id');
        const bandwidth = parseInt(getAttr(repAttrs, 'bandwidth') || '0', 10);
        const codecs = (getAttr(repAttrs, 'codecs') || adaptCodecs).toLowerCase();
        const width = parseInt(getAttr(repAttrs, 'width') || '0', 10);
        const height = parseInt(getAttr(repAttrs, 'height') || '0', 10);
        const mimeType = (getAttr(repAttrs, 'mimeType') || adaptMime).toLowerCase();

        let initUrl = '';
        const segments = [];

        // Check 1: <SegmentList>
        const initMatch = /<Initialization\b[^>]*sourceURL=["']([^"']*)["']/i.exec(repBody);
        if (initMatch) {
          const rawInit = initMatch[1].replace(/&amp;/g, '&');
          initUrl = resolveUrl(rawInit, baseUrl);
        }

        const segRegex = /<SegmentURL\b[^>]*media=["']([^"']*)["']/gi;
        let segMatch;
        while ((segMatch = segRegex.exec(repBody)) !== null) {
          const rawSeg = segMatch[1].replace(/&amp;/g, '&');
          segments.push(resolveUrl(rawSeg, baseUrl));
        }

        // Check 2: <SegmentTemplate> inside Representation or inherited from AdaptationSet
        if (segments.length === 0) {
          const tplMatch = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/i.exec(repBody) || adaptTemplateMatch;
          if (tplMatch) {
            const tplAttrs = tplMatch[1];
            const initTpl = getAttr(tplAttrs, 'initialization');
            const mediaTpl = getAttr(tplAttrs, 'media');
            const startNum = parseInt(getAttr(tplAttrs, 'startNumber') || '1', 10);
            const durationVal = parseInt(getAttr(tplAttrs, 'duration') || '0', 10);
            const timescaleVal = parseInt(getAttr(tplAttrs, 'timescale') || '1', 10);

            if (initTpl) {
              const rawInit = initTpl.replace(/\$RepresentationID\$/g, id).replace(/&amp;/g, '&');
              initUrl = resolveUrl(rawInit, baseUrl);
            }

            // Estimate segment count from manifest mediaPresentationDuration or timeline
            const durMatch = /mediaPresentationDuration=["']PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?["']/i.exec(xmlText);
            if (durMatch && durationVal > 0) {
              const hours = parseFloat(durMatch[1] || '0');
              const minutes = parseFloat(durMatch[2] || '0');
              const seconds = parseFloat(durMatch[3] || '0');
              const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
              const segDuration = durationVal / timescaleVal;
              const segCount = Math.ceil(totalSeconds / segDuration);

              for (let n = startNum; n < startNum + segCount; n++) {
                const segRaw = mediaTpl
                  .replace(/\$RepresentationID\$/g, id)
                  .replace(/\$Number%0(\d+)d\$/g, (_, pad) => String(n).padStart(parseInt(pad, 10), '0'))
                  .replace(/\$Number\$/g, String(n))
                  .replace(/&amp;/g, '&');
                segments.push(resolveUrl(segRaw, baseUrl));
              }
            }
          }
        }

        if (initUrl && segments.length > 0) {
          // Check codec flags
          const urlLower = (initUrl + (segments[0] || '')).toLowerCase();
          const isAv1 = codecs.includes('av01') || codecs.includes('av1') || urlLower.includes('av1');
          const isAvc = (codecs.includes('avc1') || codecs.includes('h264') || urlLower.includes('hls-2mbps') || urlLower.includes('hls-720p')) && !isAv1;
          const hasAudio = codecs.includes('mp4a') || codecs.includes('aac') || adaptContentType.includes('audio') || mimeType.includes('audio');

          representations.push({
            id,
            bandwidth,
            codecs,
            width,
            height,
            initUrl,
            segments,
            isAvc,
            isAv1,
            hasAudio
          });
        }
      }
    }

    // Rank representations:
    // Tier 1: AVC (H.264) with multiplexed audio (universally compatible, zero extra muxing required)
    // Tier 2: AVC (H.264) video
    // Tier 3: Other codecs with audio
    // Tier 4: Other codecs
    // Within tier: highest resolution (width * height), then highest bandwidth
    representations.sort((a, b) => {
      const getTier = (r) => {
        if (r.isAvc && r.hasAudio) return 4;
        if (r.isAvc) return 3;
        if (r.hasAudio) return 2;
        return 1;
      };

      const tierA = getTier(a);
      const tierB = getTier(b);
      if (tierA !== tierB) return tierB - tierA;

      const resA = a.width * a.height;
      const resB = b.width * b.height;
      if (resA !== resB) return resB - resA;

      return b.bandwidth - a.bandwidth;
    });

    return representations;
  }

  /**
   * Universal Stream Downloader: Supports MPEG-DASH and HLS.
   * Downloads initialization and all media fragments in parallel and concatenates into a single MP4 Blob.
   * 
   * @param {string} manifestUrl
   * @param {function} onProgress (completed, total, pct)
   * @param {object} options { customFetchBuffer, customFetchText }
   */
  async function downloadStream(manifestUrl, onProgress, options = {}) {
    const fetchText = options.customFetchText || (async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    });

    const fetchBuffer = options.customFetchBuffer || (async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });

    const text = options.manifestText || await fetchText(manifestUrl);

    // 1. DASH Manifest (.mpd or /dash/)
    if (text.includes('<MPD') || manifestUrl.includes('/dash/') || manifestUrl.includes('.mpd')) {
      const reps = parseDashMpd(text, manifestUrl);
      if (!reps || reps.length === 0) {
        throw new Error('No valid video representations found in DASH manifest.');
      }
      const best = reps[0];
      const allUrls = [best.initUrl, ...best.segments];
      const result = await assembleSegments(allUrls, 'video/mp4', 'mp4', onProgress, fetchBuffer);
      return { ...result, representation: best };
    }

    // 2. HLS Playlist (.m3u8)
    if (text.includes('#EXTM3U') || manifestUrl.includes('.m3u8')) {
      let parsed = parseM3U8(text, manifestUrl);

      if (parsed.type === 'master' && parsed.nextUrl) {
        const nextText = await fetchText(parsed.nextUrl);
        parsed = parseM3U8(nextText, parsed.nextUrl);
      }

      if (parsed.type !== 'media' || parsed.segments.length === 0) {
        throw new Error('No video segments found in HLS playlist.');
      }

      const allUrls = [];
      if (parsed.initUri) {
        allUrls.push(parsed.initUri);
      }
      allUrls.push(...parsed.segments);

      const isMp4 = parsed.initUri || allUrls[0].includes('.m4s') || allUrls[0].includes('.mp4');
      const mimeType = isMp4 ? 'video/mp4' : 'video/mp2t';
      const ext = isMp4 ? 'mp4' : 'ts';
      return assembleSegments(allUrls, mimeType, ext, onProgress, fetchBuffer);
    }

    throw new Error('Unrecognized stream manifest format (not DASH or HLS).');
  }

  /**
   * Parallel segment downloader and memory assembler
   */
  async function assembleSegments(allUrls, mimeType, ext, onProgress, fetchBuffer) {
    const total = allUrls.length;
    let completed = 0;
    const buffers = new Array(total);
    const concurrency = Math.min(6, total);
    let currentIndex = 0;

    async function worker() {
      while (currentIndex < total) {
        const idx = currentIndex++;
        const url = allUrls[idx];
        let attempts = 0;
        let success = false;

        while (attempts < 3 && !success) {
          try {
            attempts++;
            buffers[idx] = await fetchBuffer(url);
            success = true;
          } catch (err) {
            if (attempts >= 3) {
              console.error(`Failed segment ${idx + 1}/${total} (${url}):`, err);
              throw new Error(`Failed segment ${idx + 1}/${total}: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, 400 * attempts));
          }
        }

        completed++;
        if (onProgress) {
          const pct = Math.round((completed / total) * 100);
          onProgress(completed, total, pct);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    const blob = new Blob(buffers, { type: mimeType });

    if (blob.size < 32768) {
      throw new Error(`Assembled stream file is suspiciously small (${blob.size} bytes).`);
    }

    return { blob, ext, totalBytes: blob.size, totalSegments: total };
  }

  return {
    parseM3U8,
    parseDashMpd,
    downloadStream,
    assembleSegments
  };
});
