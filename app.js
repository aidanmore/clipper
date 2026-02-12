const state = {
  file: null,
  audioUrl: null,
  audioBuffer: null,
  envelope: [],
  suggestions: [],
  analysisRunning: false
};

const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
const player = document.getElementById('player');
const workspace = document.getElementById('workspace');
const aiPanel = document.getElementById('aiPanel');
const episodeMeta = document.getElementById('episodeMeta');
const waveform = document.getElementById('waveform');
const startRange = document.getElementById('startRange');
const endRange = document.getElementById('endRange');
const selectionInfo = document.getElementById('selectionInfo');
const suggestionsEl = document.getElementById('suggestions');
const statusMsg = document.getElementById('statusMsg');
let mp3LibPromise = null;

function setStatus(message, kind = 'ok') {
  statusMsg.textContent = message || '';
  statusMsg.className = `status ${kind}`.trim();
}

const fmt = (sec) => {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const left = [m, s].map(v => String(v).padStart(2, '0')).join(':');
  return h > 0 ? `${h}:${left}` : left;
};

function currentDuration() {
  const d = player.duration;
  return Number.isFinite(d) && d > 0 ? d : 3600;
}

function setRanges(duration) {
  const dur = Math.max(1, duration || 1);
  startRange.max = String(dur);
  endRange.max = String(dur);
  startRange.value = '0';
  endRange.value = String(Math.min(dur, 30));
  updateSelectionLabel();
}

function syncRangesToMetadata() {
  const dur = player.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  startRange.max = String(dur);
  endRange.max = String(dur);

  const s = Math.min(Number(startRange.value), dur);
  const e = Math.min(Math.max(Number(endRange.value), s + 0.1), dur);
  startRange.value = String(s);
  endRange.value = String(e);

  episodeMeta.textContent = `${state.file?.name || 'audio'} • ${fmt(dur)} • ${((state.file?.size || 0) / (1024 * 1024)).toFixed(1)} mb`;
  updateSelectionLabel();
  drawWaveform();
}

function updateSelectionLabel() {
  const a = Number(startRange.value);
  const b = Number(endRange.value);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const length = Math.max(0, end - start);
  selectionInfo.textContent = `clip: ${fmt(start)} -> ${fmt(end)} (${length.toFixed(1)}s)`;
  drawWaveform();
}

function drawWaveform(highlight = null) {
  const ctx = waveform.getContext('2d');
  const w = waveform.width;
  const h = waveform.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, w, h);

  if (state.envelope.length) {
    const barW = w / state.envelope.length;
    for (let i = 0; i < state.envelope.length; i++) {
      const v = state.envelope[i];
      const bh = Math.max(2, v * (h - 20));
      const x = i * barW;
      const y = (h - bh) / 2;
      ctx.fillStyle = '#d9d9d9';
      ctx.fillRect(x, y, Math.max(1, barW - 1), bh);
    }
  } else {
    ctx.strokeStyle = '#1f1f1f';
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const x = (w / 10) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff22';
    ctx.fillRect(0, h * 0.45, w, h * 0.1);
  }

  const dur = Math.max(1, currentDuration());
  const s = Math.min(Number(startRange.value || 0), Number(endRange.value || 0)) / dur;
  const e = Math.max(Number(startRange.value || 0), Number(endRange.value || 0)) / dur;
  ctx.fillStyle = 'rgba(255,255,255,.16)';
  ctx.fillRect(s * w, 0, Math.max(2, (e - s) * w), h);

  const nowX = ((player.currentTime || 0) / dur) * w;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(nowX, 0);
  ctx.lineTo(nowX, h);
  ctx.stroke();

  if (highlight) {
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillRect((highlight.start / dur) * w, 0, Math.max(2, ((highlight.end - highlight.start) / dur) * w), h);
  }
}

async function decodeAudio(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('web audio decode unsupported');
  const audioCtx = new AudioCtx();
  try {
    return await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await audioCtx.close();
  }
}

function loadMp3Library() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  if (mp3LibPromise) return mp3LibPromise;

  mp3LibPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    script.async = true;
    script.onload = () => {
      if (window.lamejs) resolve(window.lamejs);
      else reject(new Error('mp3 encoder failed to load'));
    };
    script.onerror = () => reject(new Error('could not load mp3 encoder'));
    document.head.appendChild(script);
  });

  return mp3LibPromise;
}

