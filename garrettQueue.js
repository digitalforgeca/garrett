// Garrett — Stream Keeper: Universal Stream & Segment Queue System
// Indexed primarily by blob: URL to guarantee 100% video-to-stream isolation

(function (root, factory) {
  const exportsObj = factory();
  if (typeof globalThis !== 'undefined') {
    globalThis.GarrettQueue = exportsObj;
  }
  if (typeof root !== 'undefined') {
    root.GarrettQueue = exportsObj;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = exportsObj;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function cleanEntityKey(key) {
    if (!key) return '';
    return key.replace(/^urn:li:[^:]+:/i, '').trim();
  }

  function entityKeysMatch(key1, key2) {
    if (!key1 || !key2) return false;
    const k1 = cleanEntityKey(key1);
    const k2 = cleanEntityKey(key2);
    if (k1 === k2) return true;
    if (k1.includes(k2) || k2.includes(k1)) return true;
    if (k1.length > 10 && k2.length > 10) {
      const sub1 = k1.slice(1);
      const sub2 = k2.slice(1);
      if (sub1 === sub2 || sub1.includes(sub2) || sub2.includes(sub1)) return true;
    }
    return false;
  }

  function isNonMediaUrl(url) {
    if (!url || typeof url !== 'string') return true;
    const clean = url.split('?')[0].toLowerCase();
    return (
      clean.includes('company-logo') ||
      clean.includes('profile-displayphoto') ||
      clean.includes('feedshare-shrink') ||
      clean.includes('/li/track') ||
      clean.includes('videocover') ||
      /\.(jpg|jpeg|png|webp|gif|svg|ico|css|js|woff|woff2|map)$/i.test(clean)
    );
  }

  /**
   * Extract a canonical stream identifier / entity key from any media, manifest, or poster URL.
   */
  function extractStreamKey(url) {
    if (!url || typeof url !== 'string') return '';
    if (isNonMediaUrl(url)) return '';

    try {
      // 1. LinkedIn Video: Matches /playlist/vid/
      if (url.includes('/playlist/vid/')) {
        const after = url.split('/playlist/vid/')[1].split('?')[0];
        const parts = after.split('/').filter(Boolean);
        for (const part of parts) {
          if (/^(v2|dash|mp4|hls|beta|vms|segment)$/i.test(part)) continue;
          if (/^[A-Za-z0-9_-]{8,}$/.test(part)) {
            return part;
          }
        }
      }

      // Also check digitalmediaAsset, fs_video, or video in url/query
      const urnMatch = url.match(/(?:digitalmediaAsset|fs_video|video|dms):([A-Za-z0-9_-]{8,})/i);
      if (urnMatch) return urnMatch[1];

      // 2. Twitter / X video ID
      const twMatch = url.match(/(?:ext_tw_video|amplify_video)\/(\d+)/i);
      if (twMatch) return `tw_${twMatch[1]}`;

      // 3. Reddit video ID
      const rdMatch = url.match(/v\.redd\.it\/([a-zA-Z0-9_-]+)/i);
      if (rdMatch) return `rd_${rdMatch[1]}`;

      // 4. YouTube video ID
      const ytMatch = url.match(/(?:v=|embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
      if (ytMatch) return `yt_${ytMatch[1]}`;

      // 5. Explicit segment or manifest URLs only
      const clean = url.split('?')[0].toLowerCase();
      if (clean.endsWith('.m4s') || clean.endsWith('.ts') || clean.endsWith('.mpd') || clean.endsWith('.m3u8')) {
        const parsed = new URL(url, 'https://unknown.stream');
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length > 1) segments.pop();
        return `${parsed.hostname}/${segments.join('/')}`;
      }

      return '';
    } catch {
      return '';
    }
  }

  /**
   * Extract numeric segment sequence index from URL
   */
  function extractSegmentIndex(url) {
    if (!url || typeof url !== 'string') return 0;
    // 1. LinkedIn format: /<seqNumber>/<timestamp>?
    const liSeqMatch = url.match(/\/([0-9]+)\/[0-9]+(?:\?|$)/);
    if (liSeqMatch) return parseInt(liSeqMatch[1], 10);

    // 2. Common patterns: segment_001.m4s, seg-1.ts, chunk-0005.m4s, index_0.ts
    const numMatch = url.match(/(?:segment[_-]|seg[_-]|chunk[_-]|index[_-]|frag[_-]|\/)(\d+)(?:\.|\?|$)/i);
    if (numMatch) return parseInt(numMatch[1], 10);

    return 0;
  }

  /**
   * BlobStreamRecord represents a distinct video stream indexed by its unique blob: URL.
   * This guarantees that Post A and Post B can NEVER be confused or mixed up.
   */
  class BlobStreamRecord {
    constructor(blobUrl, meta = {}) {
      this.blobUrl = blobUrl;
      this.tabId = meta.tabId || 0;
      this.videoId = meta.videoId || '';
      this.entityKey = meta.entityKey || '';
      this.duration = meta.duration || 0;
      this.width = meta.width || 0;
      this.height = meta.height || 0;
      this.poster = meta.poster || '';
      this.progressiveUrl = meta.progressiveUrl || null;
      this.manifestUrl = meta.manifestUrl || null;
      this.manifestXml = meta.manifestXml || null;
      this.format = meta.format || 'DASH';
      this.isStream = true;
      
      // Parsed representations from DASH/HLS
      this.representations = meta.representations || [];
      
      // Ordered playlist of segment URLs: sequenceIndex -> { index, url, timestamp }
      this.playlist = new Map();
      this.initSegmentUrl = meta.initSegmentUrl || null;
      
      this.status = 'active'; // 'active' | 'ready' | 'assembling' | 'completed'
      this.firstSeen = Date.now();
      this.lastActiveTime = Date.now();
    }

    addSegmentUrl(seqIndex, url) {
      if (!url) return;
      if (seqIndex === 1 || url.includes('init') || url.includes('.init')) {
        if (!this.initSegmentUrl) this.initSegmentUrl = url;
      }
      this.playlist.set(seqIndex, {
        index: seqIndex,
        url,
        timestamp: Date.now()
      });
      this.lastActiveTime = Date.now();
    }

    setManifest(url, xml = '') {
      if (url) this.manifestUrl = url;
      if (xml) {
        this.manifestXml = xml;
        this.format = xml.includes('<MPD') ? 'DASH' : (xml.includes('#EXTM3U') ? 'HLS' : this.format);
      }
      this.lastActiveTime = Date.now();
    }

    getSortedPlaylistUrls() {
      // 1. If we have parsed representations from manifest, return the top representation's full URL list
      if (this.representations && this.representations.length > 0) {
        const best = this.representations[0];
        const urls = [];
        if (best.initUrl) urls.push(best.initUrl);
        if (best.segments && best.segments.length > 0) {
          urls.push(...best.segments);
        }
        if (urls.length > 0) return urls;
      }

      // 2. Otherwise sort the captured segment playlist by sequence index
      const sorted = Array.from(this.playlist.values()).sort((a, b) => a.index - b.index);
      const urls = [];
      if (this.initSegmentUrl) urls.push(this.initSegmentUrl);
      for (const item of sorted) {
        if (!urls.includes(item.url)) {
          urls.push(item.url);
        }
      }
      return urls;
    }

    toJSON() {
      const urls = this.getSortedPlaylistUrls();
      return {
        blobUrl: this.blobUrl,
        tabId: this.tabId,
        videoId: this.videoId,
        entityKey: this.entityKey,
        duration: this.duration,
        width: this.width,
        height: this.height,
        poster: this.poster,
        progressiveUrl: this.progressiveUrl,
        manifestUrl: this.manifestUrl,
        format: this.format,
        isStream: true,
        segmentCount: Math.max(this.playlist.size, urls.length),
        playlistUrls: urls,
        firstSeen: this.firstSeen,
        lastActiveTime: this.lastActiveTime,
        status: this.status
      };
    }
  }

  /**
   * Main GarrettStreamQueue Manager
   */
  class GarrettStreamQueue {
    constructor() {
      // Primary Index: blobUrl -> BlobStreamRecord
      this.playlistsByBlob = new Map();

      // Entity Index: entityKey -> BlobStreamRecord
      this.playlistsByEntity = new Map();

      // Unattached stream items (manifests/segments captured before blob was registered)
      this.unattachedStreams = new Map(); // entityKey -> { manifestUrl, manifestXml, segments: Map, format, lastActive }

      this.storageKey = 'garrett_stream_queue_v2';
    }

    /**
     * Register a video element's blob stream.
     * Links the unique blob: URL to its DOM video entity.
     */
    registerBlobStream(blobUrl, meta = {}) {
      if (!blobUrl || !blobUrl.startsWith('blob:')) return null;

      let record = this.playlistsByBlob.get(blobUrl);
      if (!record) {
        record = new BlobStreamRecord(blobUrl, meta);
        this.playlistsByBlob.set(blobUrl, record);
      } else {
        if (meta.entityKey && !record.entityKey) record.entityKey = meta.entityKey;
        if (meta.duration && !record.duration) record.duration = meta.duration;
        if (meta.width && !record.width) record.width = meta.width;
        if (meta.height && !record.height) record.height = meta.height;
        if (meta.poster && !record.poster) record.poster = meta.poster;
        if (meta.progressiveUrl && !record.progressiveUrl) record.progressiveUrl = meta.progressiveUrl;
        if (meta.tabId && !record.tabId) record.tabId = meta.tabId;
        if (meta.videoId && !record.videoId) record.videoId = meta.videoId;
      }

      const entityKey = record.entityKey || meta.entityKey;
      if (entityKey) {
        this.playlistsByEntity.set(entityKey, record);

        // Check if any unattached stream manifest or segments were captured for this entityKey
        if (this.unattachedStreams.has(entityKey)) {
          const unattached = this.unattachedStreams.get(entityKey);
          if (unattached.manifestUrl && !record.manifestUrl) {
            record.setManifest(unattached.manifestUrl, unattached.manifestXml || '');
            if (unattached.representations) record.representations = unattached.representations;
          }
          if (unattached.progressiveUrl && !record.progressiveUrl) {
            record.progressiveUrl = unattached.progressiveUrl;
          }
          if (unattached.segments) {
            for (const [idx, segUrl] of unattached.segments.entries()) {
              record.addSegmentUrl(idx, segUrl);
            }
          }
        }
      }

      this.saveToStorage();
      return record;
    }

    /**
     * Alias for registerBlobStream accepting either meta object or mediaSourceId
     */
    registerBlobUrl(blobUrl, metaOrId = {}) {
      const meta = typeof metaOrId === 'object' && metaOrId !== null
        ? metaOrId
        : { mediaSourceId: metaOrId };
      return this.registerBlobStream(blobUrl, meta);
    }

    /**
     * Register a discovered or intercepted stream manifest
     */
    registerManifest(url, xml = '', meta = {}) {
      if (!url) return null;
      const entityKey = meta.entityKey || extractStreamKey(url);
      const format = (xml.includes('<MPD') || url.includes('dash')) ? 'DASH' : 'HLS';

      // Check if a BlobStreamRecord exists for this entityKey
      let record = entityKey ? this.playlistsByEntity.get(entityKey) : null;

      // Parse representations if XML is present
      let reps = [];
      const assembler = typeof globalThis !== 'undefined' ? globalThis.GarrettStreamAssembler : null;
      if (assembler && xml) {
        try {
          if (format === 'DASH') {
            const knownDuration = (meta && meta.duration) || (record && record.duration) || 0;
            reps = assembler.parseDashMpd(xml, url, { duration: knownDuration });
          } else if (format === 'HLS') {
            const parsed = assembler.parseM3U8(xml, url);
            if (parsed && parsed.type === 'media') {
              reps = [{
                initUrl: parsed.initUri,
                segments: parsed.segments
              }];
            }
          }
        } catch (e) {}
      }

      if (record) {
        record.setManifest(url, xml);
        if (reps && reps.length > 0) {
          record.representations = reps;
          const best = reps[0];
          if (best.initUrl) record.initSegmentUrl = best.initUrl;
          if (best.segments) {
            best.segments.forEach((segUrl, i) => record.addSegmentUrl(i + 2, segUrl));
          }
        }
      } else if (entityKey) {
        // Store in unattached streams cache
        let unattached = this.unattachedStreams.get(entityKey);
        if (!unattached) {
          unattached = {
            entityKey,
            manifestUrl: url,
            manifestXml: xml,
            format,
            representations: reps,
            segments: new Map(),
            tabId: meta.tabId || 0,
            lastActive: Date.now()
          };
          this.unattachedStreams.set(entityKey, unattached);
        } else {
          unattached.manifestUrl = url;
          if (xml) unattached.manifestXml = xml;
          if (reps && reps.length > 0) unattached.representations = reps;
        }

        if (reps && reps.length > 0 && reps[0].segments) {
          reps[0].segments.forEach((segUrl, i) => unattached.segments.set(i + 2, segUrl));
        }
      }

      this.saveToStorage();
      return record || this.unattachedStreams.get(entityKey) || null;
    }

    /**
     * Register a discovered or intercepted media segment URL
     */
    registerSegment(url, meta = {}) {
      if (!url || isNonMediaUrl(url)) return null;
      const entityKey = meta.entityKey || extractStreamKey(url);
      if (!entityKey) return null;
      const seqIndex = extractSegmentIndex(url);

      // Check if a BlobStreamRecord exists
      let record = meta.blobUrl ? this.playlistsByBlob.get(meta.blobUrl) : null;
      if (!record && entityKey) {
        record = this.playlistsByEntity.get(entityKey);
      }

      if (record) {
        record.addSegmentUrl(seqIndex, url);
      } else if (entityKey) {
        let unattached = this.unattachedStreams.get(entityKey);
        if (!unattached) {
          unattached = {
            entityKey,
            manifestUrl: null,
            format: 'SEGMENT_STREAM',
            segments: new Map(),
            tabId: meta.tabId || 0,
            lastActive: Date.now()
          };
          this.unattachedStreams.set(entityKey, unattached);
        }
        unattached.segments.set(seqIndex, url);
        unattached.lastActive = Date.now();
      }

      return record;
    }

    /**
     * Get sorted playlist of URLs for a specific blob: URL
     */
    getPlaylistForBlob(blobUrl) {
      if (!blobUrl) return null;
      let record = this.playlistsByBlob.get(blobUrl);
      if (record && !record.manifestUrl && !record.progressiveUrl) {
        // Try linking to unattached stream sorted by most recent activity
        const sortedUnattached = Array.from(this.unattachedStreams.entries())
          .sort((a, b) => (b[1].lastActive || 0) - (a[1].lastActive || 0));
        for (const [key, u] of sortedUnattached) {
          const keyMatches = record.entityKey && entityKeysMatch(record.entityKey, key);
          const singleStream = this.unattachedStreams.size === 1;
          const recent = (Date.now() - (u.lastActive || 0)) < 60000;
          if (keyMatches || singleStream || recent) {
            if (u.manifestUrl) record.setManifest(u.manifestUrl, u.manifestXml || '');
            if (u.progressiveUrl) record.progressiveUrl = u.progressiveUrl;
            if (u.representations) record.representations = u.representations;
            if (u.segments) {
              for (const [idx, segUrl] of u.segments.entries()) record.addSegmentUrl(idx, segUrl);
            }
            break;
          }
        }
      }
      return record ? record.toJSON() : null;
    }

    /**
     * Find the best matching stream record for a video element.
     * Uses deterministic hierarchy:
     * 1. Direct blobUrl match (100% isolate)
     * 2. Direct/fuzzy entityKey match
     * 3. Tab/unattached stream match (prioritizing most recently active)
     * 4. Duration-compatible stream
     */
    findStreamForVideo(videoInfo = {}) {
      const src = videoInfo.currentSrc || videoInfo.src || '';
      const entityKey = videoInfo.entityKey || extractStreamKey(videoInfo.poster || '') || '';
      const duration = videoInfo.duration || 0;
      const tabId = videoInfo.tabId || 0;

      let record = (src && this.playlistsByBlob.has(src)) ? this.playlistsByBlob.get(src) : null;

      // Tier 1: Direct blobUrl match with existing manifest or progressive URL
      if (record && (record.manifestUrl || record.progressiveUrl)) {
        return record;
      }

      // Tier 2: Entity key match across playlistsByEntity or unattachedStreams
      if (entityKey) {
        for (const [key, entRecord] of this.playlistsByEntity.entries()) {
          if (entityKeysMatch(entityKey, key)) {
            if (record && !record.manifestUrl && entRecord.manifestUrl) {
              record.setManifest(entRecord.manifestUrl, entRecord.manifestXml || '');
              if (entRecord.progressiveUrl) record.progressiveUrl = entRecord.progressiveUrl;
              return record;
            }
            return entRecord;
          }
        }
        const sortedUnattached = Array.from(this.unattachedStreams.entries())
          .sort((a, b) => (b[1].lastActive || 0) - (a[1].lastActive || 0));
        for (const [key, u] of sortedUnattached) {
          if (entityKeysMatch(entityKey, key)) {
            if (record) {
              if (u.manifestUrl) record.setManifest(u.manifestUrl, u.manifestXml || '');
              if (u.progressiveUrl) record.progressiveUrl = u.progressiveUrl;
              if (u.representations) record.representations = u.representations;
              if (u.segments) {
                for (const [idx, segUrl] of u.segments.entries()) record.addSegmentUrl(idx, segUrl);
              }
              return record;
            }
            return {
              manifestUrl: u.manifestUrl,
              manifestXml: u.manifestXml,
              progressiveUrl: u.progressiveUrl,
              isStream: true,
              format: u.format,
              streamKey: key,
              allSegments: Array.from(u.segments.values()),
              toJSON: () => ({
                blobUrl: src,
                manifestUrl: u.manifestUrl,
                progressiveUrl: u.progressiveUrl,
                format: u.format,
                isStream: true,
                playlistUrls: Array.from(u.segments.values())
              })
            };
          }
        }
      }

      // Tier 3: If record exists but is missing manifest, check if unattached stream exists for this tab or active stream
      if (this.unattachedStreams.size > 0) {
        const sortedUnattached = Array.from(this.unattachedStreams.entries())
          .sort((a, b) => (b[1].lastActive || 0) - (a[1].lastActive || 0));
        for (const [key, u] of sortedUnattached) {
          const tabMatch = tabId && u.tabId && u.tabId === tabId;
          const singleStream = this.unattachedStreams.size === 1;
          const recent = (Date.now() - (u.lastActive || 0)) < 60000;
          if (tabMatch || singleStream || recent) {
            if (record) {
              if (u.manifestUrl) record.setManifest(u.manifestUrl, u.manifestXml || '');
              if (u.progressiveUrl) record.progressiveUrl = u.progressiveUrl;
              if (u.representations) record.representations = u.representations;
              if (u.segments) {
                for (const [idx, segUrl] of u.segments.entries()) record.addSegmentUrl(idx, segUrl);
              }
              return record;
            }
            return {
              manifestUrl: u.manifestUrl,
              manifestXml: u.manifestXml,
              progressiveUrl: u.progressiveUrl,
              isStream: true,
              format: u.format,
              streamKey: key,
              allSegments: Array.from(u.segments.values()),
              toJSON: () => ({
                blobUrl: src,
                manifestUrl: u.manifestUrl,
                progressiveUrl: u.progressiveUrl,
                format: u.format,
                isStream: true,
                playlistUrls: Array.from(u.segments.values())
              })
            };
          }
        }
      }

      // Tier 4: Duration-compatible stream (only if exact match within 2 seconds)
      if (duration > 5) {
        for (const r of this.playlistsByBlob.values()) {
          if (r.duration > 0 && Math.abs(r.duration - duration) <= 2 && (r.manifestUrl || r.progressiveUrl)) {
            return r;
          }
        }
      }

      if (record) return record;
      return null;
    }

    /**
     * Get all active streams for a tab (Used by popup UI)
     */
    getStreamsForTab(tabId) {
      const results = [];
      const seenKeys = new Set();

      // 1. Add all registered blob records for this tab
      for (const record of this.playlistsByBlob.values()) {
        if (!tabId || record.tabId === tabId || record.tabId === 0) {
          results.push(record.toJSON());
          if (record.entityKey) seenKeys.add(record.entityKey);
        }
      }

      // 2. Add any unattached streams that haven't been bound to a blob yet
      // Strictly require a valid manifest, progressive stream, or at least 3 genuine segments
      for (const [key, u] of this.unattachedStreams.entries()) {
        if (!seenKeys.has(key)) {
          const hasManifest = !!u.manifestUrl;
          const hasProg = !!u.progressiveUrl;
          const hasEnoughSegments = u.segments && u.segments.size >= 3;

          if (hasManifest || hasProg || hasEnoughSegments) {
            if (!tabId || u.tabId === tabId || u.tabId === 0) {
              results.push({
                blobUrl: null,
                streamKey: key,
                entityKey: key,
                tabId: u.tabId,
                manifestUrl: u.manifestUrl,
                progressiveUrl: u.progressiveUrl,
                format: u.format,
                isStream: true,
                segmentCount: u.segments ? u.segments.size : 0,
                playlistUrls: Array.from(u.segments ? u.segments.values() : []),
                lastActiveTime: u.lastActive,
                status: 'ready'
              });
            }
          }
        }
      }

      // Sort by recency
      results.sort((a, b) => b.lastActiveTime - a.lastActiveTime);
      return results;
    }

    /**
     * Clean up any old invalid or polluted records
     */
    clearInvalidStreams() {
      for (const [key, u] of this.unattachedStreams.entries()) {
        if (!u.manifestUrl && !u.progressiveUrl && (!u.segments || u.segments.size < 3)) {
          this.unattachedStreams.delete(key);
        }
        if (key.includes('dms/image') || key.includes('company-logo') || key.includes('profile-displayphoto') || key.includes('feedshare')) {
          this.unattachedStreams.delete(key);
        }
      }
      for (const [blobUrl, rec] of this.playlistsByBlob.entries()) {
        if (rec.entityKey && (rec.entityKey.includes('dms/image') || rec.entityKey.includes('company-logo'))) {
          this.playlistsByBlob.delete(blobUrl);
        }
      }
      this.saveToStorage();
    }

    /**
     * Storage persistence: Save lightweight snapshot of streams to chrome.storage.local
     */
    async saveToStorage() {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const snapshot = [];
          for (const record of this.playlistsByBlob.values()) {
            snapshot.push(record.toJSON());
          }
          await chrome.storage.local.set({ [this.storageKey]: snapshot.slice(0, 30) });
        }
      } catch (e) {}
    }

    /**
     * Load stored streams from chrome.storage.local on startup
     */
    async loadFromStorage() {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const res = await chrome.storage.local.get(this.storageKey);
          const saved = res[this.storageKey];
          if (Array.isArray(saved)) {
            for (const item of saved) {
              if (item && item.blobUrl && !this.playlistsByBlob.has(item.blobUrl)) {
                const record = new BlobStreamRecord(item.blobUrl, item);
                if (Array.isArray(item.playlistUrls)) {
                  item.playlistUrls.forEach((url, i) => record.addSegmentUrl(i + 1, url));
                }
                this.playlistsByBlob.set(item.blobUrl, record);
                if (record.entityKey) this.playlistsByEntity.set(record.entityKey, record);
              }
            }
          }
          this.clearInvalidStreams();
        }
      } catch (e) {}
    }
  }

  // Singleton instance
  const defaultQueue = new GarrettStreamQueue();
  if (typeof chrome !== 'undefined' && chrome.storage) {
    defaultQueue.loadFromStorage().catch(() => {});
  }

  return {
    GarrettStreamQueue,
    BlobStreamRecord,
    queue: defaultQueue,
    extractStreamKey,
    extractSegmentIndex
  };
});
