import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, configuration } from '../server/index.js';
import { command, inspect } from '../server/media.js';
import { Store } from '../server/store.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeAI = {
  async upload() {
    return 'https://provider.example/audio';
  },
  async submit() {
    return { id: 'provider-id' };
  },
  async poll() {
    return {
      status: 'completed',
      words: Array.from({ length: 40 }, (_, i) => ({
        start: i * 400,
        end: i * 400 + 300,
        text: `word${i}`,
        speaker: i < 20 ? 'A' : 'B',
      })),
    };
  },
  async moments() {
    return {
      request_id: 'mock-moments',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [
        {
          message: {
            content: JSON.stringify({
              moments: [
                {
                  firstWord: 0,
                  lastWord: 25,
                  title: 'The setup and payoff',
                  reason: 'Complete exchange',
                  score: 8,
                  short: null,
                  full: null,
                },
              ],
              chapters: [{ title: 'Opening', firstWord: 0 }],
            }),
          },
        },
      ],
    };
  },
  async rank(candidates) {
    return {
      choices: [{ message: { content: JSON.stringify({ ids: candidates.map((c) => c.id) }) } }],
    };
  },
};
async function fixture(t, ai = fakeAI) {
  const dir = await mkdtemp(join(tmpdir(), 'clipper-'));
  const config = configuration({
    DATA_DIR: dir,
    CLIPPER_PASSWORD: 'test-workspace-password',
    SESSION_SECRET: 's'.repeat(40),
    ASSEMBLYAI_API_KEY: 'test-not-real',
    PORT: '0',
  });
  const service = await createApp(config, { ai });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: config.password }),
  });
  const { token } = await response.json();
  const request = async (path, options = {}) =>
    fetch(base + path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
  const json = async (path, body, method = 'POST') => {
    const r = await request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  async function until(check) {
    for (let i = 0; i < 200; i++) {
      const result = await check();
      if (result) return result;
      await wait(100);
    }
    throw new Error('Timed out waiting for background task.');
  }
  t.after(async () => {
    service.worker.stop();
    await until(() => !service.worker.busy);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    service.store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { ...service, config, base, request, json, until, dir };
}
test('real stereo audio: upload → background import → transcript → moments → accurate audio + captions + bundle', async (t) => {
  const f = await fixture(t);
  const source = join(f.dir, 'fixture.wav');
  await command('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=18',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=18',
    '-filter_complex',
    '[0:a][1:a]amerge=inputs=2',
    '-c:a',
    'pcm_s16le',
    source,
  ]);
  const upload = await f.request('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'Stereo%20episode.wav' },
    body: await readFile(source),
  });
  assert.equal(upload.status, 201);
  const p = await upload.json();
  await f.until(() => f.store.get(p.id).status === 'ready');
  let project = f.store.get(p.id);
  assert.equal(project.channels, 2);
  assert.equal(project.envelope.length, 2400);
  assert.equal(project.hash.length, 64);
  const unauth = await fetch(f.base + '/api/projects');
  assert.equal(unauth.status, 401);
  const detail = await (await f.request(`/api/projects/${p.id}`)).json();
  const media = await fetch(f.base + detail.mediaUrl, { headers: { Range: 'bytes=0-100' } });
  assert.equal(media.status, 206);
  assert.equal((await media.arrayBuffer()).byteLength, 101);
  const denied = await fetch(f.base + `/media/${p.id}?ticket=bad`);
  assert.equal(denied.status, 401);
  const clip = { id: 'kept1', title: 'Good bit', start: 2, end: 7, note: 'keep', status: 'ready' };
  const edit = {
    editRevision: 0,
    title: 'My episode',
    clips: [clip],
    draft: clip,
    feedback: [],
    speakerNames: {},
    corrections: {},
    suggestionStates: {},
  };
  assert.equal((await f.json(`/api/projects/${p.id}`, edit, 'PATCH')).status, 200);
  assert.equal((await f.json(`/api/projects/${p.id}`, edit, 'PATCH')).status, 409);
  assert.equal((await f.json(`/api/projects/${p.id}/process`, {})).status, 200);
  await f.until(() => f.store.get(p.id).suggestions.length === 1);
  project = f.store.get(p.id);
  assert.equal(project.words.length, 40);
  assert.equal(project.suggestions[0].end, 10.55);
  assert.equal(f.store.usage().seconds, 18);
  assert.equal(f.store.usage().llmCalls, 1);
  const wave = await (await f.request(`/api/projects/${p.id}/waveform?start=2&end=5`)).json();
  assert.equal(wave.values.length, 1000);
  const bad = await f.json(`/api/projects/${p.id}/export`, {
    clips: [{ start: 0, end: 100 }],
    format: 'mp3',
  });
  assert.equal(bad.status, 400);
  const exp = await f.json(`/api/projects/${p.id}/export`, {
    clips: [clip],
    format: 'wav',
    options: {},
  });
  assert.equal(exp.status, 200);
  const done = await f.until(
    () => f.store.job(exp.body.id)?.state === 'done' && f.store.job(exp.body.id),
  );
  const meta = await inspect(done.output.path);
  assert.equal(meta.channels, 2);
  assert.ok(Math.abs(meta.duration - 5) < 0.02);
  const raw = await command('ffmpeg', [
    '-v',
    'error',
    '-i',
    done.output.path,
    '-f',
    's16le',
    'pipe:1',
  ]);
  let difference = 0;
  for (let i = 0; i < raw.length - 4; i += 4)
    difference += Math.abs(raw.readInt16LE(i) - raw.readInt16LE(i + 2));
  assert.ok(difference > 100000, 'channels must not be collapsed to first channel');
  const ticket = await (await f.request(`/api/projects/${p.id}/download/${done.id}`)).json();
  assert.equal((await fetch(f.base + ticket.url)).status, 200);
  const bundle = await f.json(`/api/projects/${p.id}/export`, {
    clips: [clip],
    format: 'bundle',
    options: { fade: true },
  });
  const zip = await f.until(
    () => f.store.job(bundle.body.id)?.state === 'done' && f.store.job(bundle.body.id),
  );
  const files = (await command('unzip', ['-l', zip.output.path])).toString();
  assert.match(files, /\.srt/);
  assert.match(files, /\.txt/);
  assert.match(files, /\.mp3/);
  const backup = await (await f.request(`/api/projects/${p.id}/backup`)).json();
  const restored = await f.json(`/api/projects/${p.id}/restore`, backup);
  assert.equal(restored.status, 200);
  assert.equal(f.store.get(p.id).suggestions.length, 1);
  backup.project.hash = 'wrong';
  assert.equal((await f.json(`/api/projects/${p.id}/restore`, backup)).status, 400);
  const cors = await fetch(f.base + '/api/config', { headers: { Origin: 'https://evil.example' } });
  assert.equal(cors.status, 403);
  assert.equal((await fetch(f.base + '/.env')).status, 404);
  assert.equal((await fetch(f.base + '/server/index.js')).status, 404);
});
test('uncertain AI submission never automatically resubmits; retry is explicit and reserves another allowance', async (t) => {
  let submissions = 0;
  const f = await fixture(t, {
    ...fakeAI,
    async submit() {
      submissions++;
      throw new Error('Connection lost after submission');
    },
  });
  const source = join(f.dir, 'short.wav');
  await command('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=8', source]);
  const r = await f.request('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: await readFile(source),
  });
  const p = await r.json();
  await f.until(() => f.store.get(p.id).duration > 0 && f.store.get(p.id).status === 'ready');
  await f.json(`/api/projects/${p.id}/process`, {});
  const failed = await f.until(() =>
    f.store.jobs(p.id).find((j) => j.type === 'transcribe' && j.state === 'failed'),
  );
  assert.equal(submissions, 1);
  assert.equal(f.store.get(p.id).submissionUncertain, true);
  assert.equal((await f.json(`/api/projects/${p.id}/jobs/${failed.id}/retry`, {})).status, 400);
});
test('database restart recovers queued work and retains project edits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clipper-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = new Store(dir);
  store.save({ id: 'one', sourceKey: '', revision: 0, title: 'Retained', clips: [{ id: 'clip' }] });
  const job = store.enqueue('one', 'export');
  store.jobSave(job, 'running');
  store.close();
  store = new Store(dir);
  assert.equal(store.get('one').clips.length, 1);
  assert.equal(store.next().id, job.id);
  store.close();
});
test('hour-long episode builds a waveform and exports a cut near its end without full-file PCM allocation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clipper-long-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'long.mp3'),
    out = join(dir, 'cut.wav');
  await command(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=22050:cl=stereo',
      '-t',
      '3605',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      source,
    ],
    { timeout: 180000 },
  );
  const meta = await inspect(source);
  assert.ok(meta.duration > 3600);
  assert.equal(meta.channels, 2);
  const { envelope, renderAudio } = await import('../server/media.js');
  const peaks = await envelope(source, meta.duration);
  assert.equal(peaks.length, 2400);
  assert.ok(peaks.every(Number.isFinite));
  await renderAudio(source, out, { start: 3598.25, end: 3600.75 }, meta.duration, 'wav');
  const cut = await inspect(out);
  assert.equal(cut.channels, 2);
  assert.ok(Math.abs(cut.duration - 2.5) < 0.02);
});

test('queued work can be cancelled without calling the provider', async (t) => {
  const f = await fixture(t);
  const p = {
    id: 'queued-only',
    sourceKey: '',
    revision: 0,
    editRevision: 0,
    title: 'Queued',
    duration: 20,
    status: 'ready',
    clips: [],
    words: [],
  };
  f.store.save(p);
  const job = f.store.enqueue(p.id, 'transcribe');
  const result = await f.json(`/api/projects/${p.id}/jobs/${job.id}/cancel`, {});
  assert.equal(result.status, 200);
  assert.equal(f.store.job(job.id).state, 'cancelled');
  assert.equal(f.store.usage().seconds, 0);
});
