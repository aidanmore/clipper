'use strict';

const $ = id => document.getElementById(id);
const C = ClipCore;
const REPO = 'aidanmore/clipper';
const RAW = 'https://raw.githubusercontent.com/' + REPO + '/main/';
const FEED = 'https://anchor.fm/s/1014cea94/podcast/rss';
const STORE = 'y5-clipper-v2';
const player = $('player');
const state = { episodes: [], current: null, duration: 0, start: 0, end: 30, view: 0,
  analysis: null, localBuffer: null, objectUrl: null, editing: null, preview: null,
  revision: 0, pendingSeek: 0, idea: null, visible: 20, frame: 0, busy: false };
let storageAvailable = true;
let saved;
try { saved = JSON.parse(localStorage.getItem(STORE)) || {}; } catch { saved = {}; }
if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
saved.episodes ||= {}; saved.version = 2;
let saveTimer, statusTimer, lastPositionSave = 0;
const waveCaches = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, className = '') {
  const node = element('button', className, text);
  node.type = 'button'; node.addEventListener('click', action); return node;
}
function status(text, error = false) {
  $('status').textContent = text; $('status').dataset.error = error;
  clearTimeout(statusTimer);
  if (text && !error) statusTimer = setTimeout(() => { $('status').textContent = ''; }, 8000);
}
function id() { return crypto.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
function persist() {
  try { localStorage.setItem(STORE, JSON.stringify(saved)); storageAvailable = true; }
  catch { storageAvailable = false; }
  $('draftStatus').textContent = storageAvailable ? 'Drafts saved on this device' : 'Storage full or unavailable — use Backup';
}
function currentDraft() { return state.current ? (saved.episodes[state.current.guid] ||= {clips: [], reviewed: []}) : null; }
function remember(immediate = false) {
  if (!state.current) return;
  Object.assign(currentDraft(), {start: state.start, end: state.end, position: player.currentTime || 0,
    name: $('clipName').value, title: state.current.title});
  if (!state.current.local) saved.last = state.current.guid;
  clearTimeout(saveTimer);
  if (immediate) persist(); else saveTimer = setTimeout(persist, 350);
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
}
function https(value) { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } }
async function request(url, type = 'json') {
  const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
  if (!response.ok) { const e = new Error('Request failed (' + response.status + ')'); e.code = response.status; throw e; }
  return type === 'text' ? response.text() : response.json();
}
async function shortHash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('').slice(0,20);
}
async function parseFeed(raw) {
  const xml = new DOMParser().parseFromString(raw, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Unreadable podcast feed');
  return (await Promise.all([...xml.querySelectorAll('channel > item')].map(async item => {
    const itunes = name => item.getElementsByTagNameNS('http://www.itunes.com/dtds/podcast-1.0.dtd', name)[0];
    const guid = item.querySelector('guid')?.textContent.trim();
    const audio = https(item.querySelector('enclosure')?.getAttribute('url'));
    if (!guid || !audio) return null;
    return {guid, audio, key: await shortHash(guid), fingerprint: await shortHash(audio),
      title: item.querySelector('title')?.textContent || 'Yellow Five', number: itunes('episode')?.textContent || '',
      duration: C.parseTime(itunes('duration')?.textContent || '0') || 0,
      date: item.querySelector('pubDate')?.textContent || '', cover: https(itunes('image')?.getAttribute('href'))};
  }))).filter(Boolean).sort((a,b) => new Date(b.date) - new Date(a.date));
}
async function archive() {
  $('refreshArchive').disabled = true;
  $('archiveStatus').textContent = 'Refreshing live episodes…';
  let label = 'live episodes';
  try {
    try { state.episodes = await parseFeed(await request(FEED, 'text')); }
    catch {
      try { state.episodes = (await request(RAW + 'data/catalog.json')).episodes; }
      catch { state.episodes = (await request('data/catalog.json')).episodes; }
      label = 'episodes · saved archive; live feed unavailable';
    }
    if (!state.episodes.length) throw new Error('The feed contains no episodes');
    $('archiveStatus').textContent = state.episodes.length + ' ' + label;
    renderEpisodes();
    const last = state.episodes.find(e => e.guid === saved.last);
    $('resume').hidden = !last;
    if (last) {
      $('resume').textContent = '↳ Resume ' + last.title + ' · ' + C.time(saved.episodes[last.guid]?.position || 0);
      $('resume').onclick = () => openEpisode(last);
    }
  } catch { $('archiveStatus').textContent = 'Couldn’t load the archive. Tap Refresh to retry, or open your own audio.'; }
  finally { $('refreshArchive').disabled = false; }
}
function renderEpisodes() {
  const query = C.normalizeSearch($('search').value);
  let episodes = state.episodes.filter(e => C.normalizeSearch(e.title).includes(query) || C.normalizeSearch(e.number) === query);
  if ($('sort').value === 'old') episodes = [...episodes].reverse();
  const nodes = episodes.slice(0,state.visible).map(episode => {
    const card = button('', () => openEpisode(episode), 'episode-card');
    card.setAttribute('aria-label', 'Open ' + episode.title);
    const art = element('div', 'episode-art');
    if (episode.cover) { const img = element('img'); img.src = episode.cover; img.alt = ''; img.loading = 'lazy'; art.append(img); }
    const count = saved.episodes[episode.guid]?.clips?.length || 0;
    card.append(art, element('p','eyebrow', 'EPISODE ' + (episode.number || '—') + (count ? ' · ' + count + ' SAVED' : '')),
      element('h2','',episode.title), element('p','meta',[dateLabel(episode.date),episode.duration ? C.time(episode.duration) : ''].filter(Boolean).join(' / ')));
    return card;
  });
  if (!nodes.length) nodes.push(element('p','muted','No episodes match that search.'));
  $('episodes').replaceChildren(...nodes); $('moreEpisodes').hidden = episodes.length <= state.visible;
}

function openEpisode(episode, link = null) {
  remember(true); player.pause(); state.preview = null; state.revision++;
  if (state.objectUrl && !episode.local) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  state.current = episode; state.duration = episode.duration || 0; state.analysis = null; state.localBuffer = null;
  state.editing = null; state.idea = null; waveCaches.clear();
  const draft = currentDraft(); draft.clips ||= []; draft.reviewed ||= [];
  const restored = C.selection(link?.start ?? draft.start ?? 0, link?.end ?? draft.end ?? 30, state.duration || 3600);
  Object.assign(state,restored);
  state.pendingSeek = link?.start ?? draft.position ?? state.start;
  $('clipName').value = link ? '' : draft.name || '';
  $('episodeTitle').textContent = episode.title;
  $('episodeDate').textContent = episode.local ? 'YOUR AUDIO' : dateLabel(episode.date);
  $('episodeInfo').textContent = episode.local ? 'Opened on this device' : 'Original episode audio · choose a moment and make the cut';
  $('episodeCover').hidden = !episode.cover; if (episode.cover) $('episodeCover').src = episode.cover;
  $('sourceMode').textContent = episode.local ? 'LOCAL FILE' : 'LIVE SOURCE';
  $('library').hidden = true; $('studio').hidden = false; $('transport').hidden = false;
  $('idea').hidden = true; $('nextIdea').disabled = true;
  $('waveStatus').textContent = 'Loading waveform…'; $('discoveryStatus').textContent = 'Loading prepared audio analysis…';
  player.src = episode.audio; player.load(); player.playbackRate = Number($('speed').value);
  centerSelection(); updateSelection(false); renderTray(); updateClock();
  setPageUrl(); window.scrollTo({top:0});
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.metadata = new MediaMetadata({title: episode.title,artist:'Yellow Five',artwork:episode.cover?[{src:episode.cover}]:[]}); } catch {}
  }
  if (!episode.local) loadAnalysis(episode, state.revision);
  else { $('waveStatus').textContent = 'Timeline ready'; $('discoveryStatus').textContent = 'Preparing this file…'; }
}
function setPageUrl() {
  const url = new URL(location.href);
  if (state.current && !state.current.local) url.searchParams.set('episode',state.current.guid);
  else url.searchParams.delete('episode');
  url.searchParams.delete('start'); url.searchParams.delete('end');
  history.replaceState(null,'',url);
}
async function loadAnalysis(episode, revision) {
  let analysis;
  for (const url of ['data/analysis/' + episode.key + '.json', RAW + 'data/analysis/' + episode.key + '.json']) {
    try { const candidate = await request(url); if (candidate.fingerprint === episode.fingerprint) { analysis = candidate; break; } } catch {}
  }
  if (revision !== state.revision) return;
  if (analysis) {
    state.analysis = analysis; state.duration = analysis.duration; applyDuration();
    $('waveStatus').textContent = 'Waveform ready';
    $('discoveryStatus').textContent = 'Audio activity + energy changes. Explore a suggestion, then trust your ear.';
    $('nextIdea').disabled = false;
  } else {
    $('waveStatus').textContent = 'Seek timeline · waveform preparing';
    $('discoveryStatus').textContent = 'This episode’s waveform and suggestions are still preparing. You can listen, trim, save, and export now. Surprise me picks a random spot.';
  }
  waveCaches.clear(); draw();
}
function applyDuration() {
  if (!state.duration) return;
  const bounds=C.selection(state.start,state.end,state.duration);
  const changed=bounds.start!==state.start||bounds.end!==state.end;
  Object.assign(state,bounds);
  $('seek').max = state.duration; $('pan').max = Math.max(0,state.duration - viewSpan());
  $('durationLabel').textContent = C.time(state.duration); $('transportDuration').textContent = ' / ' + C.time(state.duration);
  state.view = C.clamp(state.view,0,Math.max(0,state.duration-viewSpan())); applyPanLimit();
  if(changed)updateSelection(false);else draw();
}
function updateSelection(save = true) {
  $('startTime').value = C.time(state.start,true); $('endTime').value = C.time(state.end,true);
  $('clipLength').textContent = (state.end-state.start).toFixed(1) + 's';
  $('saveClip').textContent = state.editing ? '✓ Update clip' : '+ Save clip';
  $('cancelEdit').hidden = !state.editing;
  if (save) { state.preview = null; remember(); }
  draw();
}
function setSelection(start,end,center = false) {
  Object.assign(state,C.selection(start,end,state.duration || 3600));
  if (center) centerSelection(); updateSelection();
}
function setEdge(edge,value) {
  if (edge === 'start') state.start = C.clamp(value,0,state.end-.5);
  else state.end = C.clamp(value,state.start+.5,state.duration || 3600);
  updateSelection();
}
function commitTimeFields() {
  const start=C.parseTime($('startTime').value),end=C.parseTime($('endTime').value);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<.5||end>(state.duration||3600)+.05){status('Choose valid start and end timestamps, at least 0.5 seconds apart.',true);return false}
  if(Math.abs(start-state.start)>.001||Math.abs(end-state.end)>.001)setSelection(start,end);
  return true;
}
function viewSpan() { return Math.min(Number($('zoom').value),state.duration || Number($('zoom').value)); }
function centerAt(time) {
  state.view = C.clamp(time - viewSpan()/2,0,Math.max(0,(state.duration || 3600)-viewSpan()));
  $('pan').value = state.view; waveCaches.delete('detail'); draw();
}
function centerSelection() {
  const length = state.end-state.start;
  const choice = [3,10,30,60,120].find(v => v >= length*1.2) || 120;
  $('zoom').value = String(choice); centerAt((state.start+state.end)/2); applyPanLimit();
}
function applyPanLimit() { $('pan').max = Math.max(0,(state.duration || 3600)-viewSpan()); $('pan').value = state.view; }
function seekTo(time,keepPreview = false) {
  if (!state.current) return;
  time = C.clamp(time,0,state.duration || 3600);
  if (!keepPreview) state.preview = null;
  if (player.readyState >= 1) { try { player.currentTime = time; } catch { state.pendingSeek = time; } }
  else state.pendingSeek = time;
  updateClock(); draw();
}
async function play() {
  try { await player.play(); }
  catch (error) { if(error.name !== 'AbortError') status('Tap play again when the audio finishes loading.',true); }
}
function togglePlay() { if (player.paused) play(); else player.pause(); }
function preview() {
  if(!commitTimeFields())return;
  const context = $('context').checked ? 2 : 0;
  state.preview = {start: Math.max(0,state.start-context),end: Math.min(state.duration || 3600,state.end+context)};
  seekTo(state.preview.start,true); centerAt((state.start+state.end)/2); play();
}
function updateClock() {
  $('currentTime').textContent = C.time(player.currentTime);
  $('seek').value = player.currentTime || 0;
}
function playbackTick() {
  if (state.preview && player.currentTime >= state.preview.end) {
    if ($('loop').checked) seekTo(state.preview.start,true);
    else { player.pause(); state.preview = null; }
  }
  updateClock(); draw();
  if (!player.paused) state.frame = requestAnimationFrame(playbackTick);
}

