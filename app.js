import { analyzeBytes } from './forensics.js';
import { trimUniformBorder, buildCropSet, median, looksLikeScreenshot } from './framing.js';

const MODEL_ID = 'onnx-community/SMOGY-Ai-images-detector-ONNX';

// Above this spread between edge-jittered crops the classifier is judged chaotic
// rather than merely uncertain, and its score is discarded.
const UNSTABLE_SPREAD = 0.25;

const el = (id) => document.getElementById(id);
const table = el('light-table');
const fileInput = el('file-input');
const preview = el('preview');
const scanBeam = el('scan-beam');
const dropHint = el('drop-hint');
const verdictPanel = el('verdict-panel');
const verdictLabel = el('verdict-label');
const verdictScore = el('verdict-score');
const needle = el('needle');
const evidenceList = el('evidence-list');
const fileMeta = el('file-meta');
const modelStatus = el('model-status');
const resetBtn = el('reset-btn');

let classifierPromise = null;
let currentRun = 0;

function loadClassifier() {
  if (classifierPromise) return classifierPromise;
  classifierPromise = (async () => {
    setModelStatus('loading', 'classifier: warming up');
    const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6');
    const classify = await pipeline('image-classification', MODEL_ID, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
          setModelStatus('loading', `classifier: downloading ${Math.round(p.progress || 0)}%`);
        }
      },
    });
    setModelStatus('ready', 'classifier: ready');
    return classify;
  })();
  classifierPromise.catch((err) => {
    console.error('Classifier failed to load', err);
    setModelStatus('error', 'classifier: unavailable');
  });
  return classifierPromise;
}

function setModelStatus(state, text) {
  modelStatus.dataset.state = state;
  modelStatus.textContent = text;
}

// ---------- Input wiring ----------

table.addEventListener('click', () => { if (!preview.src) fileInput.click(); });
table.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !preview.src) { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => fileInput.files[0] && handleFile(fileInput.files[0]));