function floatTo16BitPCM(floatArray) {
  const out = new Int16Array(floatArray.length);
  for (let i = 0; i < floatArray.length; i++) {
    const s = Math.max(-1, Math.min(1, floatArray[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function encodeMp3FromSelection(start, end) {
  if (!state.audioBuffer) {
    setStatus('preparing export… decoding source once for mp3 export.', 'ok');
    state.audioBuffer = await decodeAudio(state.file);
    state.envelope = computeEnvelope(state.audioBuffer);
    drawWaveform();
  }

  const lame = await loadMp3Library();
  const sr = state.audioBuffer.sampleRate;
  const i0 = Math.floor(start * sr);
  const i1 = Math.floor(end * sr);
  const left = state.audioBuffer.getChannelData(0).slice(i0, i1);
  const pcm = floatTo16BitPCM(left);

  const encoder = new lame.Mp3Encoder(1, sr, 128);
  const blockSize = 1152;
  const mp3Data = [];

  for (let i = 0; i < pcm.length; i += blockSize) {
    const chunk = pcm.subarray(i, i + blockSize);
    const out = encoder.encodeBuffer(chunk);
    if (out.length > 0) mp3Data.push(new Uint8Array(out));
  }

  const flush = encoder.flush();
  if (flush.length > 0) mp3Data.push(new Uint8Array(flush));
  return new Blob(mp3Data, { type: 'audio/mpeg' });
}

function computeEnvelope(audioBuffer, bins = 700) {
  const data = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / bins));
  const env = [];
  for (let i = 0; i < data.length; i += step) {
    let sum = 0;
    const end = Math.min(data.length, i + step);
    for (let j = i; j < end; j++) sum += Math.abs(data[j]);
    env.push(sum / Math.max(1, end - i));
  }
  const max = Math.max(...env, 0.0001);
  return env.map(v => v / max);
}

function analyzeSuggestionsFromBuffer() {
  if (!state.audioBuffer) return [];
  const sr = state.audioBuffer.sampleRate;
  const data = state.audioBuffer.getChannelData(0);
  const duration = state.audioBuffer.duration;
  const windowSec = 18;
  const hopSec = 4;
  const suggestions = [];

  for (let start = 0; start + windowSec < duration; start += hopSec) {
    const i0 = Math.floor(start * sr);
    const i1 = Math.floor((start + windowSec) * sr);
    const chunk = data.slice(i0, i1);
    const frame = Math.max(1, Math.floor(sr * 0.2));

    let rms = 0;
    for (let i = 0; i < chunk.length; i++) rms += chunk[i] * chunk[i];
    rms = Math.sqrt(rms / Math.max(1, chunk.length));

    const energies = [];
    for (let i = 0; i < chunk.length; i += frame) {
      const end = Math.min(chunk.length, i + frame);
      let s = 0;
      for (let j = i; j < end; j++) s += chunk[j] * chunk[j];
      energies.push(Math.sqrt(s / Math.max(1, end - i)));
    }
    energies.sort((a, b) => a - b);
    const p80 = energies[Math.floor(energies.length * 0.8)] || 0;
    const p20 = energies[Math.floor(energies.length * 0.2)] || 0;
    const burst = energies.filter(v => v > p80).length / Math.max(1, energies.length);
    const density = 1 - (energies.filter(v => v < Math.max(0.015, p20)).length / Math.max(1, energies.length));
    const midBonus = 1 - Math.abs((start / duration) - 0.5);
    const score = 0.45 * rms + 0.30 * burst + 0.15 * density + 0.10 * midBonus;

    let type = 'one-liner';
    if (burst > 0.65 && rms > 0.1) type = 'big-laugh';
    else if (burst > 0.5) type = 'riff';

    suggestions.push({
      start,
      end: start + windowSec,
      score,
      type,
      reasons: [`energy ${rms.toFixed(2)}`, `burst ${burst.toFixed(2)}`, `density ${density.toFixed(2)}`]
    });
  }

  suggestions.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const cand of suggestions) {
    const overlap = selected.some(s => Math.max(0, Math.min(s.end, cand.end) - Math.max(s.start, cand.start)) > 3);
    if (!overlap) selected.push(cand);
    if (selected.length >= 25) break;
  }
  return selected;
}

function quickSuggestions(duration, count = 8) {
  const dur = Math.max(30, duration || 3600);
  const picks = [];
  const baseZones = [0.08, 0.18, 0.32, 0.48, 0.62, 0.74, 0.86];
  const clipLen = Math.min(24, Math.max(12, dur * 0.04));

  for (let i = 0; i < count; i++) {
    const z = baseZones[i % baseZones.length];
    const jitter = (Math.random() - 0.5) * 0.08;
    let start = Math.max(0, (z + jitter) * dur);
    start = Math.min(start, Math.max(0, dur - clipLen));
    const end = Math.min(dur, start + clipLen);
    const type = i % 3 === 0 ? 'riff' : (i % 5 === 0 ? 'big-laugh' : 'one-liner');
    picks.push({ start, end, score: 0.55 - i * 0.02, type, reasons: ['instant pick', 'no full decode required'] });
  }
  return picks;
}

function renderSuggestions(items) {
  suggestionsEl.innerHTML = '';
  items.forEach((s, idx) => {
    const card = document.createElement('div');
    card.className = 'suggestion';
    card.innerHTML = `
      <div><span class="type">${s.type}</span> • ${fmt(s.start)} → ${fmt(s.end)} • score ${s.score.toFixed(2)}</div>
      <small>${s.reasons.join(' · ')}</small>
      <div class="controls-row">
        <button data-jump="${s.start}">jump</button>
        <button data-apply="${idx}">use as clip</button>
      </div>
    `;
    suggestionsEl.appendChild(card);
  });

  suggestionsEl.querySelectorAll('[data-jump]').forEach(btn => {
    btn.addEventListener('click', () => {
      player.currentTime = Number(btn.dataset.jump);
      player.play();
      drawWaveform();
    });
  });

  suggestionsEl.querySelectorAll('[data-apply]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = items[Number(btn.dataset.apply)];
      startRange.value = String(s.start.toFixed(1));
      endRange.value = String(s.end.toFixed(1));
      updateSelectionLabel();
      drawWaveform(s);
    });
  });
}

