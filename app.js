/* clipper - github pages single-page app
   mobile-first long audio clipping + wav export + heuristic "funny" suggestion
*/

const el = (id) => document.getElementById(id);

const dropZone = el("dropZone");
const fileInput = el("fileInput");
const fileMeta = el("fileMeta");
const fileName = el("fileName");
const fileDur = el("fileDur");
const decodeStatus = el("decodeStatus");

const playerCard = el("playerCard");
const clipsCard = el("clipsCard");
const clipsList = el("clipsList");

const audio = el("audio");
const wave = el("wave");
const ctx = wave.getContext("2d");

const overlay = el("overlay");
const handleL = el("handleL");
const handleR = el("handleR");
const playhead = el("playhead");
const shadeL = el("shadeL");
const shadeR = el("shadeR");

const timeNow = el("timeNow");
const timeEnd = el("timeEnd");
const timeSel = el("timeSel");

const playBtn = el("playBtn");
const loopBtn = el("loopBtn");
const back5 = el("back5");
const fwd5 = el("fwd5");
const setIn = el("setIn");
const setOut = el("setOut");
const fitSel = el("fitSel");
const resetSel = el("resetSel");
const zoom = el("zoom");
const speed = el("speed");
const saveClip = el("saveClip");
const suggestBtn = el("suggestBtn");
const clearClips = el("clearClips");

const help = el("help");
el("helpBtn").addEventListener("click", () => help.showModal());
el("closeHelp").addEventListener("click", () => help.close());

let audioCtx = null;
let decodedBuffer = null;      // AudioBuffer for export + analysis (optional but needed for wav export)
let peaksBase = null;          // base peaks array for waveform (downsampled)
let duration = 0;

let selection = { start: 0, end: 10 }; // seconds
let isLoop = false;

let view = {
  // viewport (in seconds) used for zoomed waveform browsing
  start: 0,
  span: 60, // seconds visible
  dragging: null, // "L" | "R" | "SCRUB"
  scrubStartX: 0,
  scrubStartView: 0
};

const clips = []; // { id, name, start, end, createdAt }

function fmtTime(s){
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function clamp(v, a, b){ return Math.min(b, Math.max(a, v)); }

function setStatus(txt, kind="subtle"){
  decodeStatus.textContent = txt;
  decodeStatus.style.color =
    kind === "ok" ? "var(--ok)" :
    kind === "bad" ? "var(--danger)" : "var(--muted)";
}

function resizeCanvas(){
  const dpr = window.devicePixelRatio || 1;
  const rect = wave.getBoundingClientRect();
  wave.width = Math.floor(rect.width * dpr);
  wave.height = Math.floor(120 * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  draw();
  syncOverlay();
}

window.addEventListener("resize", resizeCanvas);

function bindDnD(){
  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
  ["dragenter","dragover","dragleave","drop"].forEach(evt => {
    dropZone.addEventListener(evt, prevent, false);
  });

  dropZone.addEventListener("dragover", () => dropZone.classList.add("dragging"));
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
  dropZone.addEventListener("drop", (e) => {
    dropZone.classList.remove("dragging");
    const f = e.dataTransfer.files?.[0];
    if (f) loadFile(f);
  });
}
bindDnD();

fileInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (f) loadFile(f);
  fileInput.value = "";
});

async function loadFile(file){
  decodedBuffer = null;
  peaksBase = null;

  fileMeta.hidden = false;
  fileName.textContent = file.name;

  setStatus("loading…");
  playerCard.hidden = true;

  const url = URL.createObjectURL(file);
  audio.src = url;
  audio.playbackRate = parseFloat(speed.value);

  await audioLoadedMetadata();
  duration = audio.duration || 0;

  fileDur.textContent = `duration ${fmtTime(duration)}`;
  timeEnd.textContent = fmtTime(duration);

  // initial selection + view
  selection.start = 0;
  selection.end = Math.min(20, Math.max(10, duration * 0.01));
  view.start = 0;
  view.span = pickSpan();

  playerCard.hidden = false;
  clipsCard.hidden = false;

  setStatus("decoding waveform…");
  await decodeAndBuildPeaks(file);
  setStatus("ready", "ok");

  resizeCanvas();
  updateTimes();
}

function audioLoadedMetadata(){
  return new Promise((res) => {
    const done = () => { audio.removeEventListener("loadedmetadata", done); res(); };
    audio.addEventListener("loadedmetadata", done);
  });
}

