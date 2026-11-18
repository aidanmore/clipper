'use strict';
// Source objects contain the original MP3 bytes. Decoding happens in small windows
// and encoding in a worker, keeping hour-long episodes practical on a phone.
window.DirectExport = (() => {
  const manifests = new Map(), cache = new Map();
  const root = 'https://raw.githubusercontent.com/aidanmore/clipper/';
  function base(episode) {
    return root + 'clipper-audio-' + (parseInt(episode.key[0], 16) % 4) + '/' + episode.key + '/' + episode.fingerprint + '/';
  }
  async function get(url, signal) {
    const response = await fetch(url, {signal});
    if (!response.ok) {
      if (response.status === 404) throw new Error('This episode is still preparing for direct downloads. Try again shortly; no request or sign-in is needed.');
      throw new Error('Couldn’t download the audio (' + response.status + '). Check your connection and try again.');
    }
    return response;
  }
  async function manifest(episode, signal) {
    const url = base(episode) + 'manifest.json';
    if (!manifests.has(url)) {
      const data = await (await get(url, signal)).json();
      if (data.version !== 1 || data.fingerprint !== episode.fingerprint || !data.seek?.length || !data.chunkSize || !data.sampleRate) throw new Error('Audio source changed. Refresh the archive and try again.');
      manifests.set(url, data);
    }
    return manifests.get(url);
  }
  async function chunk(episode, number, info, signal) {
    const url = base(episode) + String(number).padStart(4, '0') + '.bin';
    if (cache.has(url)) return cache.get(url);
    const bytes = await (await get(url, signal)).arrayBuffer();
    const expected = Math.min(info.chunkSize, info.size - number * info.chunkSize);
    if (bytes.byteLength !== expected) throw new Error('The audio download was incomplete. Try again.');
    // A small LRU is enough for nearby clips, without accumulating whole episodes.
    cache.set(url, bytes);
    while (cache.size > 3) cache.delete(cache.keys().next().value);
    return bytes;
  }
  function range(info, start, end) {
    let first = 0, last = info.seek.length;
    // One second of preroll restores the MP3 bit reservoir before the kept audio.
    for (let i = 0; i < info.seek.length; i++) {
      if (info.seek[i][0] <= start - 1) first = i;
      if (info.seek[i][0] > end + .1) { last = i; break; }
    }
    return {time: first === 0 ? 0 : info.seek[first][0], from: first === 0 ? 0 : info.seek[first][1],
      to: last < info.seek.length ? info.seek[last][1] : info.size};
  }
  async function decode(episode, info, start, end, context, signal) {
    const section = range(info, start, end);
    const first = Math.floor(section.from / info.chunkSize), last = Math.floor((section.to - 1) / info.chunkSize);
    const data = new Uint8Array(section.to - section.from);
    for (let number = first; number <= last; number++) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await chunk(episode, number, info, signal));
      const origin = number * info.chunkSize;
      const lo = Math.max(section.from - origin, 0), hi = Math.min(section.to - origin, bytes.length);
      data.set(bytes.subarray(lo, hi), origin + lo - section.from);
    }
    signal.throwIfAborted();
    const buffer = await context.decodeAudioData(data.buffer);
    return {buffer, time: section.time};
  }
  function encodeWorker(signal) {
    const worker = new Worker('encode-worker.js?v=3');
    let pending;
    worker.onmessage = ({data}) => {
      if (!pending) return;
      const current = pending; pending = null;
      if (data.type === 'error') current.reject(new Error(data.message)); else current.resolve(data);
    };
    worker.onerror = () => { pending?.reject(new Error('The audio encoder couldn’t start. Refresh the page and try again.')); pending = null; };
    const stop = () => { worker.terminate(); pending?.reject(new DOMException('Cancelled', 'AbortError')); pending = null; };
    signal.addEventListener('abort', stop, {once: true});
    return {
      send(data, transfer = []) {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => { pending = {resolve, reject}; worker.postMessage(data, transfer); });
      },
      close() { signal.removeEventListener('abort', stop); worker.terminate(); }
    };
  }
  async function clip(episode, selection, {format = 'mp3', signal, progress = () => {}, localBuffer = null} = {}) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('This browser does not support audio editing. Open the clipper in Safari or Chrome.');
    signal ||= new AbortController().signal;
    const info = localBuffer ? null : await manifest(episode, signal);
    const sampleRate = localBuffer?.sampleRate || info.sampleRate;
    const context = new AudioCtx({sampleRate});
    const worker = encodeWorker(signal);
    try {
      await worker.send({type: 'start', sampleRate: context.sampleRate, channels: Math.min(2, localBuffer?.numberOfChannels || info.channels), format});
      const firstSample = Math.round(selection.start * context.sampleRate), lastSample = Math.round(selection.end * context.sampleRate);
      const step = context.sampleRate * 20;
      for (let at = firstSample; at < lastSample; at += step) {
        signal.throwIfAborted();
        const until = Math.min(at + step, lastSample), start = at / context.sampleRate, end = until / context.sampleRate;
        progress((at - firstSample) / (lastSample - firstSample), 'Loading selected audio…');
        const section = localBuffer ? {buffer: localBuffer, time: 0} : await decode(episode, info, start, end, context, signal);
        const offset = Math.round((start - section.time) * context.sampleRate), count = until - at;
        if (offset < 0 || offset + count > section.buffer.length + 2) throw new Error('Couldn’t read the complete selection. Try moving the end slightly earlier.');
        const pcm = Array.from({length: Math.min(2, section.buffer.numberOfChannels)}, (_, channel) => {
          const result = new Float32Array(count);
          result.set(section.buffer.getChannelData(channel).subarray(offset, offset + count));
          return result;
        });
        progress((at - firstSample) / (lastSample - firstSample), 'Making your ' + format.toUpperCase() + '…');
        await worker.send({type: 'pcm', pcm}, pcm.map(p => p.buffer));
      }
      signal.throwIfAborted();
      const result = await worker.send({type: 'finish'});
      progress(1, 'Ready to download');
      return result;
    } finally { worker.close(); await context.close().catch(() => {}); }
  }
  return {clip, manifest, range};
})();
