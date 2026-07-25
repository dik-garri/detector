// Metadata forensics: extracts provenance evidence from image bytes.
// Every finding: { id, label, value, signal: 'ai'|'human'|'neutral', hard, detail }
// `hard: true` means the evidence alone is near-conclusive.

const GENERATOR_STRINGS = [
  'stable diffusion', 'stable-diffusion', 'sdxl', 'novelai', 'invokeai',
  'comfyui', 'midjourney', 'dall-e', 'dall·e', 'adobe firefly',
  'trainedalgorithmicmedia', 'black forest labs', 'flux.1', 'ideogram.ai',
  'recraft.ai', 'leonardo.ai', 'dreamstudio', 'niji journey', 'draw things',
  'fooocus', 'automatic1111', 'swarmui', 'glif.app', 'getimg.ai',
];

const AI_SOFTWARE_HINTS = [
  ...GENERATOR_STRINGS, 'dalle', 'imagen', 'firefly', 'grok', 'gpt-4o', 'gpt-image',
];

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8', { fatal: false });

export function analyzeBytes(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  const findings = [];
  const format = sniffFormat(bytes) || mimeType || 'unknown';

  try {
    if (format === 'image/png') parsePng(bytes, findings);
    else if (format === 'image/jpeg') parseJpeg(bytes, findings);
    else if (format === 'image/webp') parseWebp(bytes, findings);
  } catch (err) {
    findings.push({
      id: 'parse-error', label: 'Metadata parsing', value: 'Partially unreadable',
      signal: 'neutral', hard: false, detail: String(err),
    });
  }

  sweepForGeneratorStrings(bytes, findings);
  detectC2pa(bytes, findings);

  if (!findings.some(f => f.signal !== 'neutral')) {
    findings.push({
      id: 'no-metadata', label: 'Provenance metadata', value: 'None found',
      signal: 'neutral', hard: false,
      detail: 'No camera EXIF and no generator signatures. Metadata is routinely stripped by social networks, screenshots and editors, so this neither confirms nor clears the image.',
    });
  }
  return { format, findings };
}

function sniffFormat(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && latin1.decode(b.subarray(0, 4)) === 'RIFF' && latin1.decode(b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (b.length > 12 && latin1.decode(b.subarray(4, 12)).includes('ftyp')) return 'image/heif-or-avif';
  if (b.length > 2 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return null;
}

// ---------- PNG ----------

function parsePng(bytes, findings) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  const textChunks = [];
  while (off + 12 <= bytes.length) {
    const len = view.getUint32(off);
    const type = latin1.decode(bytes.subarray(off + 4, off + 8));
    const dataStart = off + 8;
    if (dataStart + len > bytes.length) break;
    const data = bytes.subarray(dataStart, dataStart + len);

    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = latin1.decode(data.subarray(0, nul));
        let text = '';
        if (type === 'tEXt') text = utf8.decode(data.subarray(nul + 1));
        else if (type === 'iTXt') {
          // keyword \0 compflag(1) compmethod(1) lang \0 translated \0 text
          let p = nul + 1;
          const compressed = data[p] === 1;
          p += 2;
          p = data.indexOf(0, p) + 1; // skip language tag
          p = data.indexOf(0, p) + 1; // skip translated keyword
          text = compressed ? '(compressed)' : utf8.decode(data.subarray(p));
        } else text = '(compressed)';
        textChunks.push({ keyword, text });
      }
    } else if (type === 'eXIf') {
      parseTiff(data, findings, 'PNG eXIf chunk');
    }
    off = dataStart + len + 4;
  }

  for (const { keyword, text } of textChunks) {
    const kw = keyword.toLowerCase();
    if (kw === 'parameters' || kw === 'sd-metadata' || kw === 'dream' || kw === 'invokeai') {
      findings.push({
        id: 'sd-params', label: 'Generation parameters', value: 'Stable Diffusion family',
        signal: 'ai', hard: true,
        detail: `PNG "${keyword}" chunk holds a generation recipe: ${clip(text, 300)}`,
      });
    } else if (kw === 'prompt' || kw === 'workflow') {
      findings.push({
        id: 'comfy', label: 'Generation workflow', value: 'ComfyUI',
        signal: 'ai', hard: true,
        detail: `PNG "${keyword}" chunk carries a node graph used to generate this image: ${clip(text, 300)}`,
      });
    } else if (kw === 'software' || kw === 'comment' || kw === 'description' || kw === 'source') {
      const hit = AI_SOFTWARE_HINTS.find(s => text.toLowerCase().includes(s));
      if (hit) {
        findings.push({
          id: 'png-soft', label: 'Software tag', value: keyword + ': ' + clip(text, 80),
          signal: 'ai', hard: true,
          detail: `PNG text chunk names an AI generator ("${hit}").`,
        });
      }
    }
  }
}

// ---------- JPEG ----------

function parseJpeg(bytes, findings) {
  let off = 2;
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) { off++; continue; }
    const marker = bytes[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
    if (marker === 0xda) break; // start of scan — entropy-coded data follows
    const segLen = (bytes[off + 2] << 8) | bytes[off + 3];
    const seg = bytes.subarray(off + 4, off + 2 + segLen);
    if (marker === 0xe1) {
      const head = latin1.decode(seg.subarray(0, 29));
      if (head.startsWith('Exif\0\0')) parseTiff(seg.subarray(6), findings, 'EXIF');
      else if (head.includes('ns.adobe.com/xap')) parseXmp(utf8.decode(seg), findings);
    }
    off += 2 + segLen;
  }
}

// ---------- WebP ----------