function pickSpan(){
  // mobile friendly spans depending on zoom and duration
  // zoom 1..8 => 120s..10s roughly
  const z = parseInt(zoom.value, 10);
  const spans = [120, 90, 60, 45, 30, 20, 15, 10];
  const base = spans[z-1] || 60;
  return clamp(base, 8, Math.max(10, duration));
}

zoom.addEventListener("input", () => {
  if (!duration) return;
  const oldCenter = view.start + view.span * 0.5;
  view.span = pickSpan();
  view.start = clamp(oldCenter - view.span * 0.5, 0, Math.max(0, duration - view.span));
  draw();
  syncOverlay();
});

speed.addEventListener("input", () => {
  audio.playbackRate = parseFloat(speed.value);
});

playBtn.addEventListener("click", togglePlay);
loopBtn.addEventListener("click", () => {
  isLoop = !isLoop;
  loopBtn.textContent = `loop: ${isLoop ? "on" : "off"}`;
  loopBtn.setAttribute("aria-pressed", String(isLoop));
});

back5.addEventListener("click", () => seekTo(audio.currentTime - 5));
fwd5.addEventListener("click", () => seekTo(audio.currentTime + 5));

setIn.addEventListener("click", () => {
  selection.start = clamp(audio.currentTime, 0, selection.end - 0.05);
  draw(); syncOverlay(); updateTimes();
});
setOut.addEventListener("click", () => {
  selection.end = clamp(audio.currentTime, selection.start + 0.05, duration);
  draw(); syncOverlay(); updateTimes();
});

fitSel.addEventListener("click", () => {
  const pad = Math.min(5, (selection.end - selection.start) * 0.2);
  view.start = clamp(selection.start - pad, 0, Math.max(0, duration - view.span));
  // if selection doesn't fit, adjust span temporarily
  const selSpan = (selection.end - selection.start) + pad*2;
  if (selSpan > view.span) view.span = clamp(selSpan, 8, duration);
  draw(); syncOverlay();
});

resetSel.addEventListener("click", () => {
  selection.start = clamp(audio.currentTime, 0, duration);
  selection.end = clamp(selection.start + 20, selection.start + 0.05, duration);
  view.span = pickSpan();
  view.start = clamp(selection.start - view.span*0.3, 0, Math.max(0, duration - view.span));
  draw(); syncOverlay(); updateTimes();
});

saveClip.addEventListener("click", () => {
  if (!decodedBuffer) return;
  const name = `clip ${clips.length + 1}`;
  const id = crypto.randomUUID();
  clips.unshift({ id, name, start: selection.start, end: selection.end, createdAt: Date.now() });
  renderClips();
});

clearClips.addEventListener("click", () => {
  clips.length = 0;
  renderClips();
});

audio.addEventListener("timeupdate", () => {
  updateTimes();
  syncPlayhead();
  if (audio.paused) return;

  if (audio.currentTime >= selection.end - 0.01){
    if (isLoop){
      audio.currentTime = selection.start;
      audio.play();
    } else {
      audio.pause();
      playBtn.textContent = "play";
    }
  }
});

audio.addEventListener("play", () => playBtn.textContent = "pause");
audio.addEventListener("pause", () => playBtn.textContent = "play");

function seekTo(t){
  if (!duration) return;
  audio.currentTime = clamp(t, 0, duration);
  updateTimes();
  syncPlayhead();
  // keep playhead in view by nudging viewport
  ensureInView(audio.currentTime);
}

function togglePlay(){
  if (!duration) return;
  if (audio.paused){
    // if playhead outside selection, snap into selection
    if (audio.currentTime < selection.start || audio.currentTime > selection.end){
      audio.currentTime = selection.start;
    }
    audio.play();
  } else {
    audio.pause();
  }
}

function updateTimes(){
  timeNow.textContent = fmtTime(audio.currentTime || 0);
  timeSel.textContent = `sel ${fmtTime(selection.start)} → ${fmtTime(selection.end)} (${fmtTime(selection.end - selection.start)})`;
}

function tToX(t){
  const rect = wave.getBoundingClientRect();
  const w = rect.width;
  const p = (t - view.start) / view.span;
  return clamp(p * w, 0, w);
}

function xToT(x){
  const rect = wave.getBoundingClientRect();
  const w = rect.width;
  const p = clamp(x / w, 0, 1);
  return view.start + p * view.span;
}

function ensureInView(t){
  if (t < view.start){
    view.start = clamp(t - view.span*0.1, 0, Math.max(0, duration - view.span));
    draw(); syncOverlay();
  } else if (t > view.start + view.span){
    view.start = clamp(t - view.span*0.9, 0, Math.max(0, duration - view.span));
    draw(); syncOverlay();
  }
}

