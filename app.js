import { analyzeBytes } from './forensics.js';

const MODEL_ID = 'onnx-community/SMOGY-Ai-images-detector-ONNX';

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

  let mlProb = null;
  try {
    const classify = await loadClassifier();
    const out = await classify(url, { top_k: 2 });
    if (run !== currentRun) return;
    const artificial = out.find((o) => o.label === 'artificial');
    if (artificial) mlProb = artificial.score;
    findings.push({
      id: 'ml', label: 'ML classifier (Swin)', value: `${Math.round(mlProb * 100)}% artificial`,
      signal: mlProb > 0.6 ? 'ai' : mlProb < 0.4 ? 'human' : 'neutral', hard: false,
      detail: `A vision model trained to separate generated from photographed images scored this ${Math.round(mlProb * 100)}% likely AI. Classifiers err on heavily edited, upscaled or unusual photos — treat as one signal, not proof.`,
    });
  } catch {
    findings.push({
      id: 'ml-fail', label: 'ML classifier', value: 'Unavailable',
      signal: 'neutral', hard: false,
      detail: 'The in-browser model could not run; the verdict rests on metadata alone and is weaker.',
    });
  }
  if (run !== currentRun) return;

  renderVerdict(score(findings, mlProb), findings);
}

function score(findings, mlProb) {
  const hardAi = findings.some((f) => f.signal === 'ai' && f.hard);
  const camera = findings.some((f) => f.id === 'camera');
  const softAi = findings.some((f) => f.signal === 'ai' && !f.hard && f.id !== 'ml');

  let p = mlProb ?? 0.5;
  let confident = mlProb !== null;
  if (hardAi) { p = Math.max(p, 0.98); confident = true; }
  else if (softAi) p = Math.min(1, p + 0.2);
  else if (camera) p = Math.max(0.02, p - 0.22);
  return { p, confident };
}

function renderVerdict({ p, confident }, findings) {
  scanBeam.hidden = true;
  sweepNeedle(false);
  const pct = Math.round(p * 100);
  needle.style.left = `${pct}%`;

  let state, label;
  if (!confident && p > 0.35 && p < 0.65) { state = 'unsure'; label = 'Inconclusive'; }
  else if (p >= 0.75) { state = 'ai'; label = 'Likely AI-generated'; }
  else if (p <= 0.25) { state = 'human'; label = 'Likely authentic photo'; }
  else { state = 'unsure'; label = 'Inconclusive'; }

  verdictPanel.dataset.state = state;
  verdictLabel.textContent = label;
  verdictScore.textContent = `${pct}% artificial`;

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
