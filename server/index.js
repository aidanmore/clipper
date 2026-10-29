import express from 'express';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, rm, stat, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store } from './store.js';
import { envelope } from './media.js';
import { AssemblyAI } from './ai.js';
import { createWorker } from './worker.js';
import { remoteUrl, remoteText, parseFeed } from './network.js';
import { fail, text, newProject, bounds } from './domain.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function configuration(env = process.env) {
  const number = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  return {
    dataDir: resolve(env.DATA_DIR || join(root, 'data')),
    port: number('PORT', 3000, 0, 65535),
    password: env.CLIPPER_PASSWORD || '',
    trustProxy: env.TRUST_PROXY === '1',
    secret: env.SESSION_SECRET || '',
    apiKey: env.ASSEMBLYAI_API_KEY || '',
    speechModel: env.SPEECH_MODEL || 'universal-3-5-pro',
    llmModel: env.LLM_MODEL || 'gemini-2.5-flash',
    feedUrl: env.PODCAST_FEED_URL || 'https://anchor.fm/s/1014cea94/podcast/rss',
    origins: (env.ALLOWED_ORIGINS || 'https://aidanmore.github.io')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxBytes: number('MAX_FILE_MB', 600, 1, 4000) * 1024 * 1024,
    maxSeconds: number('MAX_EPISODE_HOURS', 4, 0.01, 24) * 3600,
    maxStorage: number('MAX_STORAGE_GB', 4, 0.01, 1000) * 1024 ** 3,
    monthlyAudioHours: number('MONTHLY_AUDIO_HOURS', 10, 0, 10000),
    monthlyLlmCalls: number('MONTHLY_LLM_CALLS', 200, 0, 100000),
  };
}
function equal(a, b) {
  const hash = (v) => createHash('sha256').update(String(v)).digest();
  return timingSafeEqual(hash(a), hash(b));
}
export function sign(config, scope, lifetime = 604800) {
  const body = Buffer.from(
    JSON.stringify({ scope, exp: Math.floor(Date.now() / 1000) + lifetime }),
  ).toString('base64url');
  return `${body}.${createHmac('sha256', config.secret).update(body).digest('base64url')}`;
}
export function verify(config, token, scope) {
  try {
    const [body, signature, extra] = String(token || '').split('.');
    if (
      extra ||
      !signature ||
      !equal(signature, createHmac('sha256', config.secret).update(body).digest('base64url'))
    )
      return false;
    const doc = JSON.parse(Buffer.from(body, 'base64url'));
    return doc.scope === scope && Number.isFinite(doc.exp) && doc.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}
function edits(body, p) {
  if (!Array.isArray(body.clips) || body.clips.length > 200) fail('Invalid clip list.');
  const ids = new Set();
  const clips = body.clips.map((c) => {
    const id = text(c.id, 100);
    if (!id || ids.has(id)) fail('Clip IDs must be unique.');
    ids.add(id);
    return {
      id,
      ...bounds(c.start, c.end, p.duration),
      title: text(c.title, 140) || 'Untitled clip',
      note: text(c.note, 2000),
      status: ['draft', 'ready', 'exported'].includes(c.status) ? c.status : 'draft',
      exportedAt: text(c.exportedAt, 50),
    };
  });
  const speakerNames = {},
    corrections = {};
  for (const [k, v] of Object.entries(body.speakerNames || {}))
    if (k.length < 21) speakerNames[k] = text(v, 80);
  for (const [k, v] of Object.entries(body.corrections || {}))
    if (/^\d+$/.test(k) && p.words.some((w) => String(w.id) === k)) corrections[k] = text(v, 300);
  const suggestionStates = {};
  for (const [k, v] of Object.entries(body.suggestionStates || {}))
    if (['kept', 'skipped'].includes(v)) suggestionStates[k] = v;
  const feedback = (Array.isArray(body.feedback) ? body.feedback : []).slice(-60).map((f) => ({
    title: text(f.title, 140),
    excerpt: text(f.excerpt, 1000),
    decision: text(f.decision, 20),
    note: text(f.note, 300),
  }));
  const draft = body.draft
    ? {
        id: text(body.draft.id, 100) || randomUUID(),
        title: text(body.draft.title, 140),
        note: text(body.draft.note, 2000),
        ...bounds(body.draft.start, body.draft.end, p.duration),
      }
    : null;
  return {
    draft,
    clips,
    speakerNames,
    corrections,
    suggestionStates,
    feedback,
    title: text(body.title) || p.title,
    playback: Math.max(0, Math.min(p.duration, Number(body.playback) || 0)),
  };
}
function view(p) {
  const { providerUpload, submissionUncertain, ...publicProject } = p;
  return publicProject;
}
export async function createApp(config = configuration(), { ai, startWorker = true } = {}) {
  if (config.password.length < 16 || config.secret.length < 32)
    throw new Error(
      'Set CLIPPER_PASSWORD (16+ characters) and SESSION_SECRET (32+ characters). No default credentials are accepted.',
    );
  await mkdir(config.dataDir, { recursive: true });
  const store = new Store(config.dataDir),
    worker = createWorker(store, config, ai || new AssemblyAI(config));
  if (!startWorker) worker.stop();
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=()',
    });
    const origin = req.get('origin');
    const own = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== own && !config.origins.includes(origin))
      return res.status(403).json({ error: 'This origin is not allowed.' });
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
    }
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.path.startsWith('/api/') || req.path.startsWith('/media/'))
      res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/health', (req, res) => res.json({ ok: true, version: '2.0.0' }));
  const attempts = new Map();
  app.post('/api/login', express.json({ limit: '2kb' }), (req, res) => {
    const key = req.ip,
      now = Date.now(),
      previous = attempts.get(key);
    const count = previous && now - previous.start < 900000 ? previous : { start: now, n: 0 };
    if (++count.n > 20) fail('Too many attempts. Try again in 15 minutes.', 429);
    attempts.set(key, count);
    for (const [ip, data] of attempts) if (now - data.start > 900000) attempts.delete(ip);
    if (!equal(req.body?.password, config.password)) fail('Incorrect workspace password.', 401);
    attempts.delete(key);
    res.json({ token: sign(config, 'workspace') });
  });
  app.use('/api', (req, res, next) => {
    if (!verify(config, req.get('authorization')?.replace(/^Bearer /, ''), 'workspace'))
      fail('Sign in to your workspace.', 401);
    next();
  });
  app.use('/api', express.json({ limit: '16mb' }));
  app.get('/api/config', (req, res) =>
    res.json({
      aiReady: !!config.apiKey,
      feedUrl: config.feedUrl,
      limits: {
        maxFileMB: config.maxBytes / 1024 ** 2,
        maxEpisodeHours: config.maxSeconds / 3600,
        monthlyAudioHours: config.monthlyAudioHours,
        monthlyLlmCalls: config.monthlyLlmCalls,
        maxStorageGB: config.maxStorage / 1024 ** 3,
      },
      usage: store.usage(),
      llmModel: config.llmModel,
    }),
  );
  let feedCache;
  app.get('/api/feed', async (req, res) => {
    const url = remoteUrl(req.query.url || config.feedUrl).href;
    if (feedCache?.url === url && Date.now() - feedCache.at < 600000)
      return res.json(feedCache.result);
    const result = parseFeed(await remoteText(url), url);
    feedCache = { url, result, at: Date.now() };
    res.json(result);
  });
  app.get('/api/projects', (req, res) =>
    res.json(
      store.all().map((p) => ({
        id: p.id,
        title: p.title,
        duration: p.duration,
        artwork: p.artwork,
        status: p.status,
        error: p.error,
        clipCount: p.clips.length,
        updatedAt: p.updatedAt,
      })),
    ),
  );
  let reservedUploads = 0;
  const storage = async () => {
    let total = 0;
    async function sum(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await sum(path);
        else if (entry.isFile()) total += (await stat(path)).size;
      }
    }
    await sum(config.dataDir);
    return total;
  };
  function exportSize(payload, p) {
    const seconds = payload.clips.reduce((sum, c) => sum + c.end - c.start, 0);
    const rate =
      payload.format === 'wav'
        ? Math.max(48000, p.sampleRate || 48000) * Math.max(2, p.channels || 2) * 2
        : 30000;
    return seconds * rate * (payload.clips.length > 1 || payload.format === 'bundle' ? 2 : 1);
  }
  async function reserveSpace(bytes) {
    const used = await storage();
    const projects = store.all();
    const reserved =
      projects.filter((p) => !p.importComplete).length * config.maxBytes +
      projects.reduce(
        (sum, p) =>
          sum +
          store
            .jobs(p.id)
            .filter((j) => j.type === 'export' && ['queued', 'running'].includes(j.state))
            .reduce((n, j) => n + exportSize(j.payload, p), 0),
        0,
      );
    if (used + reserved + reservedUploads + bytes > config.maxStorage)
      fail('Workspace storage is nearly full. Delete old projects or increase the limit.', 413);
  }
  app.get('/api/storage', async (req, res) =>
    res.json({ bytes: await storage(), maxBytes: config.maxStorage }),
  );
  app.post('/api/projects', async (req, res) => {
    const url = remoteUrl(req.body?.sourceUrl).href;
    const key = text(req.body.sourceKey || url, 4000);
    const existing = store.findSource(key);
    if (existing) return res.json(view(existing));
    await reserveSpace(config.maxBytes);
    const p = newProject({ ...req.body, sourceUrl: url, sourceKey: key });
    store.save(p);
    store.enqueue(p.id, 'import', { analyze: req.body.analyze === true });
    res.status(201).json(view(p));
  });
  // Upload raw bytes, not base64 or a whole-file in-memory parser.
  app.post('/api/upload', async (req, res) => {
    await reserveSpace(config.maxBytes);
    reservedUploads += config.maxBytes;
    const p = newProject({
      title: text(
        req.get('x-file-name')
          ? decodeURIComponent(req.get('x-file-name'))
          : 'Unreleased recording',
      ),
    });
    const dir = join(config.dataDir, p.id);
    await mkdir(dir, { recursive: true });
    let bytes = 0;
    try {
      await pipeline(
        req,
        new Transform({
          transform(chunk, enc, cb) {
            bytes += chunk.length;
            cb(bytes > config.maxBytes ? new Error('File exceeds the upload limit.') : null, chunk);
          },
        }),
        createWriteStream(join(dir, 'source')),
      );
      if (!bytes) fail('Choose a nonempty audio file.');
      store.save(p);
      store.enqueue(p.id, 'import', { analyze: req.query.analyze === 'true' });
      res.status(201).json(view(p));
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    } finally {
      reservedUploads -= config.maxBytes;
    }
  });
  app.get('/api/projects/:id/status', (req, res) => {
    const p = store.get(req.params.id);
    res.json({
      revision: p.revision,
      editRevision: p.editRevision,
      status: p.status,
      error: p.error,
      jobs: store.jobs(p.id).map(({ output, ...j }) => ({ ...j, downloadReady: !!output })),
    });
  });
  app.get('/api/projects/:id', (req, res) => {
    const p = store.get(req.params.id);
    res.json({
      ...view(p),
      mediaUrl: `/media/${p.id}?ticket=${sign(config, `media:${p.id}`, 43200)}`,
      jobs: store.jobs(p.id).map(({ output, ...j }) => ({ ...j, downloadReady: !!output })),
    });
  });
  app.get('/api/projects/:id/waveform', async (req, res) => {
    const p = store.get(req.params.id),
      b = bounds(req.query.start, req.query.end, p.duration);
    if (b.end - b.start > 300) fail('Detailed waveform windows are limited to five minutes.');
    res.json({ values: await envelope(worker.source(p.id), b.end - b.start, 1000, b.start) });
  });
  app.patch('/api/projects/:id', (req, res) => {
    const p = store.get(req.params.id);
    if (req.body.editRevision !== p.editRevision)
      fail('This project changed on another device. Reload it before saving.', 409);
    Object.assign(p, edits(req.body, p));
    p.editRevision++;
    store.save(p);
    res.json({ editRevision: p.editRevision });
  });
  app.post('/api/projects/:id/process', (req, res) => {
    const p = store.get(req.params.id);
    if (!p.duration) fail('Wait for the audio import to finish.');
    const active = store
      .jobs(p.id)
      .find(
        (j) =>
          ['analyze', 'search', 'transcribe'].includes(j.type) &&
          ['queued', 'running'].includes(j.state),
      );
    if (active) return res.json(active);
    res.json(store.enqueue(p.id, p.words.length ? 'analyze' : 'transcribe'));
  });
  app.post('/api/projects/:id/search', (req, res) => {
    const p = store.get(req.params.id);
    if (!p.words.length) fail('Transcribe this episode before searching by description.');
    const query = text(req.body.query, 600);
    if (!query) fail('Describe the moment you want to find.');
    res.json(store.enqueue(p.id, 'search', { query }));
  });
  app.post('/api/projects/:id/recover-transcript', (req, res) => {
    if (
      store
        .jobs(req.params.id)
        .some((j) => j.type === 'transcribe' && ['queued', 'running'].includes(j.state))
    )
      fail('Wait for the active transcription task before recovering another one.');
    const id = text(req.body.transcriptId, 100);
    if (!/^[a-zA-Z0-9-]+$/.test(id)) fail('Enter a valid AssemblyAI transcript ID.');
    store.update(req.params.id, (p) => {
      p.transcriptId = id;
      p.submissionUncertain = false;
    });
    res.json(store.enqueue(req.params.id, 'transcribe'));
  });
  app.post('/api/projects/:id/jobs/:jobId/cancel', (req, res) => {
    const j = store.job(req.params.jobId);
    if (!j || j.projectId !== req.params.id || !['running', 'queued'].includes(j.state))
      fail('No active task to cancel.');
    j.cancelRequested = true;
    store.jobSave(j, j.state === 'queued' ? 'cancelled' : 'running');
    if (j.state === 'queued' && !['export', 'search'].includes(j.type))
      store.update(j.projectId, (p) => {
        p.status = p.duration ? 'ready' : 'error';
        p.error = '';
      });
    res.json({ ok: true });
  });
  app.post('/api/projects/:id/jobs/:jobId/retry', (req, res) => {
    const j = store.job(req.params.jobId);
    if (!j || j.projectId !== req.params.id || j.state !== 'failed')
      fail('No failed task to retry.');
    if (['transcribe', 'analyze', 'search'].includes(j.type) && req.body.confirm !== true)
      fail('Confirm retrying this AI task. An interrupted request may already have been billed.');
    if (j.type === 'transcribe')
      store.update(j.projectId, (p) => {
        if (p.submissionUncertain || p.transcriptFailed)
          p.submissionAttempt = (p.submissionAttempt || 0) + 1;
        if (p.transcriptFailed) {
          p.transcriptId = '';
          p.transcriptFailed = false;
        }
        p.submissionUncertain = false;
      });
    j.attempt = (j.attempt || 0) + 1;
    j.inFlight = null;
    j.cancelRequested = false;
    j.createdAt = new Date().toISOString();
    j.error = '';
    store.jobSave(j, 'queued');
    res.json({ ok: true });
  });
  app.post('/api/projects/:id/export', async (req, res) => {
    const p = store.get(req.params.id);
    if (!p.duration) fail('Wait for the audio import.');
    const format = req.body.format;
    if (!['mp3', 'wav', 'srt', 'txt', 'bundle'].includes(format))
      fail('Unsupported export format.');
    if (p.channels > 2 && ['mp3', 'bundle'].includes(format))
      fail('MP3 supports at most two channels. Choose WAV to preserve this recording’s channels.');
    const input = req.body.clips;
    if (!Array.isArray(input) || !input.length || input.length > 50) fail('Select 1–50 clips.');
    if (['srt', 'txt'].includes(format) && !p.words.length)
      fail('This episode has no transcript yet.');
    const clips = input.map((c) => ({
      ...bounds(c.start, c.end, p.duration),
      id: text(c.id, 100),
      title: text(c.title, 140) || 'Clip',
    }));
    await reserveSpace(exportSize({ clips, format }, p));
    res.json(
      store.enqueue(p.id, 'export', {
        clips,
        format,
        options: {
          fade: req.body.options?.fade === true,
          normalize: req.body.options?.normalize === true,
          sampleRate: p.sampleRate,
        },
      }),
    );
  });
  app.get('/api/projects/:id/download/:jobId', (req, res) => {
    const j = store.job(req.params.jobId);
    if (!j || j.projectId !== req.params.id || j.state !== 'done' || !j.output)
      fail('Export is not ready.', 404);
    res.json({
      url: `/download/${j.id}?ticket=${sign(config, `download:${j.id}`, 900)}`,
      name: j.output.name,
    });
  });
  app.get('/api/projects/:id/backup', (req, res) =>
    res.json({ schema: 2, project: view(store.get(req.params.id)) }),
  );
  app.post('/api/projects/:id/restore', (req, res) => {
    const p = store.get(req.params.id),
      backup = req.body.project;
    if (req.body.schema !== 2 || !backup || !p.hash || backup.hash !== p.hash)
      fail('This backup belongs to a different audio file. Import the original recording first.');
    const words = backup.words;
    if (
      !Array.isArray(words) ||
      words.length > 100000 ||
      words.some(
        (w, i) =>
          w.id !== i ||
          !Number.isFinite(w.start) ||
          !Number.isFinite(w.end) ||
          w.start < 0 ||
          w.end <= w.start ||
          w.end > p.duration,
      )
    )
      fail('Invalid backup transcript.');
    p.words = words.map((w) => ({
      id: w.id,
      text: text(w.text, 300),
      speaker: text(w.speaker, 20),
      start: w.start,
      end: w.end,
    }));
    Object.assign(p, edits(backup, p));
    if (!Array.isArray(backup.suggestions) || backup.suggestions.length > 1000)
      fail('Invalid backup suggestions.');
    p.suggestions = backup.suggestions.map((c) => {
      const variants = {};
      for (const key of ['short', 'full'])
        if (c.variants?.[key])
          variants[key] = bounds(c.variants[key].start, c.variants[key].end, p.duration);
      return {
        id: text(c.id, 100) || randomUUID(),
        ...bounds(c.start, c.end, p.duration),
        title: text(c.title, 140),
        reason: text(c.reason, 600),
        context: text(c.context, 300),
        type: text(c.type, 40),
        score: Number(c.score) || 0,
        variants,
      };
    });
    if (new Set(p.suggestions.map((c) => c.id)).size !== p.suggestions.length)
      fail('Duplicate backup suggestion IDs.');
    p.chapters = (Array.isArray(backup.chapters) ? backup.chapters : [])
      .slice(0, 500)
      .filter((c) => Number.isFinite(c.start) && c.start >= 0 && c.start <= p.duration)
      .map((c) => ({ title: text(c.title, 140), start: c.start }));
    p.editRevision++;
    store.save(p);
    res.json(view(p));
  });
  app.delete('/api/projects/:id/exports', async (req, res) => {
    store.get(req.params.id);
    if (
      store
        .jobs(req.params.id)
        .some((j) => j.type === 'export' && ['running', 'queued'].includes(j.state))
    )
      fail('Wait for exports to finish.');
    await rm(join(config.dataDir, req.params.id, 'exports'), { recursive: true, force: true });
    for (const j of store.jobs(req.params.id).filter((j) => j.type === 'export')) {
      delete j.output;
      store.jobSave(j, j.state);
    }
    res.json({ ok: true });
  });
  app.delete('/api/projects/:id', async (req, res) => {
    store.get(req.params.id);
    if (store.jobs(req.params.id).some((j) => ['queued', 'running'].includes(j.state)))
      fail('Wait for processing to finish before deleting this project.');
    await rm(join(config.dataDir, req.params.id), { recursive: true, force: true });
    store.remove(req.params.id);
    res.json({ ok: true });
  });
  app.get('/media/:id', (req, res) => {
    if (!verify(config, req.query.ticket, `media:${req.params.id}`))
      fail('Playback link expired. Reopen the project.', 401);
    const p = store.get(req.params.id);
    if (!p.importComplete) fail('Audio is still importing.', 409);
    res.type(p.mime || 'audio/mpeg').sendFile(worker.source(p.id));
  });
  app.get('/download/:id', (req, res) => {
    if (!verify(config, req.query.ticket, `download:${req.params.id}`))
      fail('Download link expired. Request another download.', 401);
    const job = store.job(req.params.id);
    if (!job?.output || job.state !== 'done') fail('Export not found.', 404);
    res.download(job.output.path, job.output.name);
  });
  for (const file of ['index.html', 'app.js', 'styles.css', 'pcrp.ico'])
    app.get(file === 'index.html' ? '/' : `/${file}`, (req, res) => res.sendFile(join(root, file)));
  app.use('/legacy', express.static(join(root, 'legacy')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({
      error: error.status
        ? error.message
        : 'Operation failed. Check the source and server configuration, then retry.',
    });
    if (!error.status) console.error(error.message);
  });
  return {
    app,
    store,
    worker,
    close: () => {
      worker.stop();
      store.close();
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configuration();
  const { app, worker, store } = await createApp(config);
  const server = app.listen(config.port, '0.0.0.0', () =>
    console.log(`Clipper listening on port ${server.address().port}`),
  );
  server.requestTimeout = 15 * 60 * 1000;
  async function shutdown() {
    worker.stop();
    server.close();
    const deadline = Date.now() + 10000;
    while (worker.busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!worker.busy) store.close();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