['dragover', 'dragenter'].forEach((t) => table.addEventListener(t, (e) => {
  e.preventDefault();
  table.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((t) => table.addEventListener(t, (e) => {
  e.preventDefault();
  table.classList.remove('dragging');
}));
table.addEventListener('drop', (e) => {
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (f) handleFile(f);
});
document.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (f) handleFile(f);
});
resetBtn.addEventListener('click', reset);

function reset() {
  currentRun++;
  preview.removeAttribute('src');
  preview.hidden = true;
  dropHint.hidden = false;
  scanBeam.hidden = true;
  verdictPanel.dataset.state = 'idle';
  verdictLabel.textContent = 'Awaiting specimen';
  verdictScore.textContent = '——';
  needle.style.left = '50%';
  evidenceList.innerHTML = '';
  fileMeta.textContent = '';
  resetBtn.hidden = true;
  fileInput.value = '';
}

// ---------- Analysis ----------

async function handleFile(file) {
  const run = ++currentRun;
  const url = URL.createObjectURL(file);
  preview.src = url;
  preview.hidden = false;
  dropHint.hidden = true;
  scanBeam.hidden = false;
  resetBtn.hidden = false;
  verdictPanel.dataset.state = 'scanning';
  verdictLabel.textContent = 'Analyzing';
  verdictScore.textContent = '···';
  evidenceList.innerHTML = '';
  sweepNeedle(true);

  const buffer = await file.arrayBuffer();
  if (run !== currentRun) return;

  const { format, findings } = analyzeBytes(buffer, file.type);

  const img = await loadImage(url);
  fileMeta.textContent = [
    file.name,
    format.replace('image/', '').toUpperCase(),
    img ? `${img.naturalWidth}×${img.naturalHeight}` : null,
    humanSize(file.size),
  ].filter(Boolean).join('  ·  ');

  const trim = img ? trimUniformBorder(img) : null;
  const screenshot = img && looksLikeScreenshot({
    img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    hasCameraExif: findings.some((f) => f.id === 'camera'),
    hasMetadata: findings.some((f) => f.signal !== 'neutral'),
    trim,
  });

  if (trim) {
    findings.push({
      id: 'framing', label: 'Framing', value: `Border cropped to ${trim.box.w}×${trim.box.h}`,
      signal: 'neutral', hard: false,
      detail: `The picture fills only ${Math.round(trim.areaRatio * 100)}% of the frame — the rest is a uniform border. The classifier reads padding as evidence of a real photo, so it scored the inner region instead of the whole frame.`,
    });
  }
  if (screenshot) {
    // The generic "no metadata" row says the same thing less precisely.
    const generic = findings.findIndex((f) => f.id === 'no-metadata');
    if (generic !== -1) findings.splice(generic, 1);
    findings.push({
      id: 'screenshot', label: 'Looks like a screenshot', value: 'Metadata proves nothing here',
      signal: 'neutral', hard: false,
      detail: screenshot === 'screen-size'
        ? 'The dimensions match a common screen capture, and a screenshot is re-rendered from pixels — it cannot carry the provenance metadata of the image it shows. Missing generator metadata is expected here and clears nothing.'
        : 'Large areas of a single flat colour suggest interface chrome rather than a photograph. A screenshot is re-rendered from pixels, so it cannot carry the provenance metadata of the image it shows — missing generator metadata is expected here and clears nothing.',
    });
  }

  let mlProb = null;
  let mlStats = null;
  try {
    const classify = await loadClassifier();
    const crops = img ? buildCropSet(img, trim) : [];
    const scores = [];
    for (const cropUrl of crops.length ? crops : [url]) {
      const out = await classify(cropUrl, { top_k: 2 });
      if (run !== currentRun) return;
      const artificial = out.find((o) => o.label === 'artificial');
      scores.push(artificial ? artificial.score : 0);
    }
    const lo = Math.min(...scores), hi = Math.max(...scores);
    mlProb = median(scores);
    mlStats = { lo, hi, spread: hi - lo, n: scores.length };
    const pct = Math.round(mlProb * 100);

    if (mlStats.spread > UNSTABLE_SPREAD) {
      findings.push({
        id: 'ml', label: 'ML classifier (Swin)', value: `${Math.round(lo * 100)}–${Math.round(hi * 100)}%, unusable`,
        signal: 'neutral', hard: false,
        detail: `Crops differing only at the edges scored anywhere from ${Math.round(lo * 100)}% to ${Math.round(hi * 100)}% artificial. The model behaves chaotically on frames that mix a picture with other content — which is exactly what a screenshot is — so no score it produces for this image means anything. Reporting one would be picking a number at random.`,
      });
    } else {
      findings.push({
        id: 'ml', label: 'ML classifier (Swin)', value: `${pct}% artificial`,
        signal: mlProb > 0.6 ? 'ai' : mlProb < 0.4 ? 'human' : 'neutral', hard: false,
        detail: `A vision model trained to separate generated from photographed images scored ${pct}% likely AI — the median across ${scores.length} crops${trim ? ' of the cropped picture' : ''}. Classifiers err on heavily edited, upscaled or unusual photos — treat as one signal, not proof.`,
      });
    }
  } catch {
    findings.push({
      id: 'ml-fail', label: 'ML classifier', value: 'Unavailable',
      signal: 'neutral', hard: false,
      detail: 'The in-browser model could not run; the verdict rests on metadata alone and is weaker.',
    });
  }
  if (run !== currentRun) return;

  renderVerdict(score(findings, mlProb, mlStats), findings);
}

function score(findings, mlProb, mlStats) {
  const hardAi = findings.some((f) => f.signal === 'ai' && f.hard);
  const camera = findings.some((f) => f.id === 'camera');
  const softAi = findings.some((f) => f.signal === 'ai' && !f.hard && f.id !== 'ml');

  // A chaotic classifier is no evidence at all. Without hard metadata to fall
  // back on there is nothing left to judge with, so say so instead of guessing.
  const unreliable = !hardAi && !!mlStats && mlStats.spread > UNSTABLE_SPREAD;
  if (unreliable) return { p: 0.5, confident: false, unreliable, mlStats };

  let p = mlProb ?? 0.5;
  let confident = mlProb !== null;
  if (hardAi) { p = Math.max(p, 0.98); confident = true; }
  else if (softAi) p = Math.min(1, p + 0.2);
  else if (camera) p = Math.max(0.02, p - 0.22);
  return { p, confident, unreliable, mlStats };
}

function renderVerdict({ p, confident, unreliable, mlStats }, findings) {
  scanBeam.hidden = true;
  sweepNeedle(false);
  const pct = Math.round(p * 100);
  needle.style.left = unreliable ? '50%' : `${pct}%`;

  let state, label;
  if (unreliable) { state = 'unsure'; label = 'Cannot tell'; }
  else if (!confident && p > 0.35 && p < 0.65) { state = 'unsure'; label = 'Inconclusive'; }
  else if (p >= 0.75) { state = 'ai'; label = 'Likely AI-generated'; }
  else if (p <= 0.25) { state = 'human'; label = 'Likely authentic photo'; }
  else { state = 'unsure'; label = 'Inconclusive'; }

  verdictPanel.dataset.state = state;
  verdictLabel.textContent = label;
  verdictScore.textContent = unreliable
    ? `classifier ranged ${Math.round(mlStats.lo * 100)}–${Math.round(mlStats.hi * 100)}%`
    : `${pct}% artificial`;

  const order = { ai: 0, human: 1, neutral: 2 };
  findings.sort((a, b) => (b.hard - a.hard) || (order[a.signal] - order[b.signal]));
  evidenceList.innerHTML = '';
  for (const f of findings) {
    const li = document.createElement('li');
    li.className = `evidence signal-${f.signal}`;
    li.innerHTML = `
      <span class="tag">${f.signal === 'ai' ? 'AI' : f.signal === 'human' ? 'PHOTO' : 'INFO'}</span>
      <div class="body">
        <div class="row"><span class="label"></span><span class="value"></span></div>
        <p class="detail"></p>
      </div>`;
    li.querySelector('.label').textContent = f.label;
    li.querySelector('.value').textContent = f.value;
    li.querySelector('.detail').textContent = f.detail;
    evidenceList.appendChild(li);
  }
}

function sweepNeedle(on) {
  needle.classList.toggle('sweeping', on);
}

function loadImage(url) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

reset();
loadClassifier();
