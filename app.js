const $ = (id) => document.getElementById(id);
const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const clock = (seconds, precise = false) => {
  const n = Math.max(0, Number(seconds) || 0),
    h = Math.floor(n / 3600),
    m = Math.floor(n / 60) % 60,
    s = precise
      ? (n % 60).toFixed(1).padStart(4, '0')
      : String(Math.floor(n % 60)).padStart(2, '0');
  return `${h ? h + ':' : ''}${String(m).padStart(2, '0')}:${s}`;
};
const parseTime = (value) =>
  String(value)
    .split(':')
    .reduce((sum, n) => sum * 60 + Number(n), 0);
const clone = (value) => JSON.parse(JSON.stringify(value));
const player = $('player');
const state = {
  base:
    localStorage.getItem('clipper.backend') ||
    (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : ''),
  token: sessionStorage.getItem('clipper.session') || '',
  config: null,
  projects: [],
  feed: [],
  project: null,
  selection: null,
  candidate: null,
  tab: 'moments',
  page: 0,
  demo: false,
  dirty: false,
  saving: false,
  conflict: false,
  editSerial: 0,
  undo: [],
  redo: [],
  view: { start: 0, end: 1 },
  stopAt: null,
  loop: false,
  selectionMode: false,
  anchor: null,
  exportClips: [],
  downloadLinks: new Map(),
  opening: 0,
};
let saveTimer,
  toastTimer,
  pollBusy = false,
  drawFrame,
  playingWord = null,
  playbackSavedAt = 0;