function syncOverlay(){
  const lX = tToX(selection.start);
  const rX = tToX(selection.end);

  handleL.style.left = `${lX}px`;
  handleR.style.left = `${rX}px`;

  shadeL.style.left = `0px`;
  shadeL.style.width = `${lX}px`;

  shadeR.style.left = `${rX}px`;
  shadeR.style.width = `calc(100% - ${rX}px)`;

  syncPlayhead();
}

function syncPlayhead(){
  const x = tToX(audio.currentTime || 0);
  playhead.style.left = `${x}px`;
}

function draw(){
  const rect = wave.getBoundingClientRect();
  const w = rect.width;
  const h = 120;

  // bg
  ctx.clearRect(0,0,w,h);

  // grid line
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.moveTo(0, h/2);
  ctx.lineTo(w, h/2);
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (!peaksBase || !duration){
    // placeholder
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#ffffff";
    ctx.font = "14px ui-sans-serif, system-ui";
    ctx.fillText("waveform will appear here", 12, 22);
    ctx.globalAlpha = 1;
    return;
  }

  // draw waveform from base peaks (normalized 0..1)
  // map viewport -> indices
  const n = peaksBase.length;
  const startIdx = Math.floor((view.start / duration) * n);
  const endIdx = Math.ceil(((view.start + view.span) / duration) * n);
  const s = clamp(startIdx, 0, n-1);
  const e = clamp(endIdx, s+1, n);

  const spanN = e - s;
  const step = spanN / w;

  // waveform
  for (let x=0; x<w; x++){
    const i0 = Math.floor(s + x*step);
    const i1 = Math.floor(s + (x+1)*step);
    let p = 0;
    for (let i=i0; i<=i1 && i<n; i++){
      if (peaksBase[i] > p) p = peaksBase[i];
    }
    const amp = p * (h*0.46);

    // selection tint: if x between handles, brighter
    const tAtX = xToT(x);
    const inSel = (tAtX >= selection.start && tAtX <= selection.end);
    ctx.globalAlpha = inSel ? 0.95 : 0.35;
    ctx.strokeStyle = inSel ? "#f2f4f8" : "#b9bfd0";

    ctx.beginPath();
    ctx.moveTo(x+0.5, (h/2) - amp);
    ctx.lineTo(x+0.5, (h/2) + amp);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // time ticks
  drawTicks(w,h);
}

function drawTicks(w,h){
  const secondsPerTick = pickTick();
  const first = Math.ceil(view.start / secondsPerTick) * secondsPerTick;
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.font = "11px ui-sans-serif, system-ui";
  for (let t=first; t<=view.start+view.span; t+=secondsPerTick){
    const x = tToX(t);
    ctx.beginPath();
    ctx.moveTo(x, h-18);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.globalAlpha = 0.30;
    ctx.fillText(fmtTime(t), x+3, h-6);
    ctx.globalAlpha = 0.22;
  }
  ctx.globalAlpha = 1;
}

function pickTick(){
  const span = view.span;
  if (span <= 12) return 1;
  if (span <= 25) return 2;
  if (span <= 45) return 5;
  if (span <= 90) return 10;
  return 30;
}

/* pointer interactions (touch-friendly) */
overlay.addEventListener("pointerdown", (e) => {
  if (!duration) return;
  overlay.setPointerCapture(e.pointerId);

  const x = e.clientX - overlay.getBoundingClientRect().left;
  const lX = tToX(selection.start);
  const rX = tToX(selection.end);

  const near = (a,b) => Math.abs(a-b) < 18;

  if (near(x,lX)) view.dragging = "L";
  else if (near(x,rX)) view.dragging = "R";
  else {
    // start scrub
    view.dragging = "SCRUB";
    view.scrubStartX = e.clientX;
    view.scrubStartView = view.start;

    // tap to jump playhead if not a swipe
    // we still do immediate seek for snappy feeling:
    const t = xToT(x);
    seekTo(t);
  }
});

overlay.addEventListener("pointermove", (e) => {
  if (!view.dragging) return;

  if (view.dragging === "L" || view.dragging === "R"){
    const x = e.clientX - overlay.getBoundingClientRect().left;
    const t = xToT(x);
    if (view.dragging === "L"){
      selection.start = clamp(t, 0, selection.end - 0.05);
      // keep cursor audible: snap playhead with handle when paused
      if (audio.paused) audio.currentTime = selection.start;
    } else {
      selection.end = clamp(t, selection.start + 0.05, duration);
      if (audio.paused) audio.currentTime = selection.end;
    }
    draw(); syncOverlay(); updateTimes();
    return;
  }

  if (view.dragging === "SCRUB"){
    const dx = e.clientX - view.scrubStartX;
    const rect = overlay.getBoundingClientRect();
    const frac = dx / rect.width;
    const shift = -frac * view.span; // swipe right moves earlier
    view.start = clamp(view.scrubStartView + shift, 0, Math.max(0, duration - view.span));
    draw(); syncOverlay();
  }
});

overlay.addEventListener("pointerup", () => {
  view.dragging = null;
});

/* decoding + peaks */
async function decodeAndBuildPeaks(file){
  // decode for export + analysis
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  const buf = await file.arrayBuffer();

  // decode can be slow for 2h, so update status
  setStatus("decoding audio…");
  decodedBuffer = await audioCtx.decodeAudioData(buf.slice(0));

  setStatus("building waveform…");
  peaksBase = buildPeaks(decodedBuffer, 12000); // ~12k bins is a good mobile compromise
}

function buildPeaks(buffer, bins){
  const ch = buffer.getChannelData(0);
  const n = ch.length;
  const step = Math.floor(n / bins);
  const peaks = new Float32Array(bins);
  for (let i=0; i<bins; i++){
    const start = i*step;
    const end = (i === bins-1) ? n : (i+1)*step;
    let p = 0;
    for (let j=start; j<end; j++){
      const v = Math.abs(ch[j]);
      if (v > p) p = v;
    }
    peaks[i] = p;
  }
  // normalize
  let max = 0;
  for (let i=0; i<bins; i++) if (peaks[i] > max) max = peaks[i];
  if (max > 0){
    for (let i=0; i<bins; i++) peaks[i] = peaks[i] / max;
  }
  return peaks;
}

/* clip list + export */
function renderClips(){
  clipsList.innerHTML = "";
  if (clips.length === 0){
    const empty = document.createElement("div");
    empty.className = "pill subtle";
    empty.textContent = "no clips yet. save one.";
    clipsList.appendChild(empty);
    return;
  }

  for (const c of clips){
    const card = document.createElement("div");
    card.className = "clip";

    const top = document.createElement("div");
    top.className = "clip-top";

    const left = document.createElement("div");
    left.innerHTML = `<div class="clip-name">${escapeHtml(c.name)}</div>
                      <div class="clip-time">${fmtTime(c.start)} → ${fmtTime(c.end)} (${fmtTime(c.end - c.start)})</div>`;

    const right = document.createElement("div");
    right.innerHTML = `<small>${new Date(c.createdAt).toLocaleString()}</small>`;

    top.appendChild(left);
    top.appendChild(right);

    const actions = document.createElement("div");
    actions.className = "clip-actions";

    const jump = mkBtn("jump", "ghost", () => {
      selection.start = c.start;
      selection.end = c.end;
      seekTo(c.start);
      fitSel.click();
      draw(); syncOverlay(); updateTimes();
    });

    const rename = mkBtn("rename", "ghost", () => {
      const n = prompt("clip name:", c.name);
      if (n && n.trim()){
        c.name = n.trim();
        renderClips();
      }
    });

    const exportBtn = mkBtn("export wav", "btn", async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = "exporting…";
      try{
        const blob = await exportWav(decodedBuffer, c.start, c.end);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${safeFileStem(fileName.textContent)} - ${safeFileStem(c.name)}.wav`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = "export wav";
      }
    });

    const del = mkBtn("delete", "ghost", () => {
      const idx = clips.findIndex(x => x.id === c.id);
      if (idx >= 0) clips.splice(idx, 1);
      renderClips();
    });
    del.style.borderColor = "rgba(255,77,109,.35)";
    del.style.color = "rgba(255,77,109,.95)";

    actions.append(jump, rename, exportBtn, del);

    card.append(top, actions);
    clipsList.appendChild(card);
  }
}

function mkBtn(text, cls, onClick){
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

function safeFileStem(s){
  return (s || "audio").replace(/\.[^/.]+$/,"").replace(/[^\w\s-]+/g,"").trim().slice(0,60) || "clip";
}

function escapeHtml(str){
  return (str || "").replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

/* wav export (pcm 16-bit) */
async function exportWav(buffer, startSec, endSec){
  const sr = buffer.sampleRate;
  const start = Math.floor(startSec * sr);
  const end = Math.floor(endSec * sr);
  const frames = Math.max(0, end - start);
  const channels = buffer.numberOfChannels;

  // interleave float samples
  const interleaved = new Float32Array(frames * channels);
  for (let ch=0; ch<channels; ch++){
    const data = buffer.getChannelData(ch).subarray(start, end);
    for (let i=0; i<frames; i++){
      interleaved[i*channels + ch] = data[i] || 0;
    }
  }
  return encodeWav(interleaved, { sampleRate: sr, channels });
}

function encodeWav(interleaved, { sampleRate, channels }){
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = interleaved.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // riff header
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");

  // fmt chunk
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);          // pcm chunk size
  view.setUint16(20, 1, true);           // audio format 1=pcm
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);          // bits

  // data chunk
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // pcm samples
  let offset = 44;
  for (let i=0; i<interleaved.length; i++){
    let s = clamp(interleaved[i], -1, 1);
    const v = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, v, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeStr(view, offset, str){
  for (let i=0; i<str.length; i++) view.setUint8(offset+i, str.charCodeAt(i));
}

/* "suggest a funny clip" heuristic
   - computes RMS energy envelope in 0.25s frames
   - scores windows by (high energy) + (high variance / burstiness)
   - picks a 25s window centered near best peak
*/
suggestBtn.addEventListener("click", async () => {
  if (!decodedBuffer) return;
  suggestBtn.disabled = true;
  const old = suggestBtn.textContent;
  suggestBtn.textContent = "scanning…";

  try{
    setStatus("analyzing for laughs…");
    const suggestion = findFunnyWindow(decodedBuffer);
    if (!suggestion){
      setStatus("couldn't find a strong moment, try zooming and clipping manually", "bad");
      return;
    }
    selection.start = suggestion.start;
    selection.end = suggestion.end;
    seekTo(selection.start);
    fitSel.click();
    draw(); syncOverlay(); updateTimes();
    setStatus(`suggested: ${fmtTime(selection.start)} → ${fmtTime(selection.end)} (${suggestion.note})`, "ok");
  } finally {
    suggestBtn.disabled = false;
    suggestBtn.textContent = old;
  }
});

function findFunnyWindow(buffer){
  const sr = buffer.sampleRate;
  const mono = buffer.getChannelData(0);
  const frameSec = 0.25;
  const hop = Math.floor(frameSec * sr);
  const totalFrames = Math.floor(mono.length / hop);

  if (totalFrames < 40) return null;

  // rms envelope
  const rms = new Float32Array(totalFrames);
  for (let f=0; f<totalFrames; f++){
    const start = f*hop;
    const end = Math.min(mono.length, start + hop);
    let sum = 0;
    for (let i=start; i<end; i++){
      const v = mono[i];
      sum += v*v;
    }
    rms[f] = Math.sqrt(sum / Math.max(1, end - start));
  }

  // normalize rms
  let max = 0;
  for (let i=0; i<rms.length; i++) if (rms[i] > max) max = rms[i];
  if (max > 0) for (let i=0; i<rms.length; i++) rms[i] /= max;

  // compute z-ish threshold to find energetic moments
  const mean = avg(rms);
  const sd = Math.sqrt(avg(rms.map(v => (v-mean)*(v-mean))));
  const thresh = clamp(mean + sd * 1.1, 0.18, 0.65);

  // score windows (25s) with burstiness
  const winSec = 25;
  const winFrames = Math.floor(winSec / frameSec);
  let best = { score: -Infinity, frame: 0, note: "" };

  for (let f=0; f<=totalFrames-winFrames; f++){
    // energy + variance + peak density above threshold
    let e = 0, e2 = 0, hot = 0, peak = 0;
    for (let j=0; j<winFrames; j++){
      const v = rms[f+j];
      e += v;
      e2 += v*v;
      if (v > thresh) hot++;
      if (v > peak) peak = v;
    }
    const m = e / winFrames;
    const varr = (e2 / winFrames) - m*m;
    const hotFrac = hot / winFrames;

    // a "laughy" window tends to have: high peak, decent mean, and lots of above-threshold bursts
    const score = (peak * 1.2) + (m * 0.9) + (Math.sqrt(Math.max(0, varr)) * 1.1) + (hotFrac * 0.8);

    if (score > best.score){
      best = {
        score,
        frame: f,
        note: `energy ${Math.round(peak*100)} / burst ${Math.round(hotFrac*100)}%`
      };
    }
  }

  const start = best.frame * frameSec;
  const end = start + winSec;

  // clamp + avoid extremely quiet files
  if (best.score < 0.7) return null;

  return {
    start: clamp(start, 0, Math.max(0, duration - 0.5)),
    end: clamp(end, 0.5, duration),
    note: best.note
  };
}

function avg(arr){
  let s = 0;
  for (let i=0; i<arr.length; i++) s += arr[i];
  return s / Math.max(1, arr.length);
}
