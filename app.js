const state = {
  file: null,
  audioUrl: null,
  audioBuffer: null,
  envelope: [],
  suggestions: []
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


function setStatus(message, kind = 'ok') {
  if (!statusMsg) return;
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

function setRanges(duration) {
  startRange.max = String(duration);
  endRange.max = String(duration);
  startRange.value = '0';
  endRange.value = String(Math.min(duration, 30));
  updateSelectionLabel();
}

function updateSelectionLabel() {
  const a = Number(startRange.value);
  const b = Number(endRange.value);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const length = Math.max(0, end - start);
  selectionInfo.textContent = `Clip: ${fmt(start)} → ${fmt(end)} (${length.toFixed(1)}s)`;
  drawWaveform();
}

function drawWaveform(highlight = null) {
  const ctx = waveform.getContext('2d');
  const w = waveform.width;
  const h = waveform.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b1018';
  ctx.fillRect(0, 0, w, h);

  if (!state.envelope.length) return;

  const barW = w / state.envelope.length;
  for (let i = 0; i < state.envelope.length; i++) {
    const v = state.envelope[i];
    const bh = Math.max(2, v * (h - 20));
    const x = i * barW;
    const y = (h - bh) / 2;
    ctx.fillStyle = '#3f5e9a';
    ctx.fillRect(x, y, Math.max(1, barW - 1), bh);
  }

  const dur = player.duration || 1;
  const s = Math.min(Number(startRange.value), Number(endRange.value)) / dur;
  const e = Math.max(Number(startRange.value), Number(endRange.value)) / dur;
  ctx.fillStyle = 'rgba(109,141,255,.25)';
  ctx.fillRect(s * w, 0, Math.max(2, (e - s) * w), h);

  const nowX = ((player.currentTime || 0) / dur) * w;
  ctx.strokeStyle = '#00c2a8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(nowX, 0);
  ctx.lineTo(nowX, h);
  ctx.stroke();

  if (highlight) {
    ctx.fillStyle = 'rgba(255,208,0,.25)';
    ctx.fillRect((highlight.start / dur) * w, 0, Math.max(2, ((highlight.end - highlight.start) / dur) * w), h);
  }
}

async function decodeAudio(file) {
  const arrayBuffer = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    throw new Error('This browser does not support Web Audio decoding.');
  }
  const audioCtx = new Ctx();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    return decoded;
  } finally {
    await audioCtx.close();
  }
}

function computeEnvelope(audioBuffer, bins = 700) {
  const data = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / bins));
  const env = [];
  for (let i = 0; i < data.length; i += step) {
    let sum = 0;
    const end = Math.min(data.length, i + step);
    for (let j = i; j < end; j++) sum += Math.abs(data[j]);
    env.push(sum / (end - i || 1));
  }
  const max = Math.max(...env, 0.0001);
  return env.map(v => v / max);
}

function analyzeSuggestions() {
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

    suggestions.push({ start, end: start + windowSec, score, type, reasons: [
      `energy ${rms.toFixed(2)}`,
      `burst ${burst.toFixed(2)}`,
      `density ${density.toFixed(2)}`
    ]});
  }

  suggestions.sort((a, b) => b.score - a.score);

  const selected = [];
  for (const cand of suggestions) {
    const conflict = selected.some(s => Math.max(0, Math.min(s.end, cand.end) - Math.max(s.start, cand.start)) > 3);
    if (!conflict) selected.push(cand);
    if (selected.length >= 25) break;
  }
  return selected;
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
        <button data-jump="${s.start}">Jump</button>
        <button data-apply="${idx}">Use as clip</button>
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

async function exportWavClip() {
  if (!state.audioBuffer) return;
  const sr = state.audioBuffer.sampleRate;
  const ch = state.audioBuffer.numberOfChannels;
  let start = Math.min(Number(startRange.value), Number(endRange.value));
  let end = Math.max(Number(startRange.value), Number(endRange.value));
  if (end - start < 1) end = Math.min(player.duration, start + 1);

  const i0 = Math.floor(start * sr);
  const i1 = Math.floor(end * sr);
  const length = Math.max(0, i1 - i0);

  const channels = [];
  for (let c = 0; c < ch; c++) {
    channels.push(state.audioBuffer.getChannelData(c).slice(i0, i1));
  }

  const wav = encodeWav(channels, sr);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const a = document.createElement('a');
  const safeName = (state.file?.name || 'clip').replace(/\.[^/.]+$/, '');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName}_${Math.round(start)}-${Math.round(end)}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function encodeWav(channels, sampleRate) {
  const numChannels = channels.length;
  const length = channels[0]?.length || 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + length * blockAlign);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + length * blockAlign, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, length * blockAlign, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i] || 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

async function loadFile(file) {
  if (!file) return;
  setStatus('Loading audio…', 'ok');

  try {
    state.file = file;
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);
    player.src = state.audioUrl;
    player.load();

    state.audioBuffer = await decodeAudio(file);
    state.envelope = computeEnvelope(state.audioBuffer);
    state.suggestions = analyzeSuggestions();

    workspace.hidden = false;
    aiPanel.hidden = false;

    const duration = state.audioBuffer.duration;
    setRanges(duration);
    episodeMeta.textContent = `${file.name} • ${fmt(duration)} • ${(file.size / (1024 * 1024)).toFixed(1)} MB`;
    renderSuggestions(state.suggestions.slice(0, 5));
    drawWaveform();
    setStatus('Loaded. Ready to clip.', 'ok');
  } catch (err) {
    console.error(err);
    workspace.hidden = true;
    aiPanel.hidden = true;
    const reason = err?.message || 'Audio could not be decoded in-browser.';
    setStatus(`Could not open this file: ${reason} Try MP3/M4A/WAV.`, 'error');
  }
}

fileInput.addEventListener('change', async (e) => {
  await loadFile(e.target.files[0]);
});

dropzone.addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.style.borderColor = '#6d8dff';
});
dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = '#3e4d6f'; });
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.style.borderColor = '#3e4d6f';
  const file = e.dataTransfer.files?.[0];
  await loadFile(file);
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

document.getElementById('saveClip').addEventListener('click', exportWavClip);

document.querySelectorAll('[data-skip]').forEach(btn => {
  btn.addEventListener('click', () => {
    player.currentTime = Math.max(0, Math.min(player.duration || Infinity, player.currentTime + Number(btn.dataset.skip)));
  });
});

document.querySelectorAll('[data-speed]').forEach(btn => {
  btn.addEventListener('click', () => { player.playbackRate = Number(btn.dataset.speed); });
});

document.getElementById('playPause').addEventListener('click', () => {
  if (player.paused) player.play();
  else player.pause();
});

document.getElementById('suggestOne').addEventListener('click', () => {
  if (!state.suggestions.length) return;
  renderSuggestions([state.suggestions[0]]);
});

document.getElementById('suggestFive').addEventListener('click', () => {
  if (!state.suggestions.length) return;
  const weightedPool = state.suggestions.slice(0, 20);
  const picks = [];
  while (picks.length < 5 && weightedPool.length) {
    const idx = Math.floor(Math.random() * weightedPool.length);
    const cand = weightedPool.splice(idx, 1)[0];
    if (!picks.some(p => Math.max(0, Math.min(p.end, cand.end) - Math.max(p.start, cand.start)) > 3)) {
      picks.push(cand);
    }
  }
  renderSuggestions(picks);
});