function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error-toast', error);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), error ? 9000 : 4500);
}
function run(task) {
  return Promise.resolve()
    .then(task)
    .catch((error) => toast(error.message || 'Something went wrong. Please try again.', true));
}
function endpoint(path) {
  return `${state.base.replace(/\/$/, '')}${path}`;
}
async function api(path, options = {}) {
  if (!state.base) throw new Error('Connect your workspace to use this feature.');
  const response = await fetch(endpoint(path), {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(30000),
  });
  const data = await response
    .json()
    .catch(() => ({ error: 'The workspace returned an unreadable response.' }));
  if (!response.ok) {
    if (response.status === 401) {
      state.token = '';
      sessionStorage.removeItem('clipper.session');
      document.body.classList.remove('connected');
    }
    const error = new Error(data.error || `Workspace returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
function editable() {
  const p = state.project;
  return {
    title: p.title,
    clips: p.clips,
    speakerNames: p.speakerNames || {},
    corrections: p.corrections || {},
    suggestionStates: p.suggestionStates || {},
    feedback: p.feedback || [],
    playback: player.currentTime || p.playback || 0,
    draft: state.selection,
  };
}
function history() {
  if (!state.project) return;
  state.undo.push(clone(editable()));
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
}
function dirty() {
  const saved = state.project?.clips?.find((c) => c.id === state.selection?.id);
  if (saved)
    Object.assign(saved, {
      title: state.selection.title || saved.title,
      note: state.selection.note || '',
      start: state.selection.start,
      end: state.selection.end,
    });
  state.dirty = true;
  state.editSerial++;
  $('saveStatus').textContent = state.demo ? 'saving tour…' : 'saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => run(save), 650);
}
async function save() {
  if (!state.project || !state.dirty || state.saving || state.conflict) return;
  const id = state.project.id,
    serial = state.editSerial,
    payload = clone(editable());
  state.saving = true;
  try {
    if (state.demo) localStorage.setItem('clipper.tour', JSON.stringify(payload));
    else {
      const result = await api(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...payload, editRevision: state.project.editRevision }),
      });
      if (state.project?.id === id) state.project.editRevision = result.editRevision;
    }
    if (state.project?.id === id && state.editSerial === serial) {
      state.dirty = false;
      const summary = state.projects.find((p) => p.id === id);
      if (summary) {
        summary.clipCount = state.project.clips.length;
        summary.title = state.project.title;
        renderProjects();
      }
      $('saveStatus').textContent = state.demo ? 'tour saved on this device' : 'all changes saved';
    }
  } catch (error) {
    $('saveStatus').textContent = 'changes not saved';
    $('saveStatus').classList.add('save-error');
    if (error.status === 409) {
      state.conflict = true;
      toast(
        'This project was edited elsewhere. Download a backup of your current edits, then reopen it to load the latest version.',
        true,
      );
    }
    throw error;
  } finally {
    state.saving = false;
    if (state.dirty && !state.conflict) saveTimer = setTimeout(() => run(save), 2500);
  }
}
async function flush() {
  clearTimeout(saveTimer);
  if (state.conflict) throw new Error('Save a backup, then reload before switching projects.');
  while (state.saving) await new Promise((r) => setTimeout(r, 50));
  await save();
  if (state.dirty) throw new Error('Your changes are still saving. Please try again.');
}
function undo(redo = false) {
  if (!state.project) return;
  const from = redo ? state.redo : state.undo,
    to = redo ? state.undo : state.redo;
  if (!from.length) return;
  to.push(clone(editable()));
  const edit = from.pop();
  Object.assign(state.project, edit);
  state.selection = edit.draft;
  dirty();
  renderEditor();
  renderBrowse();
}
function dialog(id) {
  if (!$(id).open) $(id).showModal();
}
for (const button of document.querySelectorAll('[data-close]'))
  button.onclick = () => button.closest('dialog').close();
for (const d of document.querySelectorAll('dialog'))
  d.addEventListener('click', (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        d.close();
    }
  });
function showConnect() {
  $('backendUrl').value = state.base;
  $('workspacePassword').value = '';
  $('connectError').textContent = '';
  const c = state.config;
  $('workspaceUsage').innerHTML = c
    ? `<p class="small muted">This month: ${(c.usage.seconds / 3600).toFixed(2)} / ${c.limits.monthlyAudioHours} transcription hours · ${c.usage.llmCalls} / ${c.limits.monthlyLlmCalls} AI requests.<br>${c.aiReady ? 'AI service is configured.' : 'AI service is not configured. Manual editing is available.'}</p>`
    : '';
  dialog('connectDialog');
}
$('connectionButton').onclick = showConnect;
$('connectForm').onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('connectError').textContent = '';
  try {
    const u = new URL($('backendUrl').value);
    if (
      u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
    )
      throw new Error('Use HTTPS, or HTTP on localhost for development.');
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/')
      throw new Error('Enter just the workspace origin, such as https://your-app.up.railway.app.');
    const result = await fetch(`${u.origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('workspacePassword').value }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error || 'Could not connect.');
    await flush();
    state.base = u.origin;
    state.token = data.token;
    state.demo = false;
    if (state.project?.id === 'tour') {
      player.pause();
      state.project = null;
      state.selection = null;
      $('studio').hidden = true;
      $('playerDock').hidden = true;
      $('welcome').hidden = false;
    }
    localStorage.setItem('clipper.backend', state.base);
    sessionStorage.setItem('clipper.session', state.token);
    $('workspacePassword').value = '';
    state.config = await api('/api/config');
    await loadProjects();
    document.body.classList.add('connected');
    $('connectDialog').close();
    toast('Workspace connected. Your episodes are ready to browse.');
  } catch (error) {
    $('connectError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$('disconnect').onclick = () => {
  run(async () => {
    await flush();
    player.pause();
    state.token = '';
    state.config = null;
    state.project = null;
    sessionStorage.removeItem('clipper.session');
    document.body.classList.remove('connected');
    $('connectDialog').close();
    $('studio').hidden = true;
    $('playerDock').hidden = true;
    $('welcome').hidden = false;
    $('projects').innerHTML = '';
    toast('Workspace disconnected.');
  });
};
async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjects();
}
function renderProjects() {
  $('projectCount').textContent = state.projects.length;
  $('projects').innerHTML =
    state.projects
      .map(
        (p) =>
          `<button class="project-link ${p.id === state.project?.id ? 'active' : ''}" data-project="${escapeHTML(p.id)}"><strong>${escapeHTML(p.title)}</strong><small>${p.duration ? clock(p.duration) : 'importing'} · ${p.clipCount} kept</small></button>`,
      )
      .join('') || '<p class="small muted">Your episodes will live here.</p>';
}
$('projects').onclick = (event) => {
  const b = event.target.closest('[data-project]');
  if (b) run(() => openProject(b.dataset.project));
};
async function openProject(id) {
  await flush();
  const sequence = ++state.opening;
  const p = await api(`/api/projects/${id}`);
  if (sequence !== state.opening) return;
  state.demo = false;
  enterProject(p);
  localStorage.setItem('clipper.lastProject', id);
}
function enterProject(p) {
  player.pause();
  state.stopAt = null;
  state.project = p;
  state.selection = p.draft || {
    id: crypto.randomUUID(),
    title: '',
    note: '',
    start: 0,
    end: Math.min(p.duration || 30, 30),
  };
  state.candidate = null;
  state.undo = [];
  state.redo = [];
  state.page = 0;
  state.conflict = false;
  state.dirty = false;
  state.anchor = null;
  state.view = { start: 0, end: p.duration || 1 };
  $('saveStatus').classList.remove('save-error');
  $('saveStatus').textContent = state.demo ? 'editor tour · sample audio' : 'all changes saved';
  $('welcome').hidden = true;
  $('studio').hidden = false;
  $('playerDock').hidden = !p.duration;
  player.src = state.demo ? p.demoUrl : p.importComplete ? endpoint(p.mediaUrl) : '';
  player.load();
  player.onloadedmetadata = () => {
    if (Number.isFinite(p.playback)) player.currentTime = Math.min(p.duration, p.playback);
  };
  $('seek').max = p.duration || 1;
  $('totalDuration').textContent = clock(p.duration);
  $('episodeTitle').textContent = p.title;
  $('episodeInfo').textContent = state.demo
    ? 'EDITOR TOUR / TEST TONE + SAMPLE DIALOGUE'
    : `${clock(p.duration)} / ${p.channels || '—'} CHANNEL${p.channels === 1 ? '' : 'S'} / ${p.bytes ? (p.bytes / 1024 ** 2).toFixed(1) + ' MB' : 'IMPORTING'}`;
  $('breadcrumb').textContent = state.demo ? 'TAKE A LOOK AROUND' : 'THE CUTTING ROOM / EPISODE';
  $('transcriptSearch').value = '';
  $('semanticQuery').value = '';
  renderProjects();
  renderEditor();
  renderBrowse();
  renderProcessing();
  setTab('moments');
}
$('homeLink').onclick = (event) => {
  event.preventDefault();
  run(async () => {
    await flush();
    player.pause();
    $('studio').hidden = true;
    $('playerDock').hidden = true;
    $('welcome').hidden = false;
  });
};
async function showImport() {
  if (!state.token) {
    showConnect();
    return;
  }
  $('autoAnalyze').disabled = !state.config?.aiReady;
  $('autoAnalyze').checked = false;
  dialog('importDialog');
  showMethod('feed');
  await loadFeed();
}
$('addEpisode').onclick = () => run(showImport);
$('mobileAdd').onclick = () => run(showImport);
$('startButton').onclick = () => run(showImport);
function showMethod(method) {
  for (const m of ['feed', 'url', 'file']) $(m + 'Import').hidden = m !== method;
  for (const b of document.querySelectorAll('[data-method]'))
    b.classList.toggle('active', b.dataset.method === method);
}
for (const b of document.querySelectorAll('[data-method]'))
  b.onclick = () => showMethod(b.dataset.method);
async function loadFeed(url) {
  $('feedEpisodes').innerHTML = '<p class="small muted">Finding the episodes…</p>';
  try {
    const feed = await api(`/api/feed${url ? '?url=' + encodeURIComponent(url) : ''}`);
    state.feed = feed.episodes;
    $('feedUrl').value = feed.feedUrl;
    renderFeed();
  } catch (error) {
    $('feedEpisodes').innerHTML =
      `<p class="error">${escapeHTML(error.message)}</p><p class="small muted">You can still import a direct audio link or upload a recording.</p>`;
  }
}
function renderFeed() {
  const q = $('episodeSearch').value.toLowerCase();
  $('feedEpisodes').innerHTML =
    state.feed
      .filter((p) => p.title.toLowerCase().includes(q))
      .map(
        (p) =>
          `<button class="feed-row" data-feed-key="${escapeHTML(p.sourceKey)}">${/^https:\/\//.test(p.artwork) ? `<img src="${escapeHTML(p.artwork)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span><strong>${escapeHTML(p.title)}</strong><small>${escapeHTML(p.duration)} ${p.date ? '· ' + escapeHTML(new Date(p.date).toLocaleDateString()) : ''}</small></span><span>+</span></button>`,
      )
      .join('') || '<p class="muted small">No matching episodes.</p>';
}
$('episodeSearch').oninput = renderFeed;
$('feedForm').onsubmit = (e) => {
  e.preventDefault();
  run(() => loadFeed($('feedUrl').value));
};
$('feedEpisodes').onclick = (e) => {
  const b = e.target.closest('[data-feed-key]');
  if (!b) return;
  const entry = state.feed.find((p) => p.sourceKey === b.dataset.feedKey);
  run(async () => {
    b.disabled = true;
    try {
      const p = await post('/api/projects', { ...entry, analyze: $('autoAnalyze').checked });
      $('importDialog').close();
      await loadProjects();
      await openProject(p.id);
    } finally {
      b.disabled = false;
    }
  });
};
$('urlImport').onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const button = e.submitter;
    button.disabled = true;
    try {
      const p = await post('/api/projects', {
        sourceUrl: $('audioUrl').value,
        title: $('importTitle').value,
        analyze: $('autoAnalyze').checked,
      });
      $('importDialog').close();
      await loadProjects();
      await openProject(p.id);
    } finally {
      button.disabled = false;
    }
  });
};
async function upload(file) {
  if (!file) return;
  if (file.size > (state.config?.limits.maxFileMB || 600) * 1024 ** 2)
    throw new Error('This recording exceeds the workspace file limit.');
  $('audioFile').disabled = true;
  try {
    const p = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint(`/api/upload?analyze=${$('autoAnalyze').checked}`));
      xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          $('uploadProgress').textContent =
            `Uploading ${Math.round((e.loaded / e.total) * 100)}% · keep this tab open until the upload finishes.`;
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 400) reject(new Error(data.error));
          else resolve(data);
        } catch {
          reject(new Error('Upload could not finish.'));
        }
      };
      xhr.onerror = () => reject(new Error('Upload interrupted. Please choose the file again.'));
      xhr.send(file);
    });
    $('importDialog').close();
    await loadProjects();
    await openProject(p.id);
  } finally {
    $('audioFile').disabled = false;
    $('audioFile').value = '';
    $('uploadProgress').textContent = 'Unreleased episodes are welcome.';
  }
}
$('audioFile').onchange = (e) => run(() => upload(e.target.files[0]));
$('fileDrop').ondragover = (e) => e.preventDefault();
$('fileDrop').ondrop = (e) => {
  e.preventDefault();
  run(() => upload(e.dataTransfer.files[0]));
};
function setTab(tab) {
  state.tab = tab;
  for (const name of ['moments', 'transcript', 'shortlist']) {
    $(name + 'Pane').hidden = name !== tab;
    document
      .querySelector(`[data-tab="${name}"]`)
      .setAttribute('aria-selected', String(name === tab));
  }
  if (tab === 'transcript') renderTranscript();
  if (tab === 'shortlist') renderShortlist();
  if (tab === 'moments') renderMoments();
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => setTab(b.dataset.tab);
function excerpt(clip, limit = 180) {
  const p = state.project;
  return p.words
    .filter((w) => w.end > clip.start && w.start < clip.end)
    .map((w) => p.corrections?.[w.id] ?? w.text)
    .join(' ')
    .slice(0, limit);
}
function renderBrowse() {
  if (!state.project) return;
  renderMoments();
  renderShortlist();
  renderTranscript();
}
function empty(symbol, title, description) {
  return `<div class="empty-state"><span class="empty-symbol">${symbol}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p></div>`;
}
function renderMoments() {
  const p = state.project,
    items = p.suggestions.filter((s) => !p.suggestionStates?.[s.id]);
  $('momentCount').textContent = items.length;
  $('momentsList').innerHTML =
    items
      .map(
        (c, i) =>
          `<article class="moment-card ${state.candidate?.id === c.id ? 'active' : ''}" data-candidate="${escapeHTML(c.id)}" tabindex="0" role="button" aria-label="Listen to ${escapeHTML(c.title)}"><div class="moment-meta"><span>${String(i + 1).padStart(2, '0')} / ${escapeHTML(c.type || 'MOMENT')}</span><span>${clock(c.start)} — ${clock(c.end)}</span></div><h3>${escapeHTML(c.title)}</h3><p>${escapeHTML(excerpt(c))}${excerpt(c).length >= 180 ? '…' : ''}</p><div class="card-actions"><span class="text-button">▶ audition</span><button class="text-button" data-skip-candidate="${escapeHTML(c.id)}">skip</button></div></article>`,
      )
      .join('') ||
    empty(
      '✧',
      p.words.length ? 'Find the good bits.' : 'Start with your ears.',
      p.words.length
        ? 'Ask for moments, describe a bit, or make a cut from the transcript.'
        : 'You can listen and mark a clip now. Add transcription to search the words and find suggested moments.',
    );
  const skipped = p.suggestions.filter((c) => p.suggestionStates?.[c.id] === 'skipped');
  if (skipped.length)
    $('momentsList').insertAdjacentHTML(
      'beforeend',
      `<button class="text-button" id="restoreSkipped">restore ${skipped.length} skipped moment${skipped.length === 1 ? '' : 's'}</button>`,
    );
  $('analyzeButton').disabled =
    state.demo || !p.duration || (!state.config?.aiReady && !state.demo) || hasActiveAI();
  $('analyzeButton').textContent = p.suggestions.length ? 'find more moments ✧' : 'find moments ✧';
}
function choose(candidate, play = true) {
  history();
  state.candidate = candidate;
  state.selection = {
    id: candidate.id,
    title: candidate.title,
    note: candidate.note || '',
    start: candidate.start,
    end: candidate.end,
  };
  dirty();
  fit();
  renderEditor();
  renderMoments();
  renderTranscript();
  if (play) run(() => preview(candidate.start, candidate.end));
}
$('momentsList').onclick = (e) => {
  if (e.target.closest('#restoreSkipped')) {
    history();
    for (const [id, value] of Object.entries(state.project.suggestionStates || {}))
      if (value === 'skipped') delete state.project.suggestionStates[id];
    dirty();
    renderMoments();
    return;
  }
  const skip = e.target.closest('[data-skip-candidate]');
  if (skip) {
    skipCandidate(skip.dataset.skipCandidate);
    return;
  }
  const card = e.target.closest('[data-candidate]');
  if (card) choose(state.project.suggestions.find((c) => c.id === card.dataset.candidate));
};
$('momentsList').onkeydown = (e) => {
  if (e.target.matches('.moment-card') && ['Enter', ' '].includes(e.key)) {
    e.preventDefault();
    e.target.click();
  }
};
function skipCandidate(id = state.candidate?.id) {
  if (!id) return;
  history();
  state.project.suggestionStates ||= {};
  state.project.suggestionStates[id] = 'skipped';
  const c = state.project.suggestions.find((c) => c.id === id);
  if (c)
    state.project.feedback.push({
      title: c.title,
      excerpt: excerpt(c, 600),
      decision: 'skip',
      note: '',
    });
  dirty();
  const next = state.project.suggestions.find((c) => !state.project.suggestionStates[c.id]);
  renderMoments();
  if (next) choose(next);
  else toast('All caught up. Your kept clips are in the shortlist.');
}
$('skipClip').onclick = () => skipCandidate();
function keep() {
  if (!state.project || !state.selection || state.selection.end - state.selection.start < 0.1)
    return;
  history();
  const c = {
    ...state.selection,
    title: state.selection.title || 'Untitled clip',
    status: 'draft',
  };
  const index = state.project.clips.findIndex((k) => k.id === c.id);
  if (index >= 0) {
    c.status = state.project.clips[index].status;
    state.project.clips[index] = c;
  } else state.project.clips.push(c);
  state.project.suggestionStates ||= {};
  state.project.suggestionStates[c.id] = 'kept';
  if (index < 0)
    state.project.feedback.push({
      title: c.title,
      excerpt: excerpt(c, 600),
      decision: 'keep',
      note: '',
    });
  dirty();
  renderBrowse();
  toast(index >= 0 ? 'Saved your clip changes.' : 'Kept. It’s waiting in your shortlist.');
}
$('keepClip').onclick = keep;
function wasExported(c) {
  return state.project.jobs?.some(
    (j) =>
      j.type === 'export' &&
      j.state === 'done' &&
      j.payload.clips.some((k) => k.id === c.id && k.start === c.start && k.end === c.end),
  );
}
function renderShortlist() {
  const p = state.project;
  $('keptCount').textContent = p.clips.length;
  $('shortlist').innerHTML =
    p.clips
      .map(
        (c) =>
          `<article class="moment-card" data-kept="${escapeHTML(c.id)}"><div class="moment-meta"><label><input type="checkbox" class="export-choice" value="${escapeHTML(c.id)}" aria-label="Select ${escapeHTML(c.title)} for export"> ${clock(c.start)} — ${clock(c.end)}</label><span class="clip-status">${escapeHTML(wasExported(c) ? 'exported' : c.status || 'draft')}</span></div><h3>${escapeHTML(c.title)}</h3><p>${escapeHTML(excerpt(c, 130))}</p>${c.note ? `<p class="shortlist-note">↳ ${escapeHTML(c.note)}</p>` : ''}<div class="card-actions"><button class="text-button" data-edit="${escapeHTML(c.id)}">edit / listen</button><button class="text-button" data-ready="${escapeHTML(c.id)}">mark ${c.status === 'ready' ? 'draft' : 'ready'}</button><button class="text-button" data-duplicate="${escapeHTML(c.id)}">duplicate</button><button class="text-button" data-remove="${escapeHTML(c.id)}">remove</button></div></article>`,
      )
      .join('') ||
    empty(
      '↗',
      'Keep a little collection.',
      'Clips you keep will appear here, with your notes and saved cut points.',
    );
  $('exportAll').disabled = !p.clips.length;
}
$('shortlist').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  for (const action of ['edit', 'ready', 'duplicate', 'remove']) {
    const id = b.dataset[action];
    if (!id) continue;
    const clip = state.project.clips.find((c) => c.id === id);
    if (action === 'edit') {
      choose(clip);
      return;
    }
    history();
    if (action === 'ready') clip.status = clip.status === 'ready' ? 'draft' : 'ready';
    if (action === 'duplicate')
      state.project.clips.push({
        ...clip,
        id: crypto.randomUUID(),
        title: clip.title + ' (alternate)',
        status: 'draft',
      });
    if (action === 'remove') state.project.clips = state.project.clips.filter((c) => c.id !== id);
    dirty();
    renderShortlist();
  }
};
$('shortlist').onchange = () => {
  $('exportAll').textContent = document.querySelectorAll('.export-choice:checked').length
    ? 'export selected ↗'
    : 'export all ↗';
};
function renderEditor() {
  const p = state.project,
    c = state.selection;
  if (!p || !c) return;
  const candidate = state.candidate;
  for (const el of document.querySelectorAll(
    '.editor-panel input,.editor-panel textarea,.editor-panel button',
  ))
    el.disabled = !p.duration;
  $('candidateIntro').innerHTML = candidate
    ? `<h2>${escapeHTML(candidate.title)}</h2><p class="muted">${escapeHTML(candidate.reason || 'Your saved cut. Fine-tune it while you listen.')}</p>${candidate.context ? `<p class="context-warning">↳ ${escapeHTML(candidate.context)}</p>` : ''}`
    : '<h2>Make room for the good bit.</h2><p class="muted">Listen, mark your in and out points, and keep the exchange.</p>';
  $('candidatePosition').textContent = candidate ? 'AUDITIONING' : 'MANUAL CUT';
  $('clipTitle').value = c.title;
  $('clipNote').value = c.note || '';
  updateTiming();
  $('shortVersion').disabled = !candidate?.variants?.short;
  $('fullVersion').disabled = !candidate?.variants?.full;
  $('undoButton').disabled = !state.undo.length;
  $('redoButton').disabled = !state.redo.length;
}
function updateTiming() {
  const c = state.selection;
  if (!c) return;
  $('startTime').value = clock(c.start, true);
  $('endTime').value = clock(c.end, true);
  $('clipDuration').textContent = `${(c.end - c.start).toFixed(1)}s`;
  draw();
}
function adjust(key, value, record = true) {
  const c = state.selection,
    p = state.project;
  if (!c || !p.duration) return;
  if (!Number.isFinite(value)) {
    toast('Use a time such as 12:34.5.', true);
    updateTiming();
    return;
  }
  if (record) history();
  c[key] =
    key === 'start'
      ? Math.max(0, Math.min(c.end - 0.1, value))
      : Math.min(p.duration, Math.max(c.start + 0.1, value));
  dirty();
  updateTiming();
  highlightWords();
}
for (const button of document.querySelectorAll('[data-nudge]'))
  button.onclick = () => {
    const [key, delta] = button.dataset.nudge.split(':');
    adjust(key, state.selection[key] + Number(delta));
  };
