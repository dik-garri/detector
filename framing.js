// Framing analysis: prepares what the classifier actually sees.
//
// Two measured problems with feeding a raw file straight to the model:
//
//   1. Padding flips it. An AI image filling 95% of the frame scored 100%
//      artificial; the same image with a uniform border at 60% scored 0.01%.
//      Border colour is irrelevant, and real photos are pushed to "authentic"
//      too, so uniform matting has to be cropped away before scoring.
//
//   2. On composite frames (a screenshot of an app window, say) the model is
//      chaotic rather than merely biased — shaving 2px off every edge moved one
//      screenshot from 24% to 59%, and 20px took it to 98%. A single forward
//      pass on such an image is a coin flip, so callers score a set of jittered
//      crops and take the median.
//
// Clean, unpadded photos and renders are unaffected: they score identically
// across every crop in the set (measured spread 0.0%).

const DIFF_THRESHOLD = 18;   // luma distance from the corner colour that counts as content
const MAX_SAMPLE = 1400;     // border detection runs on a downscaled copy for speed
const MIN_SIDE = 64;         // below this there is no border worth trimming
const KEEP_RATIO = 0.92;     // above this share of the frame, cropping is not worth it
const MAX_CROP_SIDE = 1024;  // crops are downscaled to this before encoding
const OFFSETS = [0, 8, 18, 30, 45, 62, 82];  // px shaved off every edge per sample

// Full-screen captures on common displays and phones. Matching one of these is a
// strong screenshot tell even when no uniform border survives.
const SCREEN_SIZES = [
  [1280, 800], [1440, 900], [1680, 1050], [1920, 1080], [1920, 1200],
  [2048, 1280], [2560, 1440], [2560, 1600], [2880, 1800], [3024, 1964],
  [3456, 2234], [3840, 2160], [5120, 2880], [1366, 768], [1600, 900],
  [1170, 2532], [1179, 2556], [1284, 2778], [1290, 2796], [1242, 2688],
  [1125, 2436], [750, 1334], [828, 1792], [2048, 1536], [2388, 1668],
  [2732, 2048], [2360, 1640],
];

/**
 * Locates the content box inside a uniform border.
 * Returns null when there is no border worth removing.
 */
export function trimUniformBorder(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (w < MIN_SIDE || h < MIN_SIDE) return null;

  const scale = Math.min(1, MAX_SAMPLE / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));

  const probe = document.createElement('canvas');
  probe.width = sw;
  probe.height = sh;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(img, 0, 0, sw, sh);

  let data;
  try {
    data = pctx.getImageData(0, 0, sw, sh).data;
  } catch {
    return null; // tainted canvas — leave the image alone
  }

  const bg = [data[0], data[1], data[2]];
  let minX = sw, minY = sh, maxX = -1, maxY = -1;

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const d = 0.299 * Math.abs(data[i] - bg[0]) +
                0.587 * Math.abs(data[i + 1] - bg[1]) +
                0.114 * Math.abs(data[i + 2] - bg[2]);
      if (d > DIFF_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // frame is entirely one colour

  const box = {
    x: Math.floor(minX / scale),
    y: Math.floor(minY / scale),
    w: Math.min(w, Math.ceil((maxX - minX + 1) / scale)),
    h: Math.min(h, Math.ceil((maxY - minY + 1) / scale)),
  };
  if (box.w < MIN_SIDE || box.h < MIN_SIDE) return null;

  const areaRatio = (box.w * box.h) / (w * h);
  if (areaRatio > KEEP_RATIO) return null;

  return { box, areaRatio, frame: { w, h } };
}

/**
 * Builds the set of jittered crops to score, inside the trimmed region when
 * there is one. Returns PNG data URLs, or an empty array for tiny images.
 */
export function buildCropSet(img, trim) {
  const base = trim
    ? trim.box
    : { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  const urls = [];

  for (const n of OFFSETS) {
    const cw = base.w - 2 * n, ch = base.h - 2 * n;
    if (cw < MIN_SIDE || ch < MIN_SIDE) break;

    const scale = Math.min(1, MAX_CROP_SIDE / Math.max(cw, ch));
    const ow = Math.max(1, Math.round(cw * scale));
    const oh = Math.max(1, Math.round(ch * scale));

    const canvas = document.createElement('canvas');
    canvas.width = ow;
    canvas.height = oh;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, base.x + n, base.y + n, cw, ch, 0, 0, ow, oh);
    urls.push(canvas.toDataURL('image/png'));
  }
  return urls;
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const PROBE_SIDE = 400;
const FLAT_MIN = 0.08;   // a photo's most common exact colour sits near 0%, a render near 3%
const FLAT_MAX = 0.90;   // above this the image is essentially blank, not a screenshot

/**
 * Share of pixels holding the single most common exact colour, sampled without
 * smoothing so UI fills stay exact. Interface chrome repeats flat colours;
 * photographs and renders almost never do.
 */
function flatFillShare(img, box) {
  const region = box || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  const scale = Math.min(1, PROBE_SIDE / Math.max(region.w, region.h));
  const pw = Math.max(1, Math.round(region.w * scale));
  const ph = Math.max(1, Math.round(region.h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, pw, ph);

  let data;
  try {
    data = ctx.getImageData(0, 0, pw, ph).data;
  } catch {
    return 0;
  }

  const counts = new Map();
  let top = 0;
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > top) top = n;
  }
  return top / (pw * ph);
}

/**
 * Heuristic screenshot test. A screenshot is re-rendered from pixels, so it
 * cannot carry the provenance metadata of the image it depicts — the absence of
 * generator metadata in one means nothing at all.
 *
 * Returns 'screen-size', 'ui-composite', or null. The flat-fill test runs on the
 * trimmed core so that a merely letterboxed picture is not called a screenshot.
 */
export function looksLikeScreenshot({ img, width, height, hasCameraExif, hasMetadata, trim }) {
  if (hasCameraExif || hasMetadata) return null;
  const matchesScreen = SCREEN_SIZES.some(([a, b]) =>
    (a === width && b === height) || (a === height && b === width));
  if (matchesScreen) return 'screen-size';
  if (!img) return null;
  const flat = flatFillShare(img, trim ? trim.box : null);
  return flat >= FLAT_MIN && flat <= FLAT_MAX ? 'ui-composite' : null;
}