function baseWave(canvas,start,span) {
  const bounds=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2);
  const width=Math.max(1,Math.round(bounds.width)),height=Math.max(1,Math.round(bounds.height));
  if(canvas.width!==width*ratio||canvas.height!==height*ratio){canvas.width=width*ratio;canvas.height=height*ratio;waveCaches.delete(canvas.id)}
  const key=[start,span,width,height,!!state.analysis].join('/');
  let cache=waveCaches.get(canvas.id);
  if(!cache||cache.key!==key){
    const image=document.createElement('canvas');image.width=canvas.width;image.height=canvas.height;
    const ctx=image.getContext('2d');ctx.scale(ratio,ratio);ctx.fillStyle='#13160f';ctx.fillRect(0,0,width,height);
    if(state.analysis){
      const a=state.analysis,step=a.peakStep;
      ctx.fillStyle='#7f896f';
      for(let x=0;x<width;x+=2){
        const first=Math.floor((start+x/width*span)/step),last=Math.min(a.peaks.length,Math.max(first+1,Math.floor((start+(x+2)/width*span)/step)));
        let max=0;for(let j=first;j<last;j++)max=Math.max(max,a.peaks[j]||0);
        const h=Math.max(1,(max/255)**.7*(height-18));ctx.fillRect(x,(height-h)/2,1.3,h);
      }
    }else{
      ctx.strokeStyle='#2b3323';ctx.beginPath();ctx.moveTo(0,height/2);ctx.lineTo(width,height/2);ctx.stroke();
      ctx.fillStyle='#7d8770';ctx.font='11px Arial';ctx.fillText('Seek and mark while the waveform prepares',12,height/2-12);
    }
    const interval=span>600?600:span>120?60:span>30?10:span>10?5:1;
    ctx.strokeStyle='#ffffff0c';for(let t=Math.ceil(start/interval)*interval;t<start+span;t+=interval){const x=(t-start)/span*width;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke()}
    cache={key,image};waveCaches.set(canvas.id,cache);
  }
  const ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(cache.image,0,0);ctx.scale(ratio,ratio);
  const left=(state.start-start)/span*width,right=(state.end-start)/span*width;
  ctx.fillStyle='#d8ef9428';ctx.fillRect(Math.max(0,left),0,Math.max(0,Math.min(width,right)-Math.max(0,left)),height);
  ctx.strokeStyle='#d8ef94';ctx.lineWidth=1;ctx.strokeRect(left+.5,.5,right-left,height-1);
  const now=(player.currentTime-start)/span*width;if(now>=0&&now<=width){ctx.strokeStyle='#f5f5ed';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(now,0);ctx.lineTo(now,height);ctx.stroke()}
  return width;
}
function draw() {
  if(!state.current||$('studio').hidden)return;
  const span=viewSpan(),duration=state.duration||3600;
  baseWave($('overview'),0,duration);
  const width=baseWave($('detail'),state.view,span);
  for(const edge of ['start','end']){
    const x=(state[edge]-state.view)/span*width,handle=$(edge+'Handle');
    handle.hidden=x<0||x>width;
    handle.style.left=C.clamp(x-(edge==='start'?28:0),0,width-28)+'px';
  }
  $('viewStart').textContent=C.time(state.view,true);$('viewEnd').textContent=C.time(state.view+span,true);
}
function bindHandle(edge) {
  const handle=$(edge+'Handle');let dragging=false;
  const move=e=>{if(!dragging)return;const r=$('detail').getBoundingClientRect();setEdge(edge,state.view+C.clamp((e.clientX-r.left)/r.width,0,1)*viewSpan())};
  handle.addEventListener('pointerdown',e=>{dragging=true;handle.setPointerCapture(e.pointerId);e.preventDefault()});
  handle.addEventListener('pointermove',move);
  handle.addEventListener('pointerup',e=>{move(e);dragging=false;remember(true)});
  handle.addEventListener('pointercancel',()=>{dragging=false});
  handle.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();setEdge(edge,state[edge]+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?1:.1))}});
}

