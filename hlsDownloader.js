// Garrett - Stream Downloader (HLS & MPEG-DASH Assembler)
import './streamAssembler.js';

export const parseM3U8 = globalThis.GarrettStreamAssembler.parseM3U8;
export const parseDashMpd = globalThis.GarrettStreamAssembler.parseDashMpd;
export const downloadStream = globalThis.GarrettStreamAssembler.downloadStream;
export const assembleSegments = globalThis.GarrettStreamAssembler.assembleSegments;

// Backward-compatibility alias
export const downloadHlsStream = downloadStream;