$('startTime').onchange = (e) => adjust('start', parseTime(e.target.value));
$('endTime').onchange = (e) => adjust('end', parseTime(e.target.value));
$('clipTitle').onchange = (e) => {
  history();
  state.selection.title = e.target.value;
  dirty();
};
$('clipNote').onchange = (e) => {
  history();
  state.selection.note = e.target.value;
  dirty();
};
$('markStart').onclick = () => adjust('start', player.currentTime);
$('markEnd').onclick = () => adjust('end', player.currentTime);
$('undoButton').onclick = () => undo();
$('redoButton').onclick = () => undo(true);
for (const [key, id] of [
  ['short', 'shortVersion'],
  ['full', 'fullVersion'],
])
  $(id).onclick = () => {
    const v = state.candidate?.variants?.[key];
    if (!v) return;
    history();
    Object.assign(state.selection, v);
    dirty();
    fit();
    updateTiming();
    highlightWords();
  };
function extend(direction) {
  const words = state.project.words,
    c = state.selection;
  if (!words.length) {
    adjust(
      direction === 'before' ? 'start' : 'end',
      c[direction === 'before' ? 'start' : 'end'] + (direction === 'before' ? -5 : 5),
    );
    return;
  }
  const before = direction === 'before',
    pool = words.filter((w) => (before ? w.start < c.start : w.end > c.end));
  let chosen = before ? pool.slice(-70) : pool.slice(0, 70);
  if (!chosen.length) return;
  if (before) {
    let boundary = -1;
    for (let i = chosen.length - 2; i >= 0; i--)
      if (/[.!?]$/.test(chosen[i].text)) {
        boundary = i;
        break;
      }
    chosen = chosen.slice(boundary + 1);
    adjust('start', Math.max(0, chosen[0].start - 0.12));
  } else {
    let i = chosen.findIndex((w) => /[.!?]$/.test(w.text));
    if (i < 0) i = Math.min(20, chosen.length - 1);
    adjust('end', Math.min(state.project.duration, chosen[i].end + 0.25));
  }
  fit();
}
$('previousSentence').onclick = () => extend('before');
$('nextSentence').onclick = () => extend('after');
function hasActiveAI() {
  return state.project?.jobs?.some(
    (j) =>
      ['queued', 'running'].includes(j.state) &&
      ['transcribe', 'analyze', 'search'].includes(j.type),
  );
}
$('analyzeButton').onclick = () =>
  run(async () => {
    await flush();
    await post(`/api/projects/${state.project.id}/process`);
    toast('Finding moments in the background. You can keep editing.');
    await poll();
  });
