// png-squeeze-01 entry: re-encode each stored screenshot PNG losslessly in as few bytes as possible.
// Strategy: decode to RGBA, reduce the colour type when the pixels allow it (palette with per-entry
// alpha, grey, grey+alpha, RGB with a tRNS key, RGBA), try several per-row filter heuristics for
// each form, screen every candidate with zlib level 6, and write the winner deflated at level 9.
// Deterministic: the same input always yields the same bytes (no clock, no randomness).
import { deflateSync, inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- PNG writing ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdr(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  return d; // compression, filter, interlace stay 0
}

function buildPng(width, height, form, idat) {
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', ihdr(width, height, form.colourType))];
  if (form.plte) parts.push(chunk('PLTE', form.plte));
  if (form.trns) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- PNG reading (to RGBA) ----------

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      header = { width: view.getUint32(at - 12 - len + 8), height: view.getUint32(at - 12 - len + 12), depth: data[8], colourType: data[9], interlace: data[12] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!header || header.depth !== 8 || header.interlace !== 0) throw new Error('unsupported PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  // Unfilter.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    } else throw new Error('bad filter type');
  }
  // Expand to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns ? (trns[1] << 16) | (trns[3] << 8) | trns[5] : -1;
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns ? trns[1] : -1;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns && e < trns.length ? trns[e] : 255;
    }
    void entries;
  }
  return { width, height, rgba };
}

// ---------- Image analysis and forms ----------

function pixelKey(rgba, d) {
  return rgba[d] + rgba[d + 1] * 256 + rgba[d + 2] * 65536 + rgba[d + 3] * 16777216;
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const k = pixelKey(rgba, d);
      const c = counts.get(k);
      if (c === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(k, 1);
      } else counts.set(k, c + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [];
    for (const [k, count] of counts) {
      colours.push({ key: k, r: k & 0xff, g: (k >>> 8) & 0xff, b: (k >>> 16) & 0xff, a: (k >>> 24) & 0xff, count });
    }
  }
  return { opaque, grey, colours };
}

