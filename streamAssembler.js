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
    const rawMpdDur = (mpdDurMatch ? parseIsoDuration(mpdDurMatch[1]) : 0) ||
                      (periodDurMatch ? parseIsoDuration(periodDurMatch[1]) : 0);
    // Disregard duration if <= 5.0 (MSE initial buffer trap)
    const mpdDur = rawMpdDur > 5.0 ? rawMpdDur : 0;
    const optDur = (options && typeof options.duration === 'number' && options.duration > 5.0 && isFinite(options.duration)) ? options.duration : 0;
    const totalDurationSeconds = Math.max(mpdDur, optDur);

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
            if (totalDurationSeconds > 5 && timescaleVal > 0) {
              const maxTime = totalDurationSeconds * timescaleVal;
              const stepD = lastD > 0 ? lastD : (2 * timescaleVal);
              while (currentTime < maxTime) {
                const segRaw = expandTemplate(mediaTpl, id, bandwidth, currentNum, currentTime);
                segments.push(resolveUrl(segRaw, baseUrl));
                currentNum++;
                currentTime += stepD;
              }
            } else if (segments.length <= 4 && timescaleVal > 0) {
              // Presentation duration unknown or was <= 5s: synthesize at least 50 segments
              // assembleSegments will crawl until the first trailing 404
              const stepD = lastD > 0 ? lastD : (2 * timescaleVal);
              const targetCount = Math.max(50, segments.length + 45);
              while (segments.length < targetCount) {
                const segRaw = expandTemplate(mediaTpl, id, bandwidth, currentNum, currentTime);
                segments.push(resolveUrl(segRaw, baseUrl));
                currentNum++;
                currentTime += stepD;
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
      const result = await assembleSegments(allUrls, 'video/mp4', 'mp4', onProgress, fetchBuffer, { allowTrailingLoss: true });
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

      const isFmp4 = parsed.initUri || allUrls.some(u => u.includes('.m4s') || u.includes('.mp4'));
      const mime = isFmp4 ? 'video/mp4' : 'video/mp2t';
      const ext = isFmp4 ? 'mp4' : 'ts';

      const result = await assembleSegments(allUrls, mime, ext, onProgress, fetchBuffer, { allowTrailingLoss: true });
      return { ...result, playlist: parsed };
    }

    throw new Error('Unrecognized stream manifest format (not DASH or HLS).');
  }

  /**
   * Analyze segment URL structure to detect CDN format, sequence index, and query tokens.
   */
  function analyzeSegmentUrlPattern(url) {
    if (!url || typeof url !== 'string') return null;
    const [basePath, query] = url.split('?');
    const qStr = query ? `?${query}` : '';

    // 1. LinkedIn DASH: /segment/<repId>/<seqNumber>
    const mSeg = basePath.match(/^(.*\/segment\/[^\/]+\/)(\d+)$/i);
    if (mSeg) {
      const prefix = mSeg[1];
      const num = parseInt(mSeg[2], 10);
      return {
        type: 'segment_num',
        generateUrl: (n) => `${prefix}${n}${qStr}`,
        initUrl: `${prefix}init${qStr}`,
        currentIndex: num,
        startIndex: 0
      };
    }

    // 2. LinkedIn DASH: /<repId>/<seqNumber>/<timestamp>
    const mLi = basePath.match(/^(.*\/)([0-9]+)\/([0-9]+)$/);
    if (mLi) {
      const prefix = mLi[1];
      const seq = parseInt(mLi[2], 10);
      const ts = parseInt(mLi[3], 10);
      const isEpoch = ts > 10000000;
      const deltaTs = isEpoch ? 2000 : (seq > 0 ? Math.round(ts / seq) : 2000);
      return {
        type: 'seq_timestamp',
        generateUrl: (n) => isEpoch ? `${prefix}${n}/${ts}${qStr}` : `${prefix}${n}/${n * deltaTs}${qStr}`,
        initUrl: `${prefix}init${qStr}`,
        currentIndex: seq,
        startIndex: 0,
        deltaTs
      };
    }

    // 3. HLS TS: /<num>.ts
    const mTs = basePath.match(/^(.*\/)(\d+)\.ts$/i);
    if (mTs) {
      const prefix = mTs[1];
      const num = parseInt(mTs[2], 10);
      const pad = mTs[2].length > 1 && mTs[2].startsWith('0') ? mTs[2].length : 0;
      return {
        type: 'hls_ts',
        generateUrl: (n) => `${prefix}${pad ? String(n).padStart(pad, '0') : n}.ts${qStr}`,
        initUrl: null,
        currentIndex: num,
        startIndex: 0
      };
    }

    // 4. Fragmented MP4: chunk-stream-00001.m4s or seg-1.m4s
    const mM4s = basePath.match(/^(.*[_-])(\d+)(\.m4s)$/i);
    if (mM4s) {
      const prefix = mM4s[1];
      const numStr = mM4s[2];
      const suffix = mM4s[3];
      const pad = numStr.length > 1 && numStr.startsWith('0') ? numStr.length : 0;
      const num = parseInt(numStr, 10);
      return {
        type: 'chunk_m4s',
        generateUrl: (n) => `${prefix}${pad ? String(n).padStart(pad, '0') : n}${suffix}${qStr}`,
        initUrl: `${prefix}init${suffix}${qStr}`,
        currentIndex: num,
        startIndex: 1
      };
    }

    return null;
  }

  /**
   * Synthesizes the full sequence of segment URLs for a stream up to targetDurationSeconds.
   */
  function synthesizeSegmentUrls(sampleUrl, targetDurationSeconds = 0, options = {}) {
    if (!sampleUrl || typeof sampleUrl !== 'string') return null;

    // Cryptographic token guard:
    // On CDNs using path-bound HMAC signatures (e.g. ?t=..., ?token=..., licdn.com),
    // synthesizing arbitrary paths with the sample URL's token will ALWAYS yield HTTP 403 Forbidden.
    const isPathSignedCdn = /[?&](?:t|token|sig|signature|hmac)=/i.test(sampleUrl) || sampleUrl.includes('dms.licdn.com');
    if (isPathSignedCdn && !options.allowHmacSynthesis) {
      console.warn('[Garrett] Segment URL synthesis disabled for path-signed CDN token to prevent HTTP 403.');
      return null;
    }

    const pattern = analyzeSegmentUrlPattern(sampleUrl);
    if (!pattern) return null;

    const segDuration = options.segmentDuration || (pattern.deltaTs ? pattern.deltaTs / 1000 : 2.0);
    const safeDuration = (typeof targetDurationSeconds === 'number' && isFinite(targetDurationSeconds) && targetDurationSeconds > 5)
      ? Math.min(targetDurationSeconds, 7200)
      : 0;

    const expectedCount = safeDuration > 5
      ? Math.min(Math.max(Math.ceil(safeDuration / segDuration) + 1, 6), 600)
      : Math.min(Math.max(pattern.currentIndex + 35, 45), 120);

    const urls = [];
    if (pattern.initUrl && options.includeInit !== false) {
      urls.push(pattern.initUrl);
    }

    for (let i = pattern.startIndex; i < pattern.startIndex + expectedCount; i++) {
      urls.push(pattern.generateUrl(i));
    }

    return {
      urls,
      pattern,
      segDuration,
      initUrl: pattern.initUrl
    };
  }

  /**
   * Parallel segment downloader and memory assembler with request pacing
   */
  async function assembleSegments(allUrls, mimeType, ext, onProgress, fetchBuffer, options = {}) {
    const total = allUrls.length;
    let completed = 0;
    const buffers = new Array(total);
    // Use conservative concurrency (2-3) to avoid CDN rate limits and bot triggers
    const concurrency = Math.min(3, Math.max(1, total));
    let currentIndex = 0;
    const allowTrailingLoss = options.allowTrailingLoss !== false;
    let eofReached = false;

    async function worker() {
      while (currentIndex < total && !eofReached) {
        const idx = currentIndex++;
        if (idx >= total || eofReached) break;
        const url = allUrls[idx];
        let attempts = 0;
        let success = false;

        // Polite request pacing between segment fetches with randomized human-like jitter
        if (idx > 0) {
          const jitter = 150 + Math.floor(Math.random() * 200);
          await new Promise(r => setTimeout(r, jitter));
        }

        while (attempts < 3 && !success && !eofReached) {
          try {
            attempts++;
            buffers[idx] = await fetchBuffer(url);
            success = true;
          } catch (err) {
            const is404 = err && err.message && (err.message.includes('404') || err.message.includes('410'));
            const is403 = err && err.message && err.message.includes('403');
            // If trailing segment (past index 0) returns 404 or 403, stream reached EOF or token boundary
            if ((is404 || is403) && allowTrailingLoss && idx > 0) {
              buffers[idx] = null;
              eofReached = true;
              break;
            }
            if (attempts >= 3) {
              if (allowTrailingLoss && idx > 0) {
                console.warn(`Trailing segment ${idx + 1}/${total} not available (${err.message}), stopping stream.`);
                buffers[idx] = null;
                eofReached = true;
                break;
              }
              console.error(`Failed segment ${idx + 1}/${total} (${url}):`, err);
              throw new Error(`Failed segment ${idx + 1}/${total}: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, 400 * attempts));
          }
        }

        completed++;
        if (onProgress) {
          const pct = Math.min(99, Math.round((completed / total) * 100));
          onProgress(completed, total, pct);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    // Filter out trailing null buffers if stream reached end
    let hasStarted = false;
    const validBuffers = [];
    for (let i = 0; i < total; i++) {
      if (buffers[i]) {
        hasStarted = true;
        validBuffers.push(buffers[i]);
      } else if (hasStarted) {
        // First null after valid media segments signifies EOF
        break;
      }
    }

    function isFtypBox(buf) {
      if (!buf || buf.byteLength < 8) return false;
      try {
        const view = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, Math.min(8, buf.byteLength));
        return view.getUint8(4) === 0x66 && view.getUint8(5) === 0x74 && view.getUint8(6) === 0x79 && view.getUint8(7) === 0x70;
      } catch { return false; }
    }

    // Prepend initBuffer if the first buffer lacks an ftyp header
    if (validBuffers.length > 0 && !isFtypBox(validBuffers[0]) && options.initBuffer && isFtypBox(options.initBuffer)) {
      console.log('[Garrett] Stitching provided initSegment header into fragmented MP4 stream.');
      validBuffers.unshift(options.initBuffer);
    }

    // Leverage mux.js for MPEG-TS / HLS transmuxing
    const muxjsLib = (typeof globalThis !== 'undefined' && globalThis.muxjs) ||
                     (typeof window !== 'undefined' && window.muxjs) ||
                     (typeof self !== 'undefined' && self.muxjs);

    const isTsStream = ext === 'ts' || (mimeType && mimeType.includes('mp2t')) || (validBuffers[0] && new Uint8Array(validBuffers[0])[0] === 0x47);
    if (muxjsLib && muxjsLib.mp4 && muxjsLib.mp4.Transmuxer && isTsStream && validBuffers.length > 0) {
      try {
        console.log('[Garrett] Transmuxing MPEG-TS segments with mux.js into progressive MP4...');
        const transmuxer = new muxjsLib.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: true });
        const initChunks = [];
        const mediaChunks = [];
        transmuxer.on('data', (segment) => {
          if (segment.initSegment && segment.initSegment.byteLength > 0) initChunks.push(segment.initSegment);
          if (segment.data && segment.data.byteLength > 0) mediaChunks.push(segment.data);
        });
        for (const b of validBuffers) {
          transmuxer.push(new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer));
          transmuxer.flush();
        }
        if (mediaChunks.length > 0) {
          const muxedBlob = new Blob([...initChunks, ...mediaChunks], { type: 'video/mp4' });
          return { blob: muxedBlob, ext: 'mp4', totalBytes: muxedBlob.size, totalSegments: validBuffers.length };
        }
      } catch (transmuxErr) {
        console.warn('[Garrett] mux.js transmuxing fallback:', transmuxErr.message);
      }
    }

    // Validate fMP4 structure: Must have at least 1 init header and 1 media segment
    if (validBuffers.length === 1 && total > 1) {
      throw new Error('Incomplete stream: Only captured 1 fragment. Play more of the video before keeping.');
    }

    const blob = new Blob(validBuffers, { type: mimeType });

    if (blob.size < 32768) {
      throw new Error(`Assembled stream file is suspiciously small (${blob.size} bytes).`);
    }

    return { blob, ext, totalBytes: blob.size, totalSegments: validBuffers.length };
  }

  return {
    parseM3U8,
    parseDashMpd,
    downloadStream,
    assembleSegments,
    analyzeSegmentUrlPattern,
    synthesizeSegmentUrls
  };
});