$('semanticForm').onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    if (state.demo)
      throw new Error('Descriptive search is available after connecting your workspace.');
    if (!$('semanticQuery').value.trim()) return;
    await flush();
    await post(`/api/projects/${state.project.id}/search`, { query: $('semanticQuery').value });
    toast('Looking for that exchange. Results will join the moments list.');
    await poll();
  });
};
let visibleWords = [];
function renderTranscript() {
  const p = state.project;
  if (!p) return;
  const q = $('transcriptSearch').value.toLowerCase().trim();
  const groups = [];
  let group = [];
  for (const word of p.words) {
    if (group.length && (group.length >= 35 || word.speaker !== group.at(-1).speaker)) {
      groups.push(group);
      group = [];
    }
    group.push(word);
  }
  if (group.length) groups.push(group);
  const filtered = q
    ? groups.filter((g) =>
        g
          .map((w) => p.corrections?.[w.id] ?? w.text)
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    : groups;
  const pageCount = Math.max(1, Math.ceil(filtered.length / 12));
  state.page = Math.max(0, Math.min(state.page, pageCount - 1));
  const page = filtered.slice(state.page * 12, (state.page + 1) * 12);
  visibleWords = page.flat();
  $('transcriptList').innerHTML =
    page
      .map(
        (g) =>
          `<p class="transcript-line"><button class="speaker-button" data-speaker="${escapeHTML(g[0].speaker)}">${escapeHTML(p.speakerNames[g[0].speaker] || 'Speaker ' + g[0].speaker)} · ${clock(g[0].start)}</button>${g.map((w) => `<span class="word ${q && (p.corrections[w.id] ?? w.text).toLowerCase().includes(q) ? 'match' : ''}" data-word="${w.id}" tabindex="0">${escapeHTML(p.corrections[w.id] ?? w.text)}</span>`).join(' ')}</p>`,
      )
      .join('') ||
    empty(
      '≋',
      p.words.length ? 'No matching words.' : 'The words will appear here.',
      p.words.length
        ? 'Try a shorter phrase or another spelling.'
        : 'Transcribe this episode to search, select passages, and export captions.',
    );
  $('pageInfo').textContent = `${state.page + 1} / ${pageCount}`;
  $('previousPage').disabled = state.page === 0;
  $('nextPage').disabled = state.page >= pageCount - 1;
  $('chapters').innerHTML = (p.chapters || [])
    .map((c) => `<button class="chip" data-chapter="${c.start}">${escapeHTML(c.title)}</button>`)
    .join('');
  highlightWords();
}
$('transcriptSearch').oninput = () => {
  state.page = 0;
  renderTranscript();
};
$('previousPage').onclick = () => {
  state.page--;
  renderTranscript();
};
$('nextPage').onclick = () => {
  state.page++;
  renderTranscript();
};
$('chapters').onclick = (e) => {
  const b = e.target.closest('[data-chapter]');
  if (b) seek(Number(b.dataset.chapter));
};
function passage(first, last) {
  const a = state.project.words.find((w) => w.id === Math.min(first, last)),
    b = state.project.words.find((w) => w.id === Math.max(first, last));
  if (!a || !b) return;
  history();
  state.candidate = null;
  state.selection = {
    id: crypto.randomUUID(),
    title: '',
    note: '',
    start: Math.max(0, a.start - 0.12),
    end: Math.min(state.project.duration, b.end + 0.25),
  };
  dirty();
  fit();
  renderEditor();
  highlightWords();
  toast('Passage selected. Listen and fine-tune the cut.');
}
$('transcriptList').onclick = (e) => {
  const speaker = e.target.closest('[data-speaker]');
  if (speaker) {
    const id = speaker.dataset.speaker;
    const name = prompt('Speaker name', state.project.speakerNames[id] || `Speaker ${id}`);
    if (name !== null) {
      history();
      state.project.speakerNames[id] = name;
      dirty();
      renderTranscript();
    }
    return;
  }
  const span = e.target.closest('[data-word]');
  if (!span) return;
  const id = Number(span.dataset.word);
  if (state.selectionMode || e.shiftKey) {
    if (state.anchor === null) {
      state.anchor = id;
      toast('Now tap the last word of the passage.');
    } else {
      passage(state.anchor, id);
      state.anchor = null;
      state.selectionMode = false;
      $('selectPassage').textContent = 'select a passage';
    }
  } else {
    state.anchor = id;
    seek(state.project.words.find((w) => w.id === id).start);
    run(() => player.play());
  }
};
$('transcriptList').ondblclick = (e) => {
  const span = e.target.closest('[data-word]');
  if (!span) return;
  player.pause();
  const id = Number(span.dataset.word),
    w = state.project.words.find((w) => w.id === id);
  const value = prompt(
    'Correct this word (audio and timing stay the same)',
    state.project.corrections[id] ?? w.text,
  );
  if (value !== null) {
    history();
    state.project.corrections[id] = value;
    dirty();
    renderTranscript();
  }
};
$('transcriptList').onkeydown = (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-word]')) e.target.click();
};
$('selectPassage').onclick = () => {
  state.selectionMode = !state.selectionMode;
  state.anchor = null;
  $('selectPassage').textContent = state.selectionMode
    ? 'cancel passage selection'
    : 'select a passage';
  if (state.selectionMode) toast('Tap the first word, then the last word.');
};
$('useTextSelection').onmousedown = (e) => e.preventDefault();
$('useTextSelection').onclick = () => {
  const selected = window.getSelection();
  if (!selected?.rangeCount || selected.isCollapsed)
    return toast('Highlight some transcript words first.');
  const range = selected.getRangeAt(0);
  const words = [...$('transcriptList').querySelectorAll('[data-word]')]
    .filter((el) => range.intersectsNode(el))
    .map((el) => Number(el.dataset.word));
  if (words.length) passage(Math.min(...words), Math.max(...words));
  selected.removeAllRanges();
};
function highlightWords() {
  const c = state.selection;
  if (!c) return;
  for (const span of $('transcriptList').querySelectorAll('[data-word]')) {
    const w = state.project.words[Number(span.dataset.word)];
    span.classList.toggle('in-selection', w.end > c.start && w.start < c.end);
  }
}
function seek(time) {
  if (!state.project?.duration) return;
  state.stopAt = null;
  player.currentTime = Math.max(0, Math.min(state.project.duration, time));
  draw();
}
async function preview(start, end) {
  state.stopAt = end;
  player.currentTime = start;
  await player.play();
}
$('playPause').onclick = () =>
  run(async () => {
    state.stopAt = null;
    if (player.paused) await player.play();
    else player.pause();
  });
