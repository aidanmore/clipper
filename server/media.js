import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { bounds } from './domain.js';
const inputPolicy = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mp3,wav,mov,ogg,flac,aac,matroska,webm,aiff,amr',
];
export function command(
  bin,
  args,
  { timeout = 180000, onChunk, maxOutput = 2 * 1024 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const parts = [];
    let size = 0,
      errorText = '',
      settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${bin} timed out.`));
    }, timeout);
    child.stdout.on('data', (chunk) => {
      if (onChunk) onChunk(chunk);
      else {
        size += chunk.length;
        if (size > maxOutput) {
          child.kill();
          finish(new Error('Media response too large.'));
        } else parts.push(chunk);
      }
    });
    child.stderr.on('data', (c) => {
      errorText = (errorText + c).slice(-1500);
    });
    child.on('error', (e) => finish(e));
    child.on('close', (code) =>
      finish(
        code === 0
          ? null
          : new Error(`Audio processing failed: ${errorText || bin + ' exited ' + code}`),
        Buffer.concat(parts),
      ),
    );
  });
}
export async function inspect(path, maxSeconds = 14400) {
  const meta = JSON.parse(
    (
      await command('ffprobe', [
        '-v',
        'error',
        ...inputPolicy,
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        path,
      ])
    ).toString(),
  );
  const stream = meta.streams?.find((s) => s.codec_type === 'audio');
  const duration = Number(meta.format?.duration || stream?.duration);
  if (!stream || !Number.isFinite(duration) || duration < 0.1 || duration > maxSeconds)
    throw new Error(`Choose a readable audio episode under ${maxSeconds / 3600} hours.`);
  const formats = String(meta.format?.format_name || '');
  const mime = formats.includes('mp3')
    ? 'audio/mpeg'
    : formats.includes('wav')
      ? 'audio/wav'
      : formats.includes('ogg')
        ? 'audio/ogg'
        : formats.includes('flac')
          ? 'audio/flac'
          : formats.includes('aac')
            ? 'audio/aac'
            : 'audio/mp4';
  return { duration, channels: stream.channels, sampleRate: Number(stream.sample_rate), mime };
}
export async function fingerprint(path) {
  const hash = createHash('sha256');
  for await (const c of createReadStream(path)) hash.update(c);
  return hash.digest('hex');
}
export async function envelope(path, duration, bins = 2400, start = 0) {
  const peaks = new Array(bins).fill(0);
  const count = new Uint32Array(bins);
  let offset = 0,
    carry = Buffer.alloc(0);
  // Low-rate analysis stream, all channels mixed. Never decode an entire episode into RAM.
  await command(
    'ffmpeg',
    [
      '-v',
      'error',
      ...inputPolicy,
      '-ss',
      String(start),
      '-i',
      path,
      '-t',
      String(duration),
      '-map',
      '0:a:0',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '2000',
      '-f',
      's16le',
      'pipe:1',
    ],
    {
      timeout: 600000,
      onChunk(chunk) {
        const data = Buffer.concat([carry, chunk]);
        const end = data.length - (data.length % 2);
        for (let i = 0; i < end; i += 2) {
          const bin = Math.min(bins - 1, Math.floor((offset++ / (duration * 2000)) * bins));
          peaks[bin] += Math.abs(data.readInt16LE(i)) / 32768;
          count[bin]++;
        }
        carry = data.subarray(end);
      },
    },
  );
  const values = peaks.map((p, i) => (count[i] ? p / count[i] : 0));
  const max = Math.max(...values, 0.001);
  return values.map((v) => Math.round(Math.sqrt(v / max) * 1000) / 1000);
}
export async function renderAudio(source, dest, clip, duration, format, options = {}) {
  const { start, end } = bounds(clip.start, clip.end, duration);
  const filters = [];
  if (options.normalize) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  if (options.fade)
    filters.push(
      'afade=t=in:st=0:d=0.008',
      `afade=t=out:st=${Math.max(0, end - start - 0.008)}:d=0.008`,
    );
  await command(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      ...inputPolicy,
      '-ss',
      String(start),
      '-i',
      source,
      '-t',
      String(end - start),
      '-map',
      '0:a:0',
      '-vn',
      '-map_metadata',
      '-1',
      ...(filters.length ? ['-af', filters.join(',')] : []),
      ...(options.sampleRate ? ['-ar', String(options.sampleRate)] : []),
      ...(format === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-b:a', '192k']),
      dest,
    ],
    { timeout: 600000 },
  );
}
