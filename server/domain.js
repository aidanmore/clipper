import { randomUUID } from 'node:crypto';

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
export function text(value, max = 300) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}
export function bounds(start, end, duration) {
  start = Number(start);
  end = Number(end);
  if (
    ![start, end, duration].every(Number.isFinite) ||
    start < 0 ||
    end > duration + 0.02 ||
    end - start < 0.1
  )
    fail('Choose a valid selection of at least 0.1 seconds.');
  return { start, end: Math.min(end, duration) };
}
export function newProject(input = {}) {
  return {
    id: randomUUID(),
    title: text(input.title) || 'Untitled episode',
    sourceUrl: input.sourceUrl || '',
    sourceKey: input.sourceKey || '',
    artwork: text(input.artwork, 2000),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 0,
    status: 'importing',
    error: '',
    duration: 0,
    channels: 0,
    sampleRate: 0,
    bytes: 0,
    hash: '',
    envelope: [],
    words: [],
    suggestions: [],
    chapters: [],
    clips: [],
    feedback: [],
    speakerNames: {},
    corrections: {},
    playback: 0,
    editRevision: 0,
  };
}
export function normalizeWords(result, duration) {
  return (result.words || [])
    .filter(
      (w) =>
        Number.isFinite(w.start) &&
        Number.isFinite(w.end) &&
        w.start >= 0 &&
        w.end > w.start &&
        w.end / 1000 <= duration + 2,
    )
    .sort((a, b) => a.start - b.start)
    .map((w, i) => ({
      id: i,
      text: text(w.text, 300),
      start: w.start / 1000,
      end: Math.min(duration, w.end / 1000),
      speaker: text(w.speaker ?? 'A', 20),
    }));
}
export function wordChunks(words, size = 1800, overlap = 150) {
  const result = [];
  for (let i = 0; i < words.length; i += size - overlap) {
    result.push(words.slice(i, i + size));
    if (i + size >= words.length) break;
  }
  return result;
}
export function transcriptLines(words) {
  const lines = [];
  let line = [];
  for (const w of words) {
    if (line.length && (w.speaker !== line.at(-1).speaker || line.length >= 35)) {
      lines.push(line);
      line = [];
    }
    line.push(w);
  }
  if (line.length) lines.push(line);
  return lines
    .map(
      (ws) => `[${ws[0].id}..${ws.at(-1).id}] ${ws[0].speaker}: ${ws.map((w) => w.text).join(' ')}`,
    )
    .join('\n');
}
export function candidatesFromIds(items, words, duration) {
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    const a = words.find((w) => w.id === item.firstWord),
      b = words.find((w) => w.id === item.lastWord);
    if (!a || !b || a.id > b.id || b.end - a.start < 5 || b.end - a.start > 240) return [];
    const variants = {};
    for (const key of ['short', 'full']) {
      const v = item[key],
        va = v && words.find((w) => w.id === v.firstWord),
        vb = v && words.find((w) => w.id === v.lastWord);
      if (va && vb && va.id <= vb.id && vb.end - va.start >= 5 && vb.end - va.start <= 240)
        variants[key] = {
          start: Math.max(0, va.start - 0.12),
          end: Math.min(duration, vb.end + 0.25),
        };
    }
    return [
      {
        id: randomUUID(),
        start: Math.max(0, a.start - 0.12),
        end: Math.min(duration, b.end + 0.25),
        title: text(item.title, 140) || 'Suggested moment',
        reason: text(item.reason, 600),
        context: text(item.context, 300),
        type: text(item.type, 40),
        score: Math.max(0, Math.min(10, Number(item.score) || 0)),
        variants,
      },
    ];
  });
}
export function uniqueCandidates(items, existing = [], limit = 12) {
  const kept = [...existing];
  const result = [];
  for (const candidate of [...items].sort((a, b) => b.score - a.score)) {
    if (
      kept.some(
        (p) =>
          Math.max(0, Math.min(p.end, candidate.end) - Math.max(p.start, candidate.start)) /
            Math.min(p.end - p.start, candidate.end - candidate.start) >
          0.5,
      )
    )
      continue;
    result.push(candidate);
    kept.push(candidate);
    if (result.length >= limit) break;
  }
  return result;
}
export function selectedWords(project, clip) {
  return project.words.filter((w) => w.end > clip.start && w.start < clip.end);
}
export function displayWord(project, w) {
  return project.corrections?.[w.id] ?? w.text;
}
export function clipText(project, clip) {
  return selectedWords(project, clip)
    .map((w) => displayWord(project, w))
    .join(' ');
}
export function srt(project, clip) {
  const words = selectedWords(project, clip);
  const groups = [];
  let group = [];
  for (const w of words) {
    if (
      group.length &&
      (w.end - group[0].start > 3 || group.length >= 9 || w.speaker !== group.at(-1).speaker)
    ) {
      groups.push(group);
      group = [];
    }
    group.push(w);
  }
  if (group.length) groups.push(group);
  const stamp = (seconds) => {
    const n = Math.round(Math.max(0, seconds) * 1000);
    return `${String(Math.floor(n / 3600000)).padStart(2, '0')}:${String(Math.floor(n / 60000) % 60).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')},${String(n % 1000).padStart(3, '0')}`;
  };
  return groups
    .map(
      (g, i) =>
        `${i + 1}\n${stamp(g[0].start - clip.start)} --> ${stamp(Math.min(clip.end, g.at(-1).end) - clip.start)}\n${g.map((w) => displayWord(project, w)).join(' ')}\n`,
    )
    .join('\n');
}
export function safeName(value) {
  return (
    text(value, 100)
      .replace(/[^\p{L}\p{N}._ -]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^\.+/, '') || 'clip'
  );
}