$('back10').onclick = () => seek(player.currentTime - 10);
$('forward10').onclick = () => seek(player.currentTime + 10);
$('seek').oninput = (e) => seek(Number(e.target.value));
$('seek').onchange = () => dirty();
$('speed').onchange = (e) => (player.playbackRate = Number(e.target.value));
$('previewClip').onclick = () => run(() => preview(state.selection.start, state.selection.end));
$('previewStart').onclick = () =>
  run(() =>
    preview(state.selection.start, Math.min(state.selection.end, state.selection.start + 4)),
  );
$('previewEnd').onclick = () =>
  run(() => preview(Math.max(state.selection.start, state.selection.end - 4), state.selection.end));
$('leadIn').onclick = () =>
  run(() => preview(Math.max(0, state.selection.start - 7), state.selection.end));
$('loopButton').onclick = () => {
  state.loop = !state.loop;
  $('loopButton').setAttribute('aria-pressed', String(state.loop));
};
player.onplay = () => {
  $('playPause').textContent = 'Ⅱ';
  $('playPause').setAttribute('aria-label', 'Pause');
  animate();
};
player.onpause = () => {
  $('playPause').textContent = '▶';
  $('playPause').setAttribute('aria-label', 'Play');
  cancelAnimationFrame(drawFrame);
};
player.ontimeupdate = () => {
  $('playhead').textContent = clock(player.currentTime);
  $('seek').value = player.currentTime;
  if (state.stopAt !== null && player.currentTime >= state.stopAt) {
    if (state.loop) {
      player.currentTime = state.selection.start;
      state.stopAt = state.selection.end;
    } else {
      player.pause();
      state.stopAt = null;
    }
  }
  if (state.project && Date.now() - playbackSavedAt > 15000) {
    playbackSavedAt = Date.now();
    dirty();
  }
  const current = visibleWords.find(
    (w) => w.start <= player.currentTime && w.end > player.currentTime,
  )?.id;
  if (current !== playingWord) {
    if (playingWord !== null)
      $('transcriptList')
        .querySelector(`[data-word="${playingWord}"]`)
        ?.classList.remove('playing');
    if (current !== undefined)
      $('transcriptList').querySelector(`[data-word="${current}"]`)?.classList.add('playing');
    playingWord = current ?? null;
  }
  draw();
};
player.onerror = () => {
  if (state.project?.duration)
    toast(
      'Playback could not load. Reopen this project to refresh its audio link, or check that this browser supports the source format.',
      true,
    );
};
function animate() {
  if (state.stopAt !== null && player.currentTime >= state.stopAt) {
    if (state.loop) {
      player.currentTime = state.selection.start;
      state.stopAt = state.selection.end;
    } else {
      player.pause();
      state.stopAt = null;
    }
  }
  draw();
  if (!player.paused) drawFrame = requestAnimationFrame(animate);
}
function fit() {
  const p = state.project,
    c = state.selection;
  if (!p || !c) return;
  const pad = Math.max(2, (c.end - c.start) * 0.15);
  state.view = { start: Math.max(0, c.start - pad), end: Math.min(p.duration, c.end + pad) };
  requestDetail();
  draw();
}
function zoom(multiplier) {
  const p = state.project;
  if (!p) return;
  const width = Math.max(2, Math.min(p.duration, (state.view.end - state.view.start) * multiplier));
  const center = (state.view.start + state.view.end) / 2;
  state.view.start = Math.max(0, Math.min(p.duration - width, center - width / 2));
  state.view.end = state.view.start + width;
  requestDetail();
  draw();
}
$('zoomIn').onclick = () => zoom(0.5);
$('zoomOut').onclick = () => zoom(2);
$('fitSelection').onclick = fit;
let detailTimer,
  detailController,
  detailPeaks = null;