function parseWebp(bytes, findings) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12;
  while (off + 8 <= bytes.length) {
    const fourcc = latin1.decode(bytes.subarray(off, off + 4));
    const size = view.getUint32(off + 4, true);
    const data = bytes.subarray(off + 8, off + 8 + size);
    if (fourcc === 'EXIF') parseTiff(data, findings, 'WebP EXIF');
    else if (fourcc === 'XMP ') parseXmp(utf8.decode(data), findings);
    off += 8 + size + (size % 2);
  }
}

// ---------- EXIF / TIFF ----------

function parseTiff(data, findings, source) {
  if (data.length < 8) return;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const le = latin1.decode(data.subarray(0, 2)) === 'II';
  if (view.getUint16(2, le) !== 42) return;

  const tags = {};
  const readIfd = (ifdOff) => {
    if (ifdOff + 2 > data.length) return;
    const count = view.getUint16(ifdOff, le);
    for (let i = 0; i < count; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > data.length) break;
      const tag = view.getUint16(e, le);
      const type = view.getUint16(e + 2, le);
      const n = view.getUint32(e + 4, le);
      let valOff = e + 8;
      const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 }[type] || 1;
      if (n * typeSize > 4) valOff = view.getUint32(e + 8, le);
      if (type === 2 && valOff + n <= data.length) {
        tags[tag] = latin1.decode(data.subarray(valOff, valOff + n)).replace(/\0+$/, '').trim();
      } else if (type === 3) {
        tags[tag] = view.getUint16(valOff, le);
      } else if (type === 4) {
        tags[tag] = view.getUint32(valOff, le);
      }
      if (tag === 0x8769 && typeof tags[tag] === 'number') readIfd(tags[tag]); // Exif sub-IFD
    }
  };
  readIfd(view.getUint32(4, le));

  const make = tags[0x010f], model = tags[0x0110], software = tags[0x0131];
  const exposure = tags[0x829a] !== undefined || tags[0x829d] !== undefined || tags[0x8827] !== undefined;

  if (software) {
    const hit = AI_SOFTWARE_HINTS.find(s => String(software).toLowerCase().includes(s));
    if (hit) {
      findings.push({
        id: 'exif-ai', label: 'Software tag', value: String(software),
        signal: 'ai', hard: true,
        detail: `${source} software field names an AI generator.`,
      });
      return;
    }
  }
  if (make || model) {
    const camera = model && make && model.toLowerCase().startsWith(make.toLowerCase())
      ? model : [make, model].filter(Boolean).join(' ');
    findings.push({
      id: 'camera', label: 'Camera EXIF', value: camera,
      signal: 'human', hard: false,
      detail: exposure
        ? `${source} carries camera make/model plus exposure data (shutter, aperture or ISO) — consistent with a real capture, though EXIF can be forged or transplanted.`
        : `${source} names a camera but lacks exposure data, which slightly weakens it as evidence.`,
    });
  } else if (software) {
    findings.push({
      id: 'exif-soft', label: 'Software tag', value: String(software),
      signal: 'neutral', hard: false,
      detail: `${source} names editing software but no camera. The image passed through an editor or exporter.`,
    });
  }
}

// ---------- XMP ----------

function parseXmp(xml, findings) {
  const lower = xml.toLowerCase();
  if (lower.includes('trainedalgorithmicmedia')) {
    const composite = lower.includes('compositewithtrainedalgorithmicmedia');
    findings.push({
      id: 'xmp-dst', label: 'IPTC digital source type', value: composite ? 'Composite with AI media' : 'Trained algorithmic media',
      signal: 'ai', hard: !composite,
      detail: 'The XMP packet carries the IPTC marker that generators such as DALL-E and Google Imagen embed to declare AI-generated content.',
    });
    return;
  }
  const hit = GENERATOR_STRINGS.find(s => lower.includes(s));
  if (hit) {
    findings.push({
      id: 'xmp-gen', label: 'XMP creator tool', value: hit,
      signal: 'ai', hard: true,
      detail: 'The XMP metadata packet names an AI image generator.',
    });
  }
}

// ---------- Whole-file sweeps ----------

function sweepForGeneratorStrings(bytes, findings) {
  if (findings.some(f => f.signal === 'ai')) return;
  const hay = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 32 * 1024 * 1024))).toLowerCase();
  const hit = GENERATOR_STRINGS.find(s => hay.includes(s));
  if (hit) {
    findings.push({
      id: 'byte-sweep', label: 'Generator signature', value: `"${hit}" in file bytes`,
      signal: 'ai', hard: true,
      detail: 'A known AI-generator string appears inside the file, typically left by embedded metadata.',
    });
  }
}

function detectC2pa(bytes, findings) {
  const head = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)));
  const jumbAt = head.indexOf('jumb');
  if (jumbAt === -1 || !head.includes('c2pa')) return;
  const manifest = head.slice(Math.max(0, jumbAt - 64), jumbAt + 512 * 1024).toLowerCase();
  const aiHit = AI_SOFTWARE_HINTS.find(s => manifest.includes(s)) ||
    (manifest.includes('trainedalgorithmicmedia') ? 'trainedAlgorithmicMedia' : null);
  if (aiHit) {
    findings.push({
      id: 'c2pa-ai', label: 'Content credentials (C2PA)', value: 'Declares AI generation',
      signal: 'ai', hard: true,
      detail: `A C2PA manifest is embedded and references "${aiHit}". Signed content credentials are the strongest available provenance evidence.`,
    });
  } else {
    findings.push({
      id: 'c2pa', label: 'Content credentials (C2PA)', value: 'Manifest present',
      signal: 'neutral', hard: false,
      detail: 'The file carries a C2PA provenance manifest. This app does not verify its signature; inspect it at contentcredentials.org/verify for the full chain.',
    });
  }
}

function clip(s, n) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