function clearEdit(){state.editing=null;$('clipName').value='';updateSelection()}
function saveClip() {
  if(!commitTimeFields())return;
  const draft=currentDraft();if(!draft)return;
  const clip={id:state.editing||id(),start:Number(state.start.toFixed(2)),end:Number(state.end.toFixed(2)),
    name:$('clipName').value.trim()||'Good bit '+(draft.clips.length+1)};
  const index=draft.clips.findIndex(c=>c.id===state.editing);
  if(index>=0)draft.clips[index]=clip;else draft.clips.push(clip);
  clearEdit();remember(true);renderTray();status(index>=0?'Clip updated.':'Saved to your clip tray.');
}
function renderTray() {
  const clips=currentDraft()?.clips||[];
  $('savedCount').textContent=clips.length+' CLIP'+(clips.length===1?'':'S');$('exportAll').disabled=!clips.length;
  $('clipTray').replaceChildren(...(clips.length?clips.map(clip=>{
    const row=element('div','saved-clip');row.append(element('strong','',clip.name),element('p','',C.time(clip.start,true)+' → '+C.time(clip.end,true)+' / '+(clip.end-clip.start).toFixed(1)+'s'));
    const actions=element('div','clip-actions');
    actions.append(button('▷ Hear',()=>{setSelection(clip.start,clip.end,true);preview()}),button('Edit',()=>{state.editing=clip.id;$('clipName').value=clip.name;setSelection(clip.start,clip.end,true);$('startTime').focus()}),button('Copy',()=>{currentDraft().clips.push({...clip,id:id(),name:clip.name+' copy'});remember(true);renderTray()}),button('Remove',()=>{
      const draft=currentDraft(),index=draft.clips.findIndex(c=>c.id===clip.id);draft.clips.splice(index,1);if(state.editing===clip.id)clearEdit();remember(true);renderTray();
      status('Clip removed.');const undo=button('Undo',()=>{draft.clips.splice(index,0,clip);persist();renderTray();status('Clip restored.')},'quiet small');$('status').append(' ',undo);
    }));row.append(actions);return row;
  }):[element('div','empty-tray','Nothing on the cutting room floor yet.\nHear a good bit? Tap Last 30s, then save it here.')]));
}
function length(){return C.clamp($('targetLength').value==='custom'?Number($('customLength').value)||30:Number($('targetLength').value),5,600)}
function showIdea(idea){
  state.idea=idea;const top=element('div','idea-top');top.append(element('strong','',C.time(idea.start)+' → '+C.time(idea.end)),element('span','',idea.reason));
  const actions=element('div','idea-actions');actions.append(button('▷ Listen',()=>{setSelection(idea.start,idea.end,true);preview()}),button('+ Keep',()=>{setSelection(idea.start,idea.end,true);saveClip()}),button('Skip →',()=>nextIdea(idea.reason==='Random pick'),'quiet'));
  $('idea').replaceChildren(top,actions);$('idea').hidden=false;setSelection(idea.start,idea.end,true);seekTo(idea.start);
}
function nextIdea(random=false){
  if(!state.current)return;
  const draft=currentDraft();
  if(state.idea){draft.reviewed.push(state.idea.start);draft.reviewed=draft.reviewed.slice(-500);}
  let idea;
  if(!random&&state.analysis)idea=C.candidates(state.analysis,length(),draft.reviewed)[0];
  if(!idea&&!random){status('You’ve reviewed the available suggestions for this length. Try a different length or Surprise me.');remember();return}
  if(random){const n=Math.min(length(),state.duration||3600);let start=0;for(let i=0;i<30;i++){start=Math.random()*Math.max(0,(state.duration||3600)-n);if(!draft.reviewed.some(p=>Math.abs(p-start)<Math.min(n,10)))break}idea={start,end:start+n,reason:'Random pick'}}
  showIdea(idea);remember();
}