function requestDetail() {
  clearTimeout(detailTimer);
  detailPeaks = null;
  if (!state.project || state.demo || state.view.end - state.view.start > 300) return;
  const { start, end } = state.view,
    id = state.project.id;
  detailTimer = setTimeout(
    () =>
      run(async () => {
        detailController?.abort();
        detailController = new AbortController();
        try {
          const data = await api(`/api/projects/${id}/waveform?start=${start}&end=${end}`, {
            signal: detailController.signal,
          });
          if (state.project?.id === id && state.view.start === start && state.view.end === end) {
            detailPeaks = { start, end, values: data.values };
            draw();
          }
        } catch (error) {
          if (error.name !== 'AbortError')
            console.debug('Detailed waveform unavailable:', error.message);
        }
      }),
    300,
  );
}
function drawCanvas(canvas, start, end, overview = false) {
  const p = state.project;
  if (!p) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const scale = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * scale),
    height = Math.round(rect.height * scale);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = overview ? '#191a1a' : '#111313';
  ctx.fillRect(0, 0, width, height);
  const c = state.selection,
    span = Math.max(0.1, end - start);
  const x = (t) => ((t - start) / span) * width;
  if (c) {
    ctx.fillStyle = overview ? '#e4ed9b18' : '#e4ed9b12';
    ctx.fillRect(x(c.start), 0, x(c.end) - x(c.start), height);
  }
  const peaks = !overview && detailPeaks ? detailPeaks.values : p.envelope;
  const sourceStart = !overview && detailPeaks ? detailPeaks.start : 0,
    sourceEnd = !overview && detailPeaks ? detailPeaks.end : p.duration;
  for (let i = 0; i < Math.ceil(rect.width / 3); i++) {
    const time = start + (i / (rect.width / 3)) * span;
    const index = Math.floor(
      ((time - sourceStart) / Math.max(0.1, sourceEnd - sourceStart)) * peaks.length,
    );
    const value = peaks[index] || 0.025;
    const bh = Math.max(2 * scale, value * height * 0.72);
    ctx.fillStyle = c && time >= c.start && time <= c.end ? '#d5df9c' : '#5a6257';
    ctx.fillRect(i * 3 * scale, (height - bh) / 2, Math.max(1, scale), bh);
  }
  if (c) {
    for (const t of [c.start, c.end]) {
      const at = x(t);
      ctx.fillStyle = '#e4ed9b';
      ctx.fillRect(at - 1 * scale, 0, 2 * scale, height);
      if (!overview && at >= 0 && at <= width) {
        ctx.fillRect(at - 4 * scale, height / 2 - 12 * scale, 8 * scale, 24 * scale);
      }
    }
  }
  const current = x(player.currentTime);
  ctx.fillStyle = '#f4f4e8';
  ctx.fillRect(current, 0, scale, height);
  if (overview) {
    ctx.strokeStyle = '#e4ed9b55';
    ctx.strokeRect(
      x(state.view.start),
      1,
      Math.max(1, x(state.view.end) - x(state.view.start)),
      height - 2,
    );
  }
}
function draw() {
  if (!state.project) return;
  drawCanvas($('overview'), 0, state.project.duration, true);
  drawCanvas($('waveform'), state.view.start, state.view.end);
  $('viewStart').textContent = clock(state.view.start, true);
  $('viewEnd').textContent = clock(state.view.end, true);
  $('viewLabel').textContent =
    state.view.end - state.view.start < state.project.duration
      ? 'DETAIL / DRAG EDGES'
      : 'EPISODE OVERVIEW';
}
new ResizeObserver(draw).observe($('waveform'));
$('overview').onpointerdown = (e) => {
  const r = e.currentTarget.getBoundingClientRect(),
    time = ((e.clientX - r.left) / r.width) * state.project.duration;
  seek(time);
  if (state.view.end - state.view.start < state.project.duration) {
    const width = state.view.end - state.view.start;
    state.view.start = Math.max(0, Math.min(state.project.duration - width, time - width / 2));
    state.view.end = state.view.start + width;
    requestDetail();
    draw();
  }
};
let drag = null;
$('waveform').onpointerdown = (e) => {
  if (!state.selection || !state.project.duration) return;
  const r = e.currentTarget.getBoundingClientRect(),
    x = e.clientX - r.left,
    span = state.view.end - state.view.start;
  const start = ((state.selection.start - state.view.start) / span) * r.width,
    end = ((state.selection.end - state.view.start) / span) * r.width;
  const target = Math.abs(x - start) < 18 ? 'start' : Math.abs(x - end) < 18 ? 'end' : null;
  if (target) {
    history();
    drag = target;
    e.currentTarget.setPointerCapture(e.pointerId);
  } else seek(state.view.start + (x / r.width) * span);
};
$('waveform').onpointermove = (e) => {
  if (!drag) return;
  const r = e.currentTarget.getBoundingClientRect();
  adjust(
    drag,
    state.view.start + ((e.clientX - r.left) / r.width) * (state.view.end - state.view.start),
    false,
  );
};
$('waveform').onpointerup = $('waveform').onpointercancel = () => {
  drag = null;
};
function renderProcessing() {
  const p = state.project;
  if (!p) return;
  const active = (p.jobs || []).find(
      (j) => ['queued', 'running'].includes(j.state) && j.type !== 'export',
    ),
    failed = (p.jobs || []).find((j) => j.state === 'failed' && j.type !== 'export');
  const latest = (p.jobs || []).find((j) => j.type !== 'export');
  const message = active
    ? active.progress || `${active.type} queued`
    : p.error || (latest?.state === 'failed' ? latest.error : '');
  $('processing').hidden = !message;
  $('processing').classList.toggle('failed', !active && !!message);
  $('processingText').textContent = message;
  $('retryButton').hidden = !!active || !failed;
  $('cancelProcessing').hidden = !active;
}
$('cancelProcessing').onclick = () =>
  run(async () => {
    const job = state.project.jobs.find(
      (j) => ['queued', 'running'].includes(j.state) && j.type !== 'export',
    );
    if (!job) return;
    if (
      !confirm('Stop after the current step? Any AI request already submitted may still be billed.')
    )
      return;
    await post(`/api/projects/${state.project.id}/jobs/${job.id}/cancel`);
    await poll();
    toast('Stopping after the current step.');
  });
