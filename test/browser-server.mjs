import { createApp, configuration } from '../server/index.js';
import { newProject } from '../server/domain.js';
import { command, envelope, fingerprint } from '../server/media.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dataDir = await mkdtemp(join(tmpdir(), 'clipper-browser-'));
const config = configuration({
  DATA_DIR: dataDir,
  CLIPPER_PASSWORD: 'browser-tests-only-password',
  SESSION_SECRET: 'browser-tests-only-session-secret-32-characters',
  PORT: '3199',
});
const service = await createApp(config);
const p = newProject({ title: 'Test episode — a good exchange' });
p.id = 'browser-fixture';
await mkdir(join(dataDir, p.id));
const path = join(dataDir, p.id, 'source');
await command('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=330:duration=90',
  '-ac',
  '2',
  '-f',
  'wav',
  path,
]);
p.duration = 90;
p.channels = 2;
p.mime = 'audio/wav';
p.importComplete = true;
p.status = 'ready';
p.envelope = await envelope(path, 90);
p.hash = await fingerprint(path);
p.words = Array.from({ length: 120 }, (_, i) => ({
  id: i,
  start: i * 0.7,
  end: i * 0.7 + 0.5,
  text: `word${i}${i % 12 === 11 ? '.' : ''}`,
  speaker: i < 60 ? 'A' : 'B',
}));
p.suggestions = [
  {
    id: 'candidate-a',
    title: 'The whole exchange',
    reason: 'An example complete exchange.',
    start: 10,
    end: 30,
    type: 'riff',
    variants: { short: { start: 15, end: 25 }, full: { start: 7, end: 34 } },
  },
];
service.store.save(p);
const server = service.app.listen(3199, '127.0.0.1', () => console.log('Browser fixture ready'));
process.on('SIGTERM', async () => {
  service.worker.stop();
  server.closeAllConnections();
  server.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
});
