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
   * Parse ISO 8601 duration string (e.g. PT1M41.5S, PT36S, PT1H2M3S, P1DT2H).
   * Returns total duration in seconds.
   */
  function parseIsoDuration(str) {
    if (!str || typeof str !== 'string') return 0;
    const m = str.match(/P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/i);
    if (!m) return 0;
    const days = parseFloat(m[1] || 0);
    const hours = parseFloat(m[2] || 0);
    const minutes = parseFloat(m[3] || 0);
    const seconds = parseFloat(m[4] || 0);
    return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
  }

  /**
   * Expands MPEG-DASH template identifiers ($RepresentationID$, $Number$, $Time$, $Bandwidth$).
   */
  function expandTemplate(template, repId, bandwidth, number, time) {
    if (!template) return '';
    return template
      .replace(/\$RepresentationID\$/g, String(repId != null ? repId : ''))
      .replace(/\$Bandwidth%0(\d+)d\$/g, (_, pad) => String(bandwidth || 0).padStart(parseInt(pad, 10), '0'))
      .replace(/\$Bandwidth\$/g, String(bandwidth || ''))
      .replace(/\$Number%0(\d+)d\$/g, (_, pad) => String(number || 0).padStart(parseInt(pad, 10), '0'))
      .replace(/\$Number\$/g, String(number != null ? number : ''))
      .replace(/\$Time%0(\d+)d\$/g, (_, pad) => String(time || 0).padStart(parseInt(pad, 10), '0'))
      .replace(/\$Time\$/g, String(time != null ? time : ''))
      .replace(/\$\$/g, '$')
      .replace(/&amp;/g, '&');
  }

  /**
   * Parse an MPEG-DASH (.mpd) XML manifest.
   * Thoroughly inspects AdaptationSet and Representation elements.
   * Handles <SegmentTimeline>, <SegmentList>, and static <SegmentTemplate> structures.
   */
  function parseDashMpd(xmlText, baseUrl, options = {}) {
    const representations = [];
    if (!xmlText) return representations;

    // 1. Extract total duration from MPD or Period, or options.duration fallback
    const mpdDurMatch = xmlText.match(/\bmediaPresentationDuration=["']([^"']+)["']/i);
    const periodDurMatch = xmlText.match(/<Period\b[^>]*\bduration=["']([^"']+)["']/i);
    const totalDurationSeconds =
      (mpdDurMatch ? parseIsoDuration(mpdDurMatch[1]) : 0) ||
      (periodDurMatch ? parseIsoDuration(periodDurMatch[1]) : 0) ||
      (options && typeof options.duration === 'number' && options.duration > 0 ? options.duration : 0);

    // 2. Parse each AdaptationSet block
    const adaptRegex = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
    let adaptMatch;

    while ((adaptMatch = adaptRegex.exec(xmlText)) !== null) {
      const adaptAttrs = adaptMatch[1];
      const adaptBody = adaptMatch[2];

      const adaptContentType = getAttr(adaptAttrs, 'contentType').toLowerCase();
      const adaptMime = getAttr(adaptAttrs, 'mimeType').toLowerCase();
      const adaptCodecs = getAttr(adaptAttrs, 'codecs').toLowerCase();

      // Look for SegmentTemplate or SegmentList defined at AdaptationSet level
      const adaptTemplateMatch = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/i.exec(adaptBody);
      const adaptListMatch = /<SegmentList\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentList>)/i.exec(adaptBody);

      // Parse each Representation within this AdaptationSet (both block <Representation>...</Representation> and self-closing <Representation.../>)
      const repRegex = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/gi;
      let repMatch;

      while ((repMatch = repRegex.exec(adaptBody)) !== null) {
        const repAttrs = repMatch[1];
        const repBody = repMatch[2] || '';

        const id = getAttr(repAttrs, 'id');
        const bandwidth = parseInt(getAttr(repAttrs, 'bandwidth') || '0', 10);
        const codecs = (getAttr(repAttrs, 'codecs') || adaptCodecs).toLowerCase();
        const width = parseInt(getAttr(repAttrs, 'width') || '0', 10);
        const height = parseInt(getAttr(repAttrs, 'height') || '0', 10);
        const mimeType = (getAttr(repAttrs, 'mimeType') || adaptMime).toLowerCase();

        let initUrl = '';
        const segments = [];

        // Check 1: <SegmentList> (Representation level or AdaptationSet level)
        const initMatch = /<Initialization\b[^>]*sourceURL=["']([^"']*)["']/i.exec(repBody) ||
                          /<Initialization\b[^>]*sourceURL=["']([^"']*)["']/i.exec(adaptBody);
        if (initMatch) {
          initUrl = resolveUrl(initMatch[1].replace(/&amp;/g, '&'), baseUrl);
        }

        const segRegex = /<SegmentURL\b[^>]*media=["']([^"']*)["']/gi;
        let segMatch;
        while ((segMatch = segRegex.exec(repBody)) !== null) {
          segments.push(resolveUrl(segMatch[1].replace(/&amp;/g, '&'), baseUrl));
        }
        if (segments.length === 0 && adaptListMatch) {
          while ((segMatch = segRegex.exec(adaptBody)) !== null) {
            segments.push(resolveUrl(segMatch[1].replace(/&amp;/g, '&'), baseUrl));
          }
        }

        // Check 2: <SegmentTemplate> (Representation level or inherited from AdaptationSet)
        if (segments.length === 0) {
          const repTemplateMatch = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/i.exec(repBody);
          const tplAttrs = (repTemplateMatch ? repTemplateMatch[1] : '') + ' ' + (adaptTemplateMatch ? adaptTemplateMatch[1] : '');

          const initTpl = getAttr(tplAttrs, 'initialization');
          const mediaTpl = getAttr(tplAttrs, 'media');
          const startNum = parseInt(getAttr(tplAttrs, 'startNumber') || '1', 10);
          const durationVal = parseInt(getAttr(tplAttrs, 'duration') || '0', 10);
          const timescaleVal = parseInt(getAttr(tplAttrs, 'timescale') || '1', 10);

          if (initTpl && !initUrl) {
            const rawInit = expandTemplate(initTpl, id, bandwidth, startNum, 0);
            initUrl = resolveUrl(rawInit, baseUrl);
          }

          // Case A: <SegmentTimeline> present (primary structure for LinkedIn, DASH-IF, Shaka)
          const timelineMatch = /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i.exec(repBody) ||
                                /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i.exec(adaptBody);

          if (timelineMatch && mediaTpl) {
            const sRegex = /<S\b([^>]*?)(?:\/>|>([\s\S]*?)<\/S>)/gi;
            let sMatch;
            let currentTime = 0;
            let currentNum = startNum;
            let lastD = 0;

            while ((sMatch = sRegex.exec(timelineMatch[1])) !== null) {
              const sAttrs = sMatch[1];
              const tVal = getAttr(sAttrs, 't');
              const dVal = parseInt(getAttr(sAttrs, 'd') || '0', 10);
              const rVal = parseInt(getAttr(sAttrs, 'r') || '0', 10);

              if (tVal) {
                currentTime = parseInt(tVal, 10);
              }
              if (dVal > 0) {
                lastD = dVal;
              }

              let count = 1;
              if (rVal > 0) {
                count = rVal + 1;
              } else if (rVal < 0) {
                // r="-1" repeats until period duration
                if (dVal > 0 && totalDurationSeconds > 0 && timescaleVal > 0) {
                  const maxTime = totalDurationSeconds * timescaleVal;
                  count = (maxTime > currentTime) ? Math.ceil((maxTime - currentTime) / dVal) : 1;
                } else {
                  count = 1;
                }
              }

              for (let k = 0; k < count; k++) {
                const segRaw = expandTemplate(mediaTpl, id, bandwidth, currentNum, currentTime);
                segments.push(resolveUrl(segRaw, baseUrl));
                currentNum++;
                currentTime += dVal;
              }
            }

            // Extrapolate to full presentation duration if manifest timeline only provided initial chunks
            if (totalDurationSeconds > 0 && timescaleVal > 0 && lastD > 0) {
              const maxTime = totalDurationSeconds * timescaleVal;
              while (currentTime < maxTime) {
                const segRaw = expandTemplate(mediaTpl, id, bandwidth, currentNum, currentTime);
                segments.push(resolveUrl(segRaw, baseUrl));
                currentNum++;
                currentTime += lastD;
              }
            }
          } else if (durationVal > 0 && mediaTpl && totalDurationSeconds > 0) {
            // Case B: Static duration on <SegmentTemplate> with presentation duration
            const segDuration = durationVal / timescaleVal;
            const segCount = Math.ceil(totalDurationSeconds / segDuration);
            let currentTime = 0;
            let currentNum = startNum;

            for (let n = 0; n < segCount; n++) {
              const segRaw = expandTemplate(mediaTpl, id, bandwidth, currentNum, currentTime);
              segments.push(resolveUrl(segRaw, baseUrl));
              currentNum++;
              currentTime += durationVal;
            }
          }
        }

        if (segments.length > 0) {
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

    const videoReps = representations.filter(r => !r.hasAudio || (r.width > 0 && r.height > 0));
    const audioReps = representations.filter(r => r.hasAudio && (!r.width || r.width === 0) && (!r.height || r.height === 0));
    if (videoReps.length > 0 && audioReps.length > 0) {
      audioReps.sort((a, b) => b.bandwidth - a.bandwidth);
      videoReps[0].audioRepresentation = audioReps[0];
    }

    return representations;
  }

  /**
   * Universal Stream Downloader: Supports MPEG-DASH and HLS.
   * Downloads initialization and all media fragments in parallel and concatenates into a single MP4 Blob.
   * 
   * @param {string} manifestUrl
   * @param {function} onProgress (completed, total, pct)
   * @param {object} options { customFetchBuffer, customFetchText, manifestText, duration }
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
      const reps = parseDashMpd(text, manifestUrl, options);
      if (!reps || reps.length === 0) {
        throw new Error('No valid video representations found in DASH manifest.');
      }
      const best = reps[0];
      const allUrls = [];
      if (best.initUrl) allUrls.push(best.initUrl);
      allUrls.push(...best.segments);
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