$('retryButton').onclick = () =>
  run(async () => {
    const job = state.project.jobs.find((j) => j.state === 'failed' && j.type !== 'export');
    if (!job) return;
    const ai = ['transcribe', 'analyze', 'search'].includes(job.type);
    if (
      ai &&
      !confirm(
        'Retry this AI stage? If a request was interrupted, the provider may have already charged for it. You can also recover its transcript ID from project options.',
      )
    )
      return;
    await post(`/api/projects/${state.project.id}/jobs/${job.id}/retry`, { confirm: true });
    await poll();
  });
async function poll() {
  if (pollBusy || !state.token || !state.project || state.demo) return;
  pollBusy = true;
  const id = state.project.id;
  try {
    const status = await api(`/api/projects/${id}/status`);
    if (state.project?.id !== id) return;
    if (
      status.revision === state.project.revision &&
      JSON.stringify(status.jobs) === JSON.stringify(state.project.jobs)
    )
      return;
    const p = await api(`/api/projects/${id}`);
    if (state.project?.id !== id) return;
    const before = state.project;
    const wordsChanged = p.words.length !== before.words.length;
    const jobsChanged = JSON.stringify(p.jobs) !== JSON.stringify(before.jobs);
    const suggestionsChanged = p.suggestions.length !== before.suggestions.length;
    if (state.dirty || state.saving || state.conflict) {
      const local = editable();
      state.project = { ...p, ...local, editRevision: before.editRevision };
    } else {
      state.project = p;
      state.selection = p.draft || state.selection;
    }
    if (!player.getAttribute('src') && p.importComplete) {
      player.src = endpoint(p.mediaUrl);
      player.load();
      $('playerDock').hidden = false;
      $('seek').max = p.duration;
      $('totalDuration').textContent = clock(p.duration);
      state.selection.end = Math.min(p.duration, 30);
      state.view = { start: 0, end: p.duration };
      renderEditor();
    }
    $('episodeTitle').textContent = state.project.title;
    $('episodeInfo').textContent =
      `${clock(p.duration)} / ${p.channels || '—'} CHANNEL${p.channels === 1 ? '' : 'S'} / ${(p.bytes / 1024 ** 2).toFixed(1)} MB`;
    renderProcessing();
    if (wordsChanged || suggestionsChanged) renderBrowse();
    else if (jobsChanged) {
      renderMoments();
      renderShortlist();
    }
    if (jobsChanged) {
      await loadExportLinks();
      renderExportJobs();
      state.config = await api('/api/config');
      await loadProjects();
    }
  } catch (error) {
    if (error.status === 401) toast('Your workspace session expired. Reconnect in settings.', true);
    else console.debug(error.message);
  } finally {
    pollBusy = false;
  }
}
setInterval(() => run(poll), 3000);
function showExport(clips) {
  if (state.demo) {
    toast('The tour uses a test tone. Connect your workspace to export your recordings.');
    return;
  }
  state.exportClips = clone(clips);
  $('exportSummary').textContent =
    `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${clock(clips.reduce((s, c) => s + c.end - c.start, 0))} of audio`;
  $('exportFormat').value = 'mp3';
  $('exportFade').checked = false;
  $('exportNormalize').checked = false;
  dialog('exportDialog');
  run(async () => {
    await loadExportLinks();
    renderExportJobs();
  });
}
$('exportCurrent').onclick = () => {
  if (state.selection) showExport([{ ...state.selection, title: state.selection.title || 'Clip' }]);
};
$('exportAll').onclick = () => {
  const selected = [...document.querySelectorAll('.export-choice:checked')].map((el) => el.value);
  showExport(state.project.clips.filter((c) => !selected.length || selected.includes(c.id)));
};
$('beginExport').onclick = () =>
  run(async () => {
    await flush();
    $('beginExport').disabled = true;
    try {
      await post(`/api/projects/${state.project.id}/export`, {
        clips: state.exportClips,
        format: $('exportFormat').value,
        options: { fade: $('exportFade').checked, normalize: $('exportNormalize').checked },
      });
      toast('Export queued. The download will appear here.');
      await poll();
    } finally {
      $('beginExport').disabled = false;
    }
  });
