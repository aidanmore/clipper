import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './domain.js';
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.db = new DatabaseSync(join(dir, 'clipper.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, source_key TEXT, doc TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS source_unique ON projects(source_key) WHERE source_key <> '';
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, type TEXT, state TEXT, run_at INTEGER, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, month TEXT, seconds REAL DEFAULT 0, llm_calls INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0);`);
    this.db.prepare("UPDATE jobs SET state='queued' WHERE state='running'").run();
  }
  all() {
    return this.db
      .prepare('SELECT doc FROM projects ORDER BY rowid DESC')
      .all()
      .map((r) => JSON.parse(r.doc));
  }
  get(id) {
    const row = this.db.prepare('SELECT doc FROM projects WHERE id=?').get(id);
    if (!row) fail('Project not found.', 404);
    return JSON.parse(row.doc);
  }
  findSource(key) {
    const r = key && this.db.prepare('SELECT doc FROM projects WHERE source_key=?').get(key);
    return r ? JSON.parse(r.doc) : null;
  }
  save(p) {
    p.updatedAt = new Date().toISOString();
    p.revision++;
    this.db
      .prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc')
      .run(p.id, p.sourceKey || '', JSON.stringify(p));
    return p;
  }
  update(id, fn) {
    const p = this.get(id);
    fn(p);
    return this.save(p);
  }
  remove(id) {
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
  }
  jobs(id) {
    return this.db
      .prepare('SELECT * FROM jobs WHERE project_id=? ORDER BY rowid DESC')
      .all(id)
      .map((r) => ({
        ...JSON.parse(r.doc),
        id: r.id,
        type: r.type,
        state: r.state,
        runAt: r.run_at,
      }));
  }
  enqueue(projectId, type, payload = {}) {
    const active = this.jobs(projectId).find(
      (j) =>
        j.type === type &&
        ['queued', 'running'].includes(j.state) &&
        (!['export', 'search'].includes(type) ||
          JSON.stringify(j.payload) === JSON.stringify(payload)),
    );
    if (active) return active;
    const id = randomUUID();
    const doc = { payload, createdAt: new Date().toISOString(), error: '', progress: '' };
    this.db
      .prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)')
      .run(id, projectId, type, 'queued', Date.now(), JSON.stringify(doc));
    return { ...doc, id, type, state: 'queued', projectId };
  }
  next() {
    const r = this.db
      .prepare(
        "SELECT * FROM jobs WHERE state='queued' AND run_at<=? ORDER BY run_at,rowid LIMIT 1",
      )
      .get(Date.now());
    return (
      r && { ...JSON.parse(r.doc), id: r.id, projectId: r.project_id, type: r.type, state: r.state }
    );
  }
  job(id) {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    return (
      r && { ...JSON.parse(r.doc), id: r.id, projectId: r.project_id, type: r.type, state: r.state }
    );
  }
  jobSave(j, state, delay = 0) {
    this.db
      .prepare('UPDATE jobs SET state=?,run_at=?,doc=? WHERE id=?')
      .run(state, Date.now() + delay, JSON.stringify(j), j.id);
  }
  usage() {
    return this.db
      .prepare(
        'SELECT COALESCE(SUM(seconds),0) seconds,COALESCE(SUM(llm_calls),0) llmCalls,COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(output_tokens),0) outputTokens FROM usage WHERE month=?',
      )
      .get(new Date().toISOString().slice(0, 7));
  }
  reserve(id, seconds, hours) {
    if (this.db.prepare('SELECT id FROM usage WHERE id=?').get(id)) return;
    if (this.usage().seconds + seconds > hours * 3600)
      fail('Monthly transcription limit reached. Raise MONTHLY_AUDIO_HOURS to process more.');
    this.db
      .prepare('INSERT INTO usage(id,month,seconds) VALUES(?,?,?)')
      .run(id, new Date().toISOString().slice(0, 7), seconds);
  }
  llmReserve(id, maxCalls) {
    if (this.db.prepare('SELECT id FROM usage WHERE id=?').get(id))
      fail('This AI request was already submitted. Start a new analysis to retry.');
    if (this.usage().llmCalls >= maxCalls) fail('Monthly AI request limit reached.');
    this.db
      .prepare('INSERT INTO usage(id,month,llm_calls) VALUES(?,?,1)')
      .run(id, new Date().toISOString().slice(0, 7));
  }
  llmUsage(id, usage = {}) {
    this.db
      .prepare('UPDATE usage SET input_tokens=?,output_tokens=? WHERE id=?')
      .run(usage.prompt_tokens || 0, usage.completion_tokens || 0, id);
  }
  close() {
    this.db.close();
  }
}