async function copyLink(){
  if(!commitTimeFields())return;
  if(state.current.local){status('Shared links are available for archive episodes. Use Backup for this local-file draft.',true);return}
  const url=new URL(location.href);url.searchParams.set('episode',state.current.guid);url.searchParams.set('start',state.start.toFixed(2));url.searchParams.set('end',state.end.toFixed(2));
  try{await navigator.clipboard.writeText(url.href);status('Episode and clip selection link copied.')}catch{status('Copy this link: '+url.href)}
}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=element('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000)}
let exportController;
const exportUrls = [];
function exportName(episode, clip, format, index) {
  const name = String(clip.name || 'Good bit').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'clip';
  return String(index + 1).padStart(2, '0') + '-yellow-five-' + (episode.number || 'audio') + '-' + name + '-' + clip.start.toFixed(2) + '-' + clip.end.toFixed(2) + '.' + format;
}
function downloadLink(blob, name, label) {
  const url = URL.createObjectURL(blob); exportUrls.push(url);
  const a = element('a', 'button primary', label); a.href = url; a.download = name;
  return a;
}
async function exportClips(clips) {
  if (!state.current || state.busy || !clips.length) return;
  if (clips.length > 10 || clips.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end - c.start < .5 || c.end - c.start > 600 || c.end > state.duration + .05) || clips.reduce((n,c) => n + c.end - c.start, 0) > 1800) {
    status('Export up to 10 clips, 10 minutes each, 30 minutes total. Export a smaller selection.', true); return;
  }
  if (state.current.local && !state.localBuffer) { status('This local file is too large to decode. Choose its live archive episode to download clips directly.', true); return; }
  const episode = {...state.current}, localBuffer = state.localBuffer, format = $('exportFormat').value;
  clips = clips.map(c => ({...c}));
  state.busy = true; exportController = new AbortController();
  const controller = exportController;
  for (const url of exportUrls.splice(0)) URL.revokeObjectURL(url);
  $('downloadResults').replaceChildren(); $('downloadProgress').hidden = false; $('downloadProgress').value = 0;
  $('exportSummary').textContent = clips.length + ' clip' + (clips.length === 1 ? '' : 's') + ' · ' + C.time(clips.reduce((n,c) => n + c.end - c.start, 0)) + ' · ' + format.toUpperCase();
  $('exportMessage').textContent = 'Loading selected audio…'; $('exportMessage').dataset.error = false;
  $('cancelExport').textContent = 'Cancel'; $('exportDialog').showModal();
  const outputs = [];
  try {
    for (let i = 0; i < clips.length; i++) {
      const result = await DirectExport.clip(episode, clips[i], {format, signal: controller.signal, localBuffer,
        progress: (fraction, text) => {
          $('downloadProgress').value = (i + fraction) / clips.length;
          $('exportMessage').textContent = (clips.length > 1 ? 'Clip ' + (i + 1) + ' of ' + clips.length + ' · ' : '') + text;
        }});
      const name = exportName(episode, clips[i], format, i);
      outputs.push({name, blob: result.blob});
      const row = element('div', 'download-result');
      row.append(element('strong', '', clips[i].name || 'Good bit'), element('p', 'muted', C.time(clips[i].start) + ' – ' + C.time(clips[i].end) + ' · ' + (result.blob.size / 1048576).toFixed(2) + ' MB'));
      const link = downloadLink(result.blob, name, '↓ Save ' + format.toUpperCase()); row.append(link);
      if (navigator.canShare) {
        const file = new File([result.blob], name, {type: result.blob.type});
        if (navigator.canShare({files: [file]})) row.append(button('Share / Save to Files', async () => {
          try { await navigator.share({files: [file]}); } catch (error) { if (error.name !== 'AbortError') status('Use Save ' + format.toUpperCase() + ' to download the clip.', true); }
        }, 'quiet'));
      }
      const audio = element('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = link.href; audio.setAttribute('aria-label', 'Preview exported ' + (clips[i].name || 'clip')); row.append(audio);
      $('downloadResults').append(row);
      if (clips.length === 1) link.click();
    }
    if (outputs.length > 1) {
      $('exportMessage').textContent = 'Bundling your clips…';
      const files = {};
      for (const output of outputs) files[output.name] = new Uint8Array(await output.blob.arrayBuffer());
      controller.signal.throwIfAborted();
      const zip = new Blob([fflate.zipSync(files, {level: 0})], {type: 'application/zip'});
      const link = downloadLink(zip, 'yellow-five-' + (episode.number || 'clips') + '-clips.zip', '↓ Save all clips as ZIP');
      link.classList.add('wide'); $('downloadResults').prepend(link); link.click();
    }
    $('exportMessage').textContent = 'Ready. Your download has started. You can also save or share below.';
    status('Clips ready — saved directly from the clipper.');
  } catch (error) {
    $('exportMessage').textContent = error.name === 'AbortError' ? 'Export cancelled. Your saved clips are still here.' : error.message;
    $('exportMessage').dataset.error = error.name !== 'AbortError';
    if (error.name !== 'AbortError') status(error.message, true);
  } finally {
    state.busy = false; exportController = null; $('downloadProgress').hidden = true; $('cancelExport').textContent = 'Done';
  }
}

async function openLocal(file){
  if(!file)return;
  if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);
  state.objectUrl=URL.createObjectURL(file);
  const guid='local-'+await shortHash(file.name+'/'+file.size+'/'+file.lastModified);
  openEpisode({guid,title:file.name,number:'',date:'',duration:0,audio:state.objectUrl,cover:'',local:true});
  const revision=state.revision;
  if(file.size>40*1024*1024){$('discoveryStatus').textContent='Large local file: listening and drafts are ready. Open the matching archive episode to download clips directly.';$('waveStatus').textContent='Seek timeline';return}
  let ctx;
  try{
    const AudioCtx=window.AudioContext||window.webkitAudioContext;ctx=new AudioCtx();
    const buffer=await ctx.decodeAudioData(await file.arrayBuffer());if(revision!==state.revision)return;
    state.localBuffer=buffer;state.duration=buffer.duration;
    const data=buffer.getChannelData(0),peakStep=.01,energyStep=.25,peaks=[],energy=[];
    for(let i=0;i<data.length;i+=Math.max(1,Math.floor(buffer.sampleRate*peakStep))){let max=0;const end=Math.min(data.length,i+Math.floor(buffer.sampleRate*peakStep));for(let j=i;j<end;j++)max=Math.max(max,Math.abs(data[j]));peaks.push(Math.round(max*255))}
    for(let i=0;i<data.length;i+=Math.floor(buffer.sampleRate*energyStep)){let sum=0;const end=Math.min(data.length,i+Math.floor(buffer.sampleRate*energyStep));for(let j=i;j<end;j++)sum+=data[j]*data[j];energy.push(Math.round(Math.sqrt(sum/(end-i))*65535))}
    state.analysis={duration:buffer.duration,peakStep,peaks,energyStep,energy};applyDuration();waveCaches.clear();draw();$('waveStatus').textContent='Waveform ready';$('discoveryStatus').textContent='Local audio analysis ready. Clips download directly as MP3 or WAV.';$('nextIdea').disabled=false;
  }catch{$('waveStatus').textContent='Seek timeline';$('discoveryStatus').textContent='This file could not be decoded for analysis or export. Listening and drafts still work.'}
  finally{if(ctx)await ctx.close().catch(()=>{})}
}