async function loadExportLinks() {
  if (!state.project || state.demo) return;
  const p = state.project;
  for (const j of (p.jobs || []).filter(
    (j) => j.type === 'export' && j.state === 'done' && j.downloadReady,
  )) {
    const old = state.downloadLinks.get(j.id);
    if (old && Date.now() - old.at < 600000) continue;
    try {
      const result = await api(`/api/projects/${p.id}/download/${j.id}`);
      state.downloadLinks.set(j.id, { ...result, at: Date.now() });
    } catch {}
  }
}
function renderExportJobs() {
  const p = state.project;
  if (!p) return;
  $('exportJobs').innerHTML = (p.jobs || [])
    .filter((j) => j.type === 'export')
    .slice(0, 10)
    .map((j) => {
      const link = state.downloadLinks.get(j.id);
      return `<div class="export-job"><strong>${escapeHTML(j.payload.format.toUpperCase())}</strong> · ${j.payload.clips.length} clip${j.payload.clips.length === 1 ? '' : 's'} · ${escapeHTML(j.state)}${j.error ? `<p class="error">${escapeHTML(j.error)}</p><button class="text-button" data-retry-export="${j.id}">retry export</button>` : ''}${link ? `<a href="${escapeHTML(endpoint(link.url))}" download="${escapeHTML(link.name)}">download ${escapeHTML(link.name)} ↗</a>${/\.(mp3|wav)$/.test(link.name) ? `<audio controls preload="none" src="${escapeHTML(endpoint(link.url))}" style="width:100%;margin-top:12px"></audio>` : ''}` : ''}</div>`;
    })
    .join('');
}
$('exportJobs').onclick = (e) => {
  const b = e.target.closest('[data-retry-export]');
  if (b)
    run(async () => {
      await post(`/api/projects/${state.project.id}/jobs/${b.dataset.retryExport}/retry`, {
        confirm: true,
      });
      await poll();
    });
};
$('projectMenu').onclick = () => dialog('optionsDialog');
function downloadJSON(data, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('backupProject').onclick = () => {
  const p = state.project;
  downloadJSON(
    {
      schema: 2,
      project: { ...p, ...editable(), mediaUrl: undefined, jobs: undefined, demoUrl: undefined },
    },
    `clipper-${p.id}.json`,
  );
  toast('Backup downloaded. Keep the original audio alongside it.');
};
$('renameProject').onclick = () => {
  const title = prompt('Episode title', state.project.title);
  if (title) {
    history();
    state.project.title = title;
    dirty();
    $('episodeTitle').textContent = title;
  }
};
$('restoreBackup').onchange = (e) =>
  run(async () => {
    const file = e.target.files[0];
    if (!file) return;
    if (state.demo) throw new Error('Connect your workspace to restore a recording project.');
    if (file.size > 16 * 1024 ** 2) throw new Error('Backup exceeds the 16 MB limit.');
    const backup = JSON.parse(await file.text());
    if (
      !confirm(
        'Replace this project’s transcript and edits with the backup? The original audio must match.',
      )
    )
      return;
    await flush();
    await post(`/api/projects/${state.project.id}/restore`, backup);
    await openProject(state.project.id);
    $('optionsDialog').close();
    toast('Project restored.');
  });
$('recoverTranscript').onclick = () =>
  run(async () => {
    if (state.demo) throw new Error('Connect your workspace first.');
    const id = prompt('AssemblyAI transcript ID (find it in your provider dashboard)');
    if (id) {
      await post(`/api/projects/${state.project.id}/recover-transcript`, { transcriptId: id });
      $('optionsDialog').close();
      await poll();
    }
  });
$('clearExports').onclick = () =>
  run(async () => {
    if (state.demo) return;
    if (
      !confirm(
        'Delete generated export files? Your audio, transcript, and saved clip edits will stay.',
      )
    )
      return;
    await api(`/api/projects/${state.project.id}/exports`, { method: 'DELETE' });
    state.downloadLinks.clear();
    await poll();
    toast('Old export files cleared.');
  });
$('deleteProject').onclick = () =>
  run(async () => {
    if (state.demo) {
      $('optionsDialog').close();
      return;
    }
    if (
      !confirm(
        'Delete this project, imported recording, transcript, and exports? Download a backup first if you want to keep your edits.',
      )
    )
      return;
    await flush();
    await api(`/api/projects/${state.project.id}`, { method: 'DELETE' });
    player.pause();
    state.project = null;
    $('optionsDialog').close();
    $('studio').hidden = true;
    $('playerDock').hidden = true;
    $('welcome').hidden = false;
    await loadProjects();
    toast('Project deleted.');
  });
$('helpButton').onclick = () => dialog('helpDialog');
document.addEventListener('keydown', (e) => {
  if (
    !state.project ||
    document.querySelector('dialog[open]') ||
    e.target.matches('input,textarea,select,[contenteditable=true]') ||
    (e.target.closest('button') && e.key === ' ')
  )
    return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo(e.shiftKey);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === ' ') {
    e.preventDefault();
    $('playPause').click();
  } else if (key === 'arrowleft' || key === 'arrowright') {
    e.preventDefault();
    seek(player.currentTime + (key === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 0.5 : 5));
  } else if (key === 'i') adjust('start', player.currentTime);
  else if (key === 'o') adjust('end', player.currentTime);
  else if (key === 'k') keep();
  else if (key === 'n') skipCandidate();
});
window.addEventListener('beforeunload', (e) => {
  if (state.dirty && !state.demo) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.dirty) run(save);
});
$('demoButton').onclick = () =>
  run(async () => {
    await flush();
    state.demo = true;
    const duration = 90,
      rate = 8000,
      channels = 2,
      count = duration * rate;
    const buffer = new ArrayBuffer(44 + count * channels * 2),
      v = new DataView(buffer);
    const str = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, buffer.byteLength - 8, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, channels, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * channels * 2, true);
    v.setUint16(32, channels * 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, count * channels * 2, true);
    for (let i = 0; i < count; i++) {
      const gain = (Math.sin((i / rate) * 1.8) * 0.5 + 0.5) * 0.025;
      v.setInt16(44 + i * 4, Math.sin((i / rate) * Math.PI * 440) * 32767 * gain, true);
      v.setInt16(46 + i * 4, Math.sin((i / rate) * Math.PI * 660) * 32767 * gain, true);
    }
    const phrases = [
      ['A', 'This is sample dialogue for the editor tour. The audio is a quiet test tone.'],
      [
        'B',
        'Try selecting these words to make a clip. You can change either edge of the selection.',
      ],
      ['A', 'Keep a moment and it appears in the shortlist. Your edits are saved on this device.'],
      [
        'B',
        'The real workspace brings in your episodes and helps find the exchanges worth listening through.',
      ],
      [
        'A',
        'Use the detailed waveform to move an edge. Preview the beginning and ending before you export.',
      ],
      ['B', 'You can also search the transcript, name your clips, and leave a note for yourself.'],
    ];
    let id = 0;
    const words = [];
    phrases.forEach(([speaker, line], index) =>
      line.split(' ').forEach((word, j) =>
        words.push({
          id: id++,
          text: word,
          speaker,
          start: index * 15 + j * 0.55,
          end: index * 15 + j * 0.55 + 0.45,
        }),
      ),
    );
    const suggestions = [
      {
        id: 'tour1',
        title: 'Try shaping a moment',
        reason:
          'This is a sample card showing where editorial suggestions will appear. The test tone does not speak this dialogue.',
        context: 'Editor tour — not a real Yellow Five clip.',
        type: 'SAMPLE',
        start: 15,
        end: 27,
        variants: { short: { start: 15, end: 22 }, full: { start: 15, end: 30 } },
      },
      {
        id: 'tour2',
        title: 'Keep a little collection',
        reason: 'Try keeping this sample, then open the kept tab to see your shortlist.',
        type: 'SAMPLE',
        start: 30,
        end: 42,
        variants: {},
      },
    ];
    const saved = JSON.parse(localStorage.getItem('clipper.tour') || 'null');
    const project = {
      id: 'tour',
      title: 'A little look around.',
      duration,
      channels,
      bytes: buffer.byteLength,
      words,
      suggestions,
      chapters: [
        { title: 'Meet the editor', start: 0 },
        { title: 'Make your cut', start: 60 },
      ],
      envelope: Array.from(
        { length: 2400 },
        (_, i) => (Math.sin(i * 0.15) * 0.5 + 0.5) * 0.7 + 0.05,
      ),
      clips: [],
      feedback: [],
      speakerNames: {},
      corrections: {},
      suggestionStates: {},
      playback: 0,
      jobs: [],
      editRevision: 0,
      ...saved,
      demoUrl: URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' })),
    };
    enterProject(project);
    toast('Editor tour: sample text and a quiet test tone. Nothing is uploaded.');
  });
if (state.token && state.base)
  run(async () => {
    try {
      state.config = await api('/api/config');
      document.body.classList.add('connected');
      await loadProjects();
      const last = localStorage.getItem('clipper.lastProject');
      if (last && state.projects.some((p) => p.id === last)) await openProject(last);
    } catch (error) {
      $('welcomeNote').textContent =
        'Reconnect your workspace in settings to continue your saved episodes.';
      throw error;
    }
  });