async function maybeRunBackgroundAnalysis() {
  if (!state.file || state.analysisRunning) return;
  const fileMb = state.file.size / (1024 * 1024);

  if (fileMb > 18) {
    state.suggestions = quickSuggestions(currentDuration(), 12);
    renderSuggestions(state.suggestions.slice(0, 5));
    setStatus('instant mode ready. deep analysis skipped on large files to keep phone fast.', 'ok');
    return;
  }

  state.analysisRunning = true;
  setStatus('instant mode ready. building smart suggestions in background…', 'ok');
  try {
    state.audioBuffer = await decodeAudio(state.file);
    state.envelope = computeEnvelope(state.audioBuffer);
    state.suggestions = analyzeSuggestionsFromBuffer();
    if (!state.suggestions.length) state.suggestions = quickSuggestions(currentDuration(), 12);
    renderSuggestions(state.suggestions.slice(0, 5));
    drawWaveform();
    setStatus('loaded and analyzed. ready to clip.', 'ok');
  } catch {
    state.audioBuffer = null;
    state.envelope = [];
    state.suggestions = quickSuggestions(currentDuration(), 12);
    renderSuggestions(state.suggestions.slice(0, 5));
    drawWaveform();
    setStatus('instant mode ready. deep analysis unavailable on this browser/file.', 'ok');
  } finally {
    state.analysisRunning = false;
  }
}

