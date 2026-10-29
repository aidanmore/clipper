import { join } from 'node:path';
import { mkdir, stat, rm, writeFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import { download } from './network.js';
import { inspect, envelope, fingerprint, renderAudio } from './media.js';
import {
  normalizeWords,
  wordChunks,
  candidatesFromIds,
  uniqueCandidates,
  clipText,
  srt,
  safeName,
  text,
} from './domain.js';
import { parseCompletion } from './ai.js';
export function createWorker(store, config, ai) {
  let busy = false,
    stopping = false;
  const source = (id) => join(config.dataDir, id, 'source');
  function checkCancelled(job) {
    const latest = store.job(job.id);
    if (!latest || latest.cancelRequested || latest.state === 'cancelled')
      throw Object.assign(new Error('Cancelled after the current step.'), { cancelled: true });
  }
  function progress(job, status) {
    checkCancelled(job);
    job.progress = status;
    store.jobSave(job, 'running');
    if (job.type !== 'export' && job.type !== 'search')
      store.update(job.projectId, (p) => {
        p.status = status;
        p.error = '';
      });
  }
  async function aiCall(job, key, call) {
    if (job.inFlight)
      throw new Error(
        'An AI request was interrupted after submission. Retry explicitly; the provider may already have billed it.',
      );
    const usageId = `${job.id}:${key}:${job.attempt || 0}`;
    store.llmReserve(usageId, config.monthlyLlmCalls);
    job.inFlight = usageId;
    store.jobSave(job, 'running');
    const result = await call();
    store.llmUsage(usageId, result.usage);
    checkCancelled(job);
    job.lastRequestId = result.request_id || result.id;
    const parsed = parseCompletion(result);
    job.inFlight = null;
    return parsed;
  }
  async function perform(job) {
    let p = store.get(job.projectId);
    const dir = join(config.dataDir, p.id);
    await mkdir(dir, { recursive: true });
    if (job.type === 'import') {
      progress(job, 'importing');
      if (p.sourceUrl && !p.importComplete) {
        const part = join(dir, 'source.part');
        await download(p.sourceUrl, part, config.maxBytes);
        await rename(part, source(p.id));
      }
      const metadata = await inspect(source(p.id), config.maxSeconds);
      store.update(p.id, (doc) => {
        Object.assign(doc, metadata);
        doc.importComplete = true;
      });
      progress(job, 'building waveform');
      const [peaks, hash, info] = await Promise.all([
        envelope(source(p.id), metadata.duration),
        fingerprint(source(p.id)),
        stat(source(p.id)),
      ]);
      store.update(p.id, (doc) =>
        Object.assign(doc, metadata, {
          envelope: peaks,
          hash,
          bytes: info.size,
          status: 'ready',
          error: '',
        }),
      );
      checkCancelled(job);
      if (job.payload.analyze) store.enqueue(p.id, 'transcribe');
    } else if (job.type === 'transcribe') {
      if (!p.duration) throw new Error('Finish importing this episode first.');
      if (p.words.length) {
        store.enqueue(p.id, 'analyze');
        return;
      }
      if (!config.apiKey)
        throw new Error(
          'Add ASSEMBLYAI_API_KEY to the server. You can already edit and export manually.',
        );
      if (!p.transcriptId) {
        if (p.submissionUncertain)
          throw new Error(
            'Transcription submission was interrupted. Recover the transcript ID from AssemblyAI or explicitly authorize another submission in Retry.',
          );
        store.reserve(
          `transcribe:${p.id}:${p.submissionAttempt || 0}`,
          p.duration,
          config.monthlyAudioHours,
        );
        progress(job, 'uploading for transcription');
        if (!p.providerUpload) {
          const url = await ai.upload(source(p.id));
          p = store.update(p.id, (doc) => {
            doc.providerUpload = url;
          });
        }
        checkCancelled(job);
        store.update(p.id, (doc) => {
          doc.submissionUncertain = true;
        });
        const result = await ai.submit(p.providerUpload);
        if (!result.id) throw new Error('Transcription provider did not return a job ID.');
        p = store.update(p.id, (doc) => {
          doc.transcriptId = result.id;
          doc.submissionUncertain = false;
        });
      }
      if (Date.now() - Date.parse(job.createdAt) > 86400000)
        throw new Error(
          'Transcription has not finished after 24 hours. Check its provider status and retry polling.',
        );
      progress(job, 'transcribing');
      let result;
      try {
        result = await ai.poll(p.transcriptId);
      } catch (error) {
        checkCancelled(job);
        job.pollErrors = (job.pollErrors || 0) + 1;
        if (job.pollErrors > 8) throw error;
        store.jobSave(job, 'queued', Math.min(60000, 5000 * job.pollErrors));
        return 'deferred';
      }
      checkCancelled(job);
      if (['queued', 'processing'].includes(result.status)) {
        store.jobSave(job, 'queued', 7000);
        return 'deferred';
      }
      if (result.status !== 'completed') {
        store.update(p.id, (doc) => {
          doc.transcriptFailed = true;
        });
        throw new Error(
          `Transcription failed: ${result.error || result.status}. Retry to submit again, or recover a transcript ID.`,
        );
      }
      const words = normalizeWords(result, p.duration);
      store.update(p.id, (doc) => {
        doc.words = words;
        doc.status = 'ready';
      });
      if (words.length) store.enqueue(p.id, 'analyze');
    } else if (job.type === 'analyze' || job.type === 'search') {
      if (!p.words.length) throw new Error('Transcribe the episode first.');
      const chunks = wordChunks(p.words);
      job.parts ||= [];
      job.topics ||= [];
      job.nextChunk ||= 0;
      const feedback = [
        ...store
          .all()
          .flatMap((proj) => proj.feedback || [])
          .slice(-30),
        ...p.suggestions.map((c) => ({
          title: c.title,
          excerpt: clipText(p, c).slice(0, 600),
          decision: 'already suggested — find a different exchange',
        })),
      ];
      for (let i = job.nextChunk; i < chunks.length; i++) {
        progress(job, `finding moments ${i + 1}/${chunks.length}`);
        const output = await aiCall(job, `chunk${i}`, () =>
          ai.moments(chunks[i], feedback, job.payload.query || ''),
        );
        job.parts.push(...candidatesFromIds(output.moments, chunks[i], p.duration));
        for (const ch of output.chapters || []) {
          const w = chunks[i].find((w) => w.id === ch.firstWord);
          if (w && text(ch.title)) job.topics.push({ title: text(ch.title, 140), start: w.start });
        }
        job.nextChunk = i + 1;
        store.jobSave(job, 'running');
      }
      let picks = uniqueCandidates(job.parts, [], 40);
      if (picks.length > 1 && !job.ranked) {
        progress(job, 'ranking moments');
        const result = await aiCall(job, 'rank', () =>
          ai.rank(
            picks.map((c) => ({
              id: c.id,
              title: c.title,
              reason: c.reason,
              transcript: clipText(p, c),
            })),
          ),
        );
        const ordered = [...new Set(Array.isArray(result.ids) ? result.ids : [])]
          .map((id) => picks.find((c) => c.id === id))
          .filter(Boolean);
        if (!ordered.length)
          throw new Error('AI ranking did not reference any valid candidates. Retry this stage.');
        job.ranked = ordered;
        store.jobSave(job, 'running');
      }
      picks = (job.ranked || picks).map((c, i) => ({ ...c, score: 12 - i }));
      p = store.get(p.id);
      const additions = uniqueCandidates(picks, p.suggestions, 12);
      store.update(p.id, (doc) => {
        doc.suggestions.push(...additions);
        if (job.type === 'analyze')
          doc.chapters = job.topics
            .sort((a, b) => a.start - b.start)
            .filter((c, i, all) => i === 0 || c.start - all[i - 1].start > 20);
        doc.status = 'ready';
        doc.error = '';
      });
      job.resultCount = additions.length;
    } else if (job.type === 'export') {
      progress(job, 'exporting');
      const { clips, format, options } = job.payload;
      const out = join(dir, 'exports', job.id);
      await mkdir(out, { recursive: true });
      const files = [];
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i],
          name = `${String(i + 1).padStart(2, '0')}-${safeName(p.title)}-${safeName(clip.title)}`;
        if (format === 'mp3' || format === 'wav') {
          await renderAudio(
            source(p.id),
            join(out, `${name}.${format}`),
            clip,
            p.duration,
            format,
            options,
          );
          files.push(`${name}.${format}`);
        }
        if (format === 'srt' || format === 'bundle') {
          await writeFile(join(out, `${name}.srt`), srt(p, clip));
          files.push(`${name}.srt`);
        }
        if (format === 'txt' || format === 'bundle') {
          await writeFile(join(out, `${name}.txt`), clipText(p, clip));
          files.push(`${name}.txt`);
        }
        if (format === 'bundle') {
          await renderAudio(
            source(p.id),
            join(out, `${name}.mp3`),
            clip,
            p.duration,
            'mp3',
            options,
          );
          files.push(`${name}.mp3`);
        }
      }
      if (files.length === 1) job.output = { path: join(out, files[0]), name: files[0] };
      else {
        const zipPath = join(out, 'clips.zip');
        await new Promise((resolve, reject) => {
          const output = createWriteStream(zipPath),
            zip = archiver('zip', { zlib: { level: 1 } });
          output.on('close', resolve);
          output.on('error', reject);
          zip.on('error', reject);
          zip.pipe(output);
          for (const name of files) zip.file(join(out, name), { name });
          zip.finalize().catch(reject);
        });
        job.output = { path: zipPath, name: `${safeName(p.title)}-clips.zip` };
      }
      // Export history lives in the durable job, independently of editable clip metadata.
    } else throw new Error('Unknown background task.');
  }
  async function tick() {
    if (busy || stopping) return;
    const job = store.next();
    if (!job) return;
    busy = true;
    store.jobSave(job, 'running');
    try {
      checkCancelled(job);
      const result = await perform(job);
      checkCancelled(job);
      if (result !== 'deferred') store.jobSave(job, 'done');
    } catch (error) {
      job.error = error.cancelled ? '' : String(error.message || error).slice(0, 1500);
      store.jobSave(job, error.cancelled ? 'cancelled' : 'failed');
      if (!['export', 'search'].includes(job.type))
        store.update(job.projectId, (p) => {
          p.status = p.duration ? 'ready' : 'error';
          p.error = job.error;
        });
      // Leave the source intact for a retry; discard incomplete network writes only.
      if (job.type === 'import')
        await rm(join(config.dataDir, job.projectId, 'source.part'), { force: true }).catch(
          () => {},
        );
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(tick, 500);
  timer.unref();
  return {
    tick,
    get busy() {
      return busy;
    },
    stop() {
      stopping = true;
      clearInterval(timer);
    },
    source,
  };
}
