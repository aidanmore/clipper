"use strict";

const Y5Censor = (() => {
  const el = (id) => document.getElementById("censor-" + id);
  const slotIds = ["sound-1", "sound-2", "sound-3"];
  const audio = el("source");
  const audition = el("audition");
  const canvas = el("wave");
  let episode = null;
  let edits = [];
  let editing = null;
  let available = [];
  let audioContext;
  let wave = null;
  let drag = null;
  let waveRequest = 0;
  let auditionRequest = 0;
  let auditionUrl;

  function status(text, error = false, id = "status") {
    el(id).textContent = text;
    el(id).dataset.error = error;
  }

  function readSaved(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { /* Edits are still available in this tab. */ }
  }

  function timestamp(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = (ms % 60000 / 1000).toFixed(3).padStart(6, "0");
    return minutes + ":" + seconds;
  }

  function milliseconds(text) {
    const parts = text.trim().split(":");
    if (parts.length > 3 || !/^\d+(?:\.\d{1,3})?$/.test(parts.at(-1)) ||
        parts.slice(0, -1).some((part) => !/^\d+$/.test(part))) return null;
    const ms = Math.round(parts.reduce((total, part) => total * 60 + Number(part), 0) * 1000);
    return Number.isSafeInteger(ms) ? ms : null;
  }

  function soundName(slot) {
    return slot === "bleep" ? "Bleep" :
      readSaved("y5yt-censor-sound-" + slot, "Sound " + slot.at(-1));
  }

  function showSounds() {
    const selected = el("sound").value;
    const custom = slotIds.map((id) => {
      const option = new Option(soundName(id), id);
      option.disabled = !available.includes(id);
      if (option.disabled) option.text += " (empty)";
      return option;
    });
    el("sound").replaceChildren(new Option("Bleep", "bleep"), ...custom);
    el("sound").value = available.includes(selected) ? selected : "bleep";
  }

  function editKey() { return "y5yt-censor-edits-" + episode.guid; }

  function resetAudition() {
    auditionRequest++;
    audition.pause();
    audition.removeAttribute("src");
    audition.hidden = true;
    if (auditionUrl) URL.revokeObjectURL(auditionUrl);
    auditionUrl = null;
  }

  function setAudio() {
    if (!episode || audio.hasAttribute("src")) return;
    audio.src = "/api/audio?" + new URLSearchParams({ guid: episode.guid });
    audio.preload = "metadata";
    status("Loading episode audio…");
  }

  function select(next, companion) {
    if (!companion) return;
    const enabled = Boolean(next.audio && companion.ffmpeg);
    el("panel").hidden = !enabled;
    episode = enabled ? next : null;
    waveRequest++;
    wave = drag = editing = null;
    audio.removeAttribute("src");
    audio.load();
    resetAudition();
    el("wave-area").hidden = true;
    el("position").value = timestamp(0);
    el("start").value = el("end").value = "";
    edits = episode ? readSaved(editKey(), []) : [];
    available = [...new Set([...(companion.sounds || []), ...available])];
    showSounds();
    status("");
    showEdits();
    if (el("panel").open) setAudio();
  }

  async function post(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Y5YT": "1" },
      body: JSON.stringify({ guid: episode.guid, ...payload }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The local preview failed.");
    return response;
  }

  function draw() {
    if (!wave || canvas.clientWidth === 0) return;
    const width = canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
    const height = canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0c0c0a";
    ctx.fillRect(0, 0, width, height);
    const start = milliseconds(el("start").value);
    const end = milliseconds(el("end").value);
    const xFor = (time) => (time - wave.start) / (wave.end - wave.start) * width;
    if (start !== null && end > start) {
      ctx.fillStyle = "#f7e66144";
      ctx.fillRect(xFor(start), 0, xFor(end) - xFor(start), height);
    }
    const cursor = milliseconds(el("position").value);
    if (cursor !== null) {
      ctx.fillStyle = "#f7e661";
      ctx.fillRect(xFor(cursor), 0, Math.max(1, devicePixelRatio), height);
    }
    ctx.strokeStyle = "#d5d0be";
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      const first = Math.floor(x * wave.samples.length / width);
      const last = Math.max(first + 1, Math.floor((x + 1) * wave.samples.length / width));
      let min = 0, max = 0;
      for (let i = first; i < last; i++) {
        min = Math.min(min, wave.samples[i]);
        max = Math.max(max, wave.samples[i]);
      }
      ctx.moveTo(x + .5, (1 - max) * height / 2);
      ctx.lineTo(x + .5, (1 - min) * height / 2 + 1);
    }
    ctx.stroke();
  }

  async function zoom(center, seek = true) {
    if (!episode) return;
    if (center === null) {
      status("Enter a timestamp such as 12:34.500 or 754.500.", true);
      return;
    }
    const duration = Math.floor(audio.duration * 1000);
    if (Number.isFinite(duration) && center > duration) {
      status("That timestamp is past the end of the episode.", true);
      return;
    }
    el("position").value = timestamp(center);
    if (seek) {
      audio.pause();
      audio.currentTime = center / 1000;
    }
    resetAudition();
    const length = Number(el("zoom").value) * 1000;
    const start = Math.max(0, Number.isFinite(duration) ?
      Math.min(center - length / 2, duration - length) : center - length / 2);
    const requestId = ++waveRequest;
    status("Loading waveform…");
    try {
      const response = await post("/api/censor-preview", { start, end: start + length });
      audioContext ??= new AudioContext();
      const decoded = await audioContext.decodeAudioData(await response.arrayBuffer());
      if (requestId !== waveRequest) return;
      const end = start + Math.round(decoded.duration * 1000);
      wave = { start, end, samples: decoded.getChannelData(0) };
      el("wave-area").hidden = false;
      el("wave-start").textContent = timestamp(start);
      el("wave-end").textContent = timestamp(end);
      draw();
      status("");
    } catch (error) {
      if (requestId === waveRequest) status(error.message, true);
    }
  }

  function selection() {
    const start = milliseconds(el("start").value);
    const end = milliseconds(el("end").value);
    if (start === null || end === null || end - start < 20 || end - start > 10000) {
      throw new Error("Mark a start and end between 0.02 and 10 seconds apart.");
    }
    if (Number.isFinite(audio.duration) && end > Math.ceil(audio.duration * 1000)) {
      throw new Error("The edit ends past the episode audio.");
    }
    return { start, end, sound: el("sound").value };
  }

  async function preview(replace) {
    let edit;
    try { edit = selection(); }
    catch (error) { status(error.message, true); return; }
    audio.pause();
    resetAudition();
    const requestId = auditionRequest;
    status("Preparing the preview…");
    try {
      const response = await post("/api/censor-preview", {
        start: Math.max(0, edit.start - 850),
        end: edit.end + 850,
        edits: replace ? [edit] : [],
      });
      const file = await response.blob();
      if (requestId !== auditionRequest) return;
      auditionUrl = URL.createObjectURL(file);
      audition.src = auditionUrl;
      audition.hidden = false;
      status(replace ? "Replacement preview" : "Original preview");
      audition.play().catch(() => {});
    } catch (error) {
      if (requestId === auditionRequest) status(error.message, true);
    }
  }

  function showEdits() {
    el("count").textContent = edits.length ? "· " + edits.length + (edits.length === 1 ? " edit" : " edits") : "";
    el("add").textContent = editing ? "Update edit" : "Add edit";
    document.getElementById("render").textContent = edits.length ? "Render censored MP4" : "Render MP4";
    el("edits").replaceChildren(...edits.map((edit) => {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = timestamp(edit.start) + "–" + timestamp(edit.end) + " · " + soundName(edit.sound);
      const actions = document.createElement("div");
      actions.className = "actions";
      const adjust = document.createElement("button");
      adjust.type = "button";
      adjust.textContent = "Adjust";
      adjust.addEventListener("click", () => {
        editing = edit;
        el("start").value = timestamp(edit.start);
        el("end").value = timestamp(edit.end);
        el("sound").value = edit.sound;
        showEdits();
        zoom(Math.round((edit.start + edit.end) / 2));
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        edits = edits.filter((other) => other !== edit);
        if (editing === edit) editing = null;
        save(editKey(), edits);
        showEdits();
        status("Edit removed.");
      });
      actions.append(adjust, remove);
      row.append(label, actions);
      return row;
    }));
  }

  function add() {
    try {
      const edit = selection();
      const remaining = edits.filter((other) => other !== editing);
      if (remaining.length >= 200) throw new Error("Use at most 200 edits per episode.");
      if (remaining.some((other) => edit.start < other.end && edit.end > other.start)) {
        throw new Error("This selection overlaps a saved edit. Adjust or remove that edit first.");
      }
      if (edit.sound !== "bleep" && !available.includes(edit.sound)) throw new Error("Load that sound slot first.");
      const changed = Boolean(editing);
      edits = [...remaining, edit].sort((first, second) => first.start - second.start);
      editing = null;
      save(editKey(), edits);
      showEdits();
      status(changed ? "Edit updated." : "Edit added. It will be applied to the next render.");
    } catch (error) {
      status(error.message, true);
    }
  }

  function pointerTime(event) {
    const bounds = canvas.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    return wave.start + Math.round(fraction * (wave.end - wave.start));
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!wave || event.button !== 0 || !event.isPrimary) return;
    drag = pointerTime(event);
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (drag === null || !event.isPrimary) return;
    const time = pointerTime(event);
    el("start").value = timestamp(Math.min(drag, time));
    el("end").value = timestamp(Math.max(drag, time));
    draw();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (drag === null || !event.isPrimary) return;
    const time = pointerTime(event);
    if (Math.abs(time - drag) < 20) {
      el("position").value = timestamp(time);
      audio.currentTime = time / 1000;
    } else {
      el("start").value = timestamp(Math.min(drag, time));
      el("end").value = timestamp(Math.max(drag, time));
    }
    drag = null;
    draw();
  });
  canvas.addEventListener("lostpointercapture", () => { drag = null; });
  new ResizeObserver(draw).observe(canvas);

  el("panel").addEventListener("toggle", () => {
    if (el("panel").open) setAudio();
    else { audio.pause(); audition.pause(); }
  });
  audio.addEventListener("loadedmetadata", () => {
    if (el("status").textContent === "Loading episode audio…") status("");
  });
  audio.addEventListener("error", () => {
    if (audio.hasAttribute("src")) status("Couldn’t load the episode audio. Reopen Y5YT to retry.", true);
  });
  el("go").addEventListener("click", () => zoom(milliseconds(el("position").value)));
  el("position").addEventListener("keydown", (event) => {
    if (event.key === "Enter") zoom(milliseconds(el("position").value));
  });
  el("playhead").addEventListener("click", () => zoom(Math.round(audio.currentTime * 1000)));
  el("zoom").addEventListener("change", () => zoom(milliseconds(el("position").value)));
  for (const id of ["start", "end", "position"]) el(id).addEventListener("input", draw);
  el("original").addEventListener("click", () => preview(false));
  el("preview").addEventListener("click", () => preview(true));
  el("add").addEventListener("click", add);
  el("slot").replaceChildren(...slotIds.map((id) => new Option("Sound " + id.at(-1), id)));
  el("file").addEventListener("change", async () => {
    const file = el("file").files[0];
    if (!file) return;
    const slot = el("slot").value;
    el("file").disabled = true;
    status("Loading sound…", false, "sound-status");
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Choose an audio file under 8 MB.");
      const response = await fetch("/api/censor-sound?" + new URLSearchParams({ slot }), {
        method: "POST", headers: { "X-Y5YT": "1" }, body: file,
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Couldn’t load that sound.");
      save("y5yt-censor-sound-" + slot, file.name);
      if (!available.includes(slot)) available.push(slot);
      showSounds();
      el("sound").value = slot;
      showEdits();
      status("Sound " + slot.at(-1) + " loaded.", false, "sound-status");
    } catch (error) {
      status(error.message, true, "sound-status");
    } finally {
      el("file").value = "";
      el("file").disabled = false;
    }
  });

  return { select, edits: () => edits };
})();