function exportClipMarkerJson(start, end) {
  const payload = {
    source: state.file?.name || 'unknown',
    start_sec: Number(start.toFixed(2)),
    end_sec: Number(end.toFixed(2)),
    duration_sec: Number((end - start).toFixed(2)),
    created_at: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const safeName = (state.file?.name || 'clip').replace(/\.[^/.]+$/, '');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName}_${Math.round(start)}-${Math.round(end)}.clip.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

async function exportClip() {
  const start = Math.min(Number(startRange.value), Number(endRange.value));
  const end = Math.max(Number(startRange.value), Number(endRange.value));
  if (end - start < 0.5) {
    setStatus('clip is too short. select at least 0.5s.', 'error');
    return;
  }

  try {
    setStatus('exporting mp3…', 'ok');
    const blob = await encodeMp3FromSelection(start, end);
    const a = document.createElement('a');
    const safeName = (state.file?.name || 'clip').replace(/\.[^/.]+$/, '');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeName}_${Math.round(start)}-${Math.round(end)}.mp3`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setStatus('clip exported as mp3.', 'ok');
  } catch (err) {
    console.error(err);
    exportClipMarkerJson(start, end);
    setStatus('mp3 export failed. saved clip marker json fallback.', 'error');
  }
}

async function loadFile(file) {
  if (!file) return;
  setStatus('opening file…', 'ok');

  try {
    state.file = file;
    state.audioBuffer = null;
    state.envelope = [];
    state.suggestions = [];

    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);

    workspace.hidden = false;
    aiPanel.hidden = false;
    setRanges(3600);
    drawWaveform();

    suggestionsEl.innerHTML = '<div class="suggestion">ready. tap suggest to get instant picks.</div>';
    episodeMeta.textContent = `${file.name} • ${((file.size) / (1024 * 1024)).toFixed(1)} mb`;

    player.src = state.audioUrl;
    player.load();

    setStatus('file selected. if ios delays metadata, tap play once then keep clipping.', 'ok');
    setTimeout(() => { maybeRunBackgroundAnalysis(); }, 10);
  } catch (err) {
    setStatus(`could not open this file: ${err?.message || 'unknown error'} try mp3/wav/m4a.`, 'error');
  }
}

player.addEventListener('loadedmetadata', () => {
  syncRangesToMetadata();
  setStatus('loaded instantly. you can clip now.', 'ok');
});

player.addEventListener('error', () => {
  setStatus('could not load this audio file on this browser. try mp3 or m4a.', 'error');
});

fileInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  await loadFile(f);
  fileInput.value = '';
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = '#ffffff';
});

dropzone.addEventListener('dragleave', () => {
  dropzone.style.borderColor = '';
});

dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.style.borderColor = '';
  await loadFile(e.dataTransfer.files?.[0]);
});

player.addEventListener('timeupdate', drawWaveform);
startRange.addEventListener('input', updateSelectionLabel);
endRange.addEventListener('input', updateSelectionLabel);

document.getElementById('setStartNow').addEventListener('click', () => {
  startRange.value = String(player.currentTime.toFixed(1));
  updateSelectionLabel();
});

document.getElementById('setEndNow').addEventListener('click', () => {
  endRange.value = String(player.currentTime.toFixed(1));
  updateSelectionLabel();
});

document.getElementById('previewClip').addEventListener('click', () => {
  const start = Math.min(Number(startRange.value), Number(endRange.value));
  const end = Math.max(Number(startRange.value), Number(endRange.value));
  player.currentTime = start;
  player.play();
  const stop = () => {
    if (player.currentTime >= end) {
      player.pause();
      player.removeEventListener('timeupdate', stop);
    }
  };
  player.addEventListener('timeupdate', stop);
});

document.getElementById('saveClip').addEventListener('click', exportClip);

document.querySelectorAll('[data-skip]').forEach(btn => {
  btn.addEventListener('click', () => {
    player.currentTime = Math.max(0, Math.min(currentDuration(), player.currentTime + Number(btn.dataset.skip)));
  });
});

document.querySelectorAll('[data-speed]').forEach(btn => {
  btn.addEventListener('click', () => {
    player.playbackRate = Number(btn.dataset.speed);
  });
});

document.getElementById('playPause').addEventListener('click', () => {
  if (player.paused) player.play();
  else player.pause();
});

document.getElementById('suggestOne').addEventListener('click', () => {
  if (!state.suggestions.length) state.suggestions = quickSuggestions(currentDuration(), 8);
  renderSuggestions([state.suggestions[0]]);
});

document.getElementById('suggestFive').addEventListener('click', () => {
  if (!state.suggestions.length) state.suggestions = quickSuggestions(currentDuration(), 12);
  const pool = state.suggestions.slice(0, 20);
  const picks = [];
  while (picks.length < 5 && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    const cand = pool.splice(idx, 1)[0];
    if (!picks.some(p => Math.max(0, Math.min(p.end, cand.end) - Math.max(p.start, cand.start)) > 3)) {
      picks.push(cand);
    }
  }
  renderSuggestions(picks);
});