$('refreshArchive').onclick=archive;
for(const name of ['search','sort'])$(name).addEventListener(name==='search'?'input':'change',()=>{state.visible=20;renderEpisodes()});
$('moreEpisodes').onclick=()=>{state.visible+=20;renderEpisodes()};
$('backToArchive').onclick=()=>{remember(true);player.pause();$('studio').hidden=true;$('library').hidden=false;$('transport').hidden=true;const url=new URL(location.href);for(const key of ['episode','start','end'])url.searchParams.delete(key);history.replaceState(null,'',url);renderEpisodes();window.scrollTo({top:0})};
$('playPause').onclick=togglePlay;
document.querySelectorAll('[data-skip]').forEach(b=>b.onclick=()=>seekTo(player.currentTime+Number(b.dataset.skip)));
$('speed').onchange=()=>{player.playbackRate=Number($('speed').value)};
$('seek').oninput=()=>{seekTo(Number($('seek').value));centerAt(Number($('seek').value))};
$('pan').oninput=()=>{state.view=Number($('pan').value);waveCaches.delete('detail');draw()};
$('zoom').onchange=()=>{centerAt(player.currentTime||state.start);applyPanLimit()};
$('centerSelection').onclick=centerSelection;$('centerPlayhead').onclick=()=>centerAt(player.currentTime);
$('detail').addEventListener('pointerdown',e=>{const r=e.currentTarget.getBoundingClientRect();seekTo(state.view+C.clamp((e.clientX-r.left)/r.width,0,1)*viewSpan())});
bindHandle('start');bindHandle('end');
for(const edge of ['start','end']){
  const field=$(edge+'Time');
  const commit=()=>{const v=C.parseTime(field.value);if(Number.isFinite(v)){
    const oldLength=state.end-state.start;
    if(edge==='start'&&v>=state.end)setSelection(v,v+oldLength);
    else if(edge==='end'&&v<=state.start)setSelection(Math.max(0,v-oldLength),v);
    else setEdge(edge,v);
    centerAt(v);
  }else{status('Use a timestamp such as 12:34.50.',true);updateSelection(false)}};
  field.addEventListener('change',commit);field.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commit();field.blur()}});
}
document.querySelectorAll('[data-nudge]').forEach(b=>b.onclick=()=>setEdge(b.parentElement.dataset.edge,state[b.parentElement.dataset.edge]+Number(b.dataset.nudge)));
$('markStart').onclick=()=>{const t=player.currentTime;if(t>=state.end)setSelection(t,t+length(),true);else{setEdge('start',t);centerAt(t)}};
$('markEnd').onclick=()=>{const t=player.currentTime;if(t<=state.start)setSelection(Math.max(0,t-length()),Math.max(.5,t),true);else{setEdge('end',t);centerAt(t)}};
$('capture').onclick=()=>{const end=Math.max(.5,player.currentTime);state.editing=null;$('clipName').value='';setSelection(Math.max(0,end-30),end,true);status('Last 30 seconds selected. Fine-tune it, then save.');};
$('preview').onclick=preview;$('copyLink').onclick=copyLink;$('saveClip').onclick=saveClip;$('cancelEdit').onclick=clearEdit;
$('clipName').oninput=()=>remember();$('nextIdea').onclick=()=>nextIdea();$('randomIdea').onclick=()=>nextIdea(true);
$('targetLength').onchange=()=>{$('customLength').hidden=$('targetLength').value!=='custom';state.idea=null;$('idea').hidden=true};
$('exportAll').onclick=()=>exportClips(currentDraft()?.clips||[]);
$('exportSelection').onclick=()=>{if(commitTimeFields())exportClips([{start:state.start,end:state.end,name:$('clipName').value||'Good bit'}])};
$('cancelExport').onclick=()=>{exportController?.abort();$('exportDialog').close()};
$('exportDialog').addEventListener('close',()=>exportController?.abort());
$('helpButton').onclick=()=>$('helpDialog').showModal();
$('fileInput').onchange=e=>{openLocal(e.target.files[0]);e.target.value=''};
$('backupDrafts').onclick=()=>{remember(true);downloadBlob(new Blob([JSON.stringify(saved,null,2)],{type:'application/json'}),'yellow-five-clipper-drafts.json')};
$('restoreDrafts').onchange=async e=>{
  try{const file=e.target.files[0];if(!file)return;if(file.size>5*1024*1024)throw new Error('Backup must be under 5 MB');const data=JSON.parse(await file.text());if(data.version!==2||!data.episodes||typeof data.episodes!=='object')throw new Error('Choose a clipper draft backup');
    let count=0;for(const [guid,draft] of Object.entries(data.episodes)){if(!guid||guid.length>200||['__proto__','constructor','prototype'].includes(guid)||!draft||!Array.isArray(draft.clips))continue;const target=saved.episodes[guid]||={clips:[],reviewed:[]};for(const clip of draft.clips.slice(0,500)){if(Number.isFinite(clip.start)&&Number.isFinite(clip.end)&&clip.start>=0&&clip.end-clip.start>=.5&&!target.clips.some(c=>c.id===clip.id)){target.clips.push({id:typeof clip.id==='string'?clip.id:id(),name:String(clip.name||'Good bit').slice(0,80),start:clip.start,end:clip.end});count++}}}
    persist();renderTray();status('Restored '+count+' clips.');
  }catch(error){status(error.message,true)}finally{e.target.value=''}
};
player.addEventListener('loadedmetadata',()=>{if(Number.isFinite(player.duration)&&player.duration>0)state.duration=player.duration;applyDuration();seekTo(state.pendingSeek,Boolean(state.preview));status('Ready to listen and clip.')});
player.addEventListener('durationchange',()=>{if(Number.isFinite(player.duration)&&player.duration>0){state.duration=player.duration;applyDuration()}});
player.addEventListener('play',()=>{$('playPause').textContent='Ⅱ';$('playPause').setAttribute('aria-label','Pause');cancelAnimationFrame(state.frame);playbackTick()});
player.addEventListener('pause',()=>{$('playPause').textContent='▶';$('playPause').setAttribute('aria-label','Play');cancelAnimationFrame(state.frame);remember(true);draw()});
player.addEventListener('ended',()=>{state.preview=null});
player.addEventListener('timeupdate',()=>{if(state.preview&&player.currentTime>=state.preview.end){if($('loop').checked)seekTo(state.preview.start,true);else{player.pause();state.preview=null}}updateClock();if(Date.now()-lastPositionSave>2000){remember();lastPositionSave=Date.now()}});
player.addEventListener('error',()=>status('The episode audio couldn’t load. Check your connection and try another episode or refresh.',true));
document.addEventListener('keydown',e=>{
  if(!state.current||$('studio').hidden||document.querySelector('dialog[open]')||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable||e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.target.tagName==='BUTTON'&&e.key===' ')return;
  const key=e.key.toLowerCase();const actions={' ':togglePlay,arrowleft:()=>seekTo(player.currentTime-(e.shiftKey?30:5)),arrowright:()=>seekTo(player.currentTime+(e.shiftKey?30:5)),i:()=>$('markStart').click(),o:()=>$('markEnd').click(),p:preview,s:saveClip};
  if(actions[key]){e.preventDefault();actions[key]()}
});
document.addEventListener('visibilitychange',()=>{remember(true);if(!document.hidden)draw()});
window.addEventListener('pagehide',()=>remember(true));window.addEventListener('resize',()=>{waveCaches.clear();draw()});
if('mediaSession'in navigator){try{navigator.mediaSession.setActionHandler('play',play);navigator.mediaSession.setActionHandler('pause',()=>player.pause());navigator.mediaSession.setActionHandler('seekbackward',()=>seekTo(player.currentTime-10));navigator.mediaSession.setActionHandler('seekforward',()=>seekTo(player.currentTime+10))}catch{}}
(async()=>{await archive();const q=new URLSearchParams(location.search),episode=state.episodes.find(e=>e.guid===q.get('episode'));if(episode){const start=C.parseTime(q.get('start')||''),end=C.parseTime(q.get('end')||'');openEpisode(episode,Number.isFinite(start)&&Number.isFinite(end)?{start,end}:null)}})();
