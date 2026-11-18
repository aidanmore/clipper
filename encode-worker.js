'use strict';
importScripts('vendor/lame.min.js');
let encoder, parts, format, channels, sampleRate, samples;
function pcm16(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const value = Math.max(-1, Math.min(1, input[i]));
    output[i] = value < 0 ? value * 32768 : value * 32767;
  }
  return output;
}
function wavHeader(size) {
  const bytes = new ArrayBuffer(44), v = new DataView(bytes);
  const text = (at, value) => [...value].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); v.setUint32(4, 36 + size, true); text(8, 'WAVE'); text(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, size, true);
  return bytes;
}
self.onmessage = ({data}) => {
  try {
    if (data.type === 'start') {
      ({channels, sampleRate, format} = data); samples = 0; parts = [];
      encoder = format === 'mp3' ? new lamejs.Mp3Encoder(channels, sampleRate, 192) : null;
    } else if (data.type === 'pcm') {
      const left = pcm16(data.pcm[0]), right = channels === 2 ? pcm16(data.pcm[1]) : left;
      samples += left.length;
      if (format === 'mp3') {
        for (let at = 0; at < left.length; at += 1152) {
          const encoded = encoder.encodeBuffer(left.subarray(at, at + 1152), right.subarray(at, at + 1152));
          if (encoded.length) parts.push(new Uint8Array(encoded));
        }
      } else {
        const bytes = new ArrayBuffer(left.length * channels * 2), v = new DataView(bytes);
        for (let i = 0, at = 0; i < left.length; i++) {
          v.setInt16(at, left[i], true); at += 2;
          if (channels === 2) { v.setInt16(at, right[i], true); at += 2; }
        }
        parts.push(bytes);
      }
    } else if (data.type === 'finish') {
      if (encoder) { const tail = encoder.flush(); if (tail.length) parts.push(new Uint8Array(tail)); }
      else parts.unshift(wavHeader(samples * channels * 2));
      const blob = new Blob(parts, {type: encoder ? 'audio/mpeg' : 'audio/wav'});
      postMessage({type: 'done', blob, samples, sampleRate, channels});
      parts = []; encoder = null; return;
    }
    postMessage({type: 'ack'});
  } catch (error) { postMessage({type: 'error', message: error.message}); }
};