// The single fully transparent value that can be keyed with tRNS, or -1.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -1;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return -1;
  }
  if (key === -1) return -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -1;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty; // transparent entries first, so tRNS stays short
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.key - y.key;
    return y.count - x.count || x.key - y.key;
  });
  const index = new Map(entries.map((c, i) => [c.key, i]));
  const plte = new Uint8Array(entries.length * 3);
  let lastTransparent = -1;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) lastTransparent = i;
  });
  const trns = lastTransparent < 0 ? null : Uint8Array.from(entries.slice(0, lastTransparent + 1), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) indices[i] = index.get(pixelKey(rgba, d));
  return { colourType: 3, bpp: 1, samples: indices, plte, trns, order };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms; // palette holds a non-grey image in far fewer bytes than RGB/RGBA
  }
  const key = opaque ? -1 : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key >= 0 ? 0 : 4;
    if (key >= 0) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key >= 0 ? 2 : 6;
    if (key >= 0) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  forms.push({ colourType: ct, bpp: CHANNELS[ct], samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

// ---------- Filtering ----------

function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// c * log2(c) for the entropy heuristic (stride is at most 1280 * 4).
const CLOG = (() => {
  const t = new Float64Array(8193);
  for (let c = 2; c < t.length; c++) t[c] = c * Math.log2(c);
  return t;
})();

function entropyCost(row, hist) {
  hist.fill(0);
  for (let i = 0; i < row.length; i++) hist[row[i]]++;
  let s = 0;
  for (let b = 0; b < 256; b++) if (hist[b] > 1) s += CLOG[hist[b]];
  return -s; // lower (more negative) = lower entropy = better
}

function pairsCost(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// choice: a fixed filter 0..4, or 'minsum' | 'pairs' | 'entropy' (per-row heuristic, lowest type on a tie).
function filteredStream(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const hist = new Uint32Array(256);
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRowInto(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trials[t]);
      const cost = choice === 'minsum' ? signedSum(trials[t]) : choice === 'pairs' ? pairsCost(trials[t], seen, ++stamp) : entropyCost(trials[t], hist);
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trials[type], at + 1);
  }
  return raw;
}

// Brute-force per-row filter choice: each row's five filtered forms are deflated (level 4) after the
// 16 KiB of already-chosen output, and the smallest is kept. Deterministic work, bounded by image size.
const BRUTE_CONTEXT = 16384;
const BRUTE_LEVEL = 4;

function bruteFilteredStream(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = new Uint8Array(stride + 1);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[0] = t;
      filterRowInto(t, cur, prev, bpp, trial.subarray(1));
      const cost = deflateSync(trial, before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    filterRowInto(type, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

// ---------- Optimal-parse deflate (for large streams) ----------
// A zopfli-style encoder: hash-chain match finding, a greedy parse for first Huffman costs, then
// shortest-path (dynamic programming) parses under those costs, re-estimating the Huffman tables
// between rounds. The result is split into blocks with their own Huffman tables. The stream is
// verified by inflating it back; on any mismatch the caller falls back to zlib's stream, and the
// caller only ever keeps this stream when it is smaller than zlib's best.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenCodeOf(len) {
  if (len === 258) return 285;
  let c = 0;
  while (c < 28 && LEN_BASE[c + 1] <= len) c++;
  return 257 + c;
}

function distCodeOf(d) {
  let c = 0;
  while (c < 29 && DIST_BASE[c + 1] <= d) c++;
  return c;
}

// Length-limited Huffman code lengths by package-merge (0 frequency -> 0 length).
function huffmanLengths(freq, maxBits) {
  const lengths = new Uint8Array(freq.length);
  const symbols = [];
  for (let i = 0; i < freq.length; i++) if (freq[i] > 0) symbols.push(i);
  if (symbols.length === 0) return lengths;
  if (symbols.length === 1) {
    lengths[symbols[0]] = 1;
    return lengths;
  }
  const leaves = symbols.map((s) => ({ w: freq[s], syms: [s] })).sort((a, b) => a.w - b.w);
  let list = leaves;
  for (let iter = 1; iter < maxBits; iter++) {
    const packaged = [];
    for (let i = 0; i + 1 < list.length; i += 2) packaged.push({ w: list[i].w + list[i + 1].w, syms: list[i].syms.concat(list[i + 1].syms) });
    const merged = [];
    let a = 0;
    let b = 0;
    while (a < packaged.length || b < leaves.length) {
      if (b >= leaves.length || (a < packaged.length && packaged[a].w <= leaves[b].w)) merged.push(packaged[a++]);
      else merged.push(leaves[b++]);
    }
    list = merged;
  }
  const take = 2 * symbols.length - 2;
  for (let i = 0; i < Math.min(take, list.length); i++) for (const s of list[i].syms) lengths[s]++;
  return lengths;
}

function canonicalCodes(lengths) {
  let maxBits = 0;
  for (const l of lengths) if (l > maxBits) maxBits = l;
  const blCount = new Uint32Array(maxBits + 1);
  for (const l of lengths) if (l) blCount[l]++;
  const next = new Uint32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) {
    code = (code + blCount[b - 1]) << 1;
    next[b] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) codes[i] = next[lengths[i]]++;
  return codes;
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

function adler32Of(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const DEFL_HASH_SIZE = 32768;
const DEFL_MAX_CHAIN = 40;

function findMatches(data) {
  const n = data.length;
  const mLen = new Uint16Array(n);
  const mDist = new Uint16Array(n);
  const head = new Int32Array(DEFL_HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  for (let i = 0; i + 2 < n; i++) {
    const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (DEFL_HASH_SIZE - 1);
    let cand = head[h];
    let bestLen = 0;
    let bestDist = 0;
    let tries = 0;
    const maxLen = Math.min(258, n - i);
    while (cand >= 0 && i - cand <= 32768 && tries < DEFL_MAX_CHAIN) {
      if (data[cand + bestLen] === data[i + bestLen] && data[cand] === data[i]) {
        let l = 0;
        while (l < maxLen && data[cand + l] === data[i + l]) l++;
        if (l > bestLen) {
          bestLen = l;
          bestDist = i - cand;
          if (l >= maxLen) break;
        }
      }
      cand = prev[cand];
      tries++;
    }
    if (bestLen >= 3) {
      mLen[i] = bestLen;
      mDist[i] = bestDist;
    }
    prev[i] = head[h];
    head[h] = i;
  }
  return { mLen, mDist };
}

function greedyParse(data, mLen, mDist) {
  const ops = [];
  let i = 0;
  while (i < data.length) {
    if (mLen[i] >= 3) {
      ops.push({ len: mLen[i], dist: mDist[i] });
      i += mLen[i];
    } else {
      ops.push({ lit: data[i] });
      i++;
    }
  }
  return ops;
}

const LEN_STEPS = [];
for (let l = 3; l <= 32; l++) LEN_STEPS.push(l);
for (const l of [40, 48, 64, 80, 96, 128, 160, 192, 224, 258]) LEN_STEPS.push(l);
const LEN_STEP_SET = new Set(LEN_STEPS);

function optimalParse(data, mLen, mDist, litBits, distBits) {
  const n = data.length;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const s = lenCodeOf(l);
    lenCost[l] = litBits[s] + LEN_EXTRA[s - 257];
  }
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const c = distCodeOf(d);
    distCost[d] = distBits[c] + DIST_EXTRA[c];
  }
  const cost = new Float64Array(n + 1).fill(Infinity);
  const prevPos = new Int32Array(n + 1).fill(-1);
  const edgeLen = new Uint16Array(n + 1);
  const edgeDist = new Uint16Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci === Infinity) continue;
    const lc = ci + litBits[data[i]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      prevPos[i + 1] = i;
      edgeLen[i + 1] = 0;
    }
    const ml = mLen[i];
    if (ml >= 3) {
      const dc = distCost[mDist[i]];
      for (const l of LEN_STEPS) {
        if (l > ml) break;
        const c = ci + lenCost[l] + dc;
        if (c < cost[i + l]) {
          cost[i + l] = c;
          prevPos[i + l] = i;
          edgeLen[i + l] = l;
          edgeDist[i + l] = mDist[i];
        }
      }
      if (ml > 32 && !LEN_STEP_SET.has(ml)) {
        const c = ci + lenCost[ml] + dc;
        if (c < cost[i + ml]) {
          cost[i + ml] = c;
          prevPos[i + ml] = i;
          edgeLen[i + ml] = ml;
          edgeDist[i + ml] = mDist[i];
        }
      }
    }
  }
  const ops = [];
  let j = n;
  while (j > 0) {
    const i = prevPos[j];
    if (edgeLen[j] === 0) ops.push({ lit: data[i] });
    else ops.push({ len: edgeLen[j], dist: edgeDist[j] });
    j = i;
  }
  ops.reverse();
  return ops;
}

function countOps(ops) {
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(32);
  for (const op of ops) {
    if (op.lit !== undefined) litFreq[op.lit]++;
    else {
      litFreq[lenCodeOf(op.len)]++;
      distFreq[distCodeOf(op.dist)]++;
    }
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitDeflateBlock(bw, ops, litLens, distLens, isFinal) {
  let hlit = 288;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 32;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const allLens = [];
  for (let i = 0; i < hlit; i++) allLens.push(litLens[i]);
  for (let i = 0; i < hdist; i++) allLens.push(distLens[i]);
  const rle = [];
  let i = 0;
  while (i < allLens.length) {
    const v = allLens[i];
    let run = 1;
    while (i + run < allLens.length && allLens[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        rle.push({ sym: 18, extra: take - 11, extraBits: 7 });
        left -= take;
      }
      if (left >= 3) {
        rle.push({ sym: 17, extra: left - 3, extraBits: 3 });
        left = 0;
      }
      while (left-- > 0) rle.push({ sym: 0, extra: 0, extraBits: 0 });
    } else {
      rle.push({ sym: v, extra: 0, extraBits: 0 });
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        rle.push({ sym: 16, extra: take - 3, extraBits: 2 });
        left -= take;
      }
      while (left-- > 0) rle.push({ sym: v, extra: 0, extraBits: 0 });
    }
    i += run;
  }
  const clenFreq = new Float64Array(19);
  for (const r of rle) clenFreq[r.sym]++;
  const clenLens = huffmanLengths(clenFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clenLens[CLEN_ORDER[hclen - 1]] === 0) hclen--;
  bw.bits(isFinal ? 1 : 0, 1);
  bw.bits(2, 2); // dynamic Huffman block
  bw.bits(hlit - 257, 5);
  bw.bits(hdist - 1, 5);
  bw.bits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.bits(clenLens[CLEN_ORDER[k]], 3);
  const clenCodes = canonicalCodes(clenLens);
  for (const r of rle) {
    bw.bits(reverseBits(clenCodes[r.sym], clenLens[r.sym]), clenLens[r.sym]);
    if (r.extraBits) bw.bits(r.extra, r.extraBits);
  }
  const litCodes = canonicalCodes(litLens);
  const distCodes = canonicalCodes(distLens);
  for (const op of ops) {
    if (op.lit !== undefined) {
      bw.bits(reverseBits(litCodes[op.lit], litLens[op.lit]), litLens[op.lit]);
    } else {
      const s = lenCodeOf(op.len);
      bw.bits(reverseBits(litCodes[s], litLens[s]), litLens[s]);
      const eb = LEN_EXTRA[s - 257];
      if (eb) bw.bits(op.len - LEN_BASE[s - 257], eb);
      const dc = distCodeOf(op.dist);
      bw.bits(reverseBits(distCodes[dc], distLens[dc]), distLens[dc]);
      const db = DIST_EXTRA[dc];
      if (db) bw.bits(op.dist - DIST_BASE[dc], db);
    }
  }
  bw.bits(reverseBits(litCodes[256], litLens[256]), litLens[256]);
}

function deflateOptimal(data) {
  const { mLen, mDist } = findMatches(data);
  let ops = greedyParse(data, mLen, mDist);
  for (let iter = 0; iter < 2; iter++) {
    const { litFreq, distFreq } = countOps(ops);
    const litLens = huffmanLengths(litFreq, 15);
    const distLens = huffmanLengths(distFreq, 15);
    const litBits = Float64Array.from(litLens, (l) => (l === 0 ? 16 : l));
    const distBits = Float64Array.from(distLens, (l) => (l === 0 ? 16 : l));
    ops = optimalParse(data, mLen, mDist, litBits, distBits);
  }
  const blocks = [];
  let cur = [];
  let curBytes = 0;
  for (const op of ops) {
    cur.push(op);
    curBytes += op.lit !== undefined ? 1 : op.len;
    if (curBytes >= 131072) {
      blocks.push(cur);
      cur = [];
      curBytes = 0;
    }
  }
  if (cur.length) blocks.push(cur);
  const bw = { bytes: [], buf: 0, nbits: 0,
    bits(value, count) {
      this.buf |= value << this.nbits;
      this.nbits += count;
      while (this.nbits >= 8) {
        this.bytes.push(this.buf & 0xff);
        this.buf >>>= 8;
        this.nbits -= 8;
      }
    } };
  blocks.forEach((bops, bi) => {
    const { litFreq, distFreq } = countOps(bops);
    emitDeflateBlock(bw, bops, huffmanLengths(litFreq, 15), huffmanLengths(distFreq, 15), bi === blocks.length - 1);
  });
  if (bw.nbits > 0) bw.bytes.push(bw.buf & 0xff);
  const raw = Uint8Array.from(bw.bytes);
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(raw, 2);
  new DataView(out.buffer).setUint32(2 + raw.length, adler32Of(data));
  const back = inflateSync(out);
  if (back.length !== data.length) throw new Error('deflate self-check length');
  for (let i = 0; i < data.length; i++) if (back[i] !== data[i]) throw new Error('deflate self-check bytes');
  return out;
}

// ---------- Screening and final deflate ----------

const SCREEN = { level: 6, memLevel: 8, strategy: 0 };
// The best zlib setting varies by image, so the finalists are tried under each and the smallest kept.
const FINAL_SETTINGS = [
  { level: 9, memLevel: 8, strategy: 0 },
  { level: 9, memLevel: 9, strategy: 1 }, // Z_FILTERED
];

function chunkBytes(form) {
  return (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
}

const FILTER_CHOICES = [0, 1, 2, 3, 4, 'minsum', 'pairs', 'entropy'];

function squeeze(rgba, width, height) {
  const candidates = [];
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytes(form);
    for (const choice of FILTER_CHOICES) {
      const data = filteredStream(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      candidates.push({ form, data, zlib, bytes: zlib.length + chunks });
    }
    if (form.order !== 'count') {
      const bruteData = bruteFilteredStream(form.samples, width, height, form.bpp);
      const bruteZlib = deflateSync(bruteData, SCREEN);
      candidates.push({ form, data: bruteData, zlib: bruteZlib, bytes: bruteZlib.length + chunks });
    }
  }
  candidates.sort((a, b) => a.bytes - b.bytes);
  // Finalists: the two best screened candidates, each under every final setting; smallest file wins.
  // Large streams also go through the optimal-parse deflate (self-checked; kept only when smaller).
  let best = null;
  for (const [rank, cand] of candidates.slice(0, 2).entries()) {
    const chunks = chunkBytes(cand.form);
    let idat = cand.zlib;
    for (const setting of FINAL_SETTINGS) {
      const out = deflateSync(cand.data, setting);
      if (out.length < idat.length) idat = out;
    }
    if (rank === 0 && cand.data.length >= 2000000) {
      try {
        const out = deflateOptimal(cand.data);
        if (out.length < idat.length) idat = out;
      } catch {
        // zlib's stream stands.
      }
    }
    const bytes = idat.length + chunks;
    if (best === null || bytes < best.bytes) best = { form: cand.form, idat, bytes };
  }
  return buildPng(width, height, best.form, new Uint8Array(best.idat.buffer, best.idat.byteOffset, best.idat.length));
}

// ---------- Main ----------

for (const id of readdirSync(IN).sort()) {
  const src = join(IN, id, 'image.png');
  if (!existsSync(src)) continue;
  const image = decodePng(new Uint8Array(readFileSync(src)));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
