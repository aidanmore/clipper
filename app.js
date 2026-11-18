'use strict';

const $ = id => document.getElementById(id);
const C = ClipCore;
const REPO = 'aidanmore/clipper';
const API = 'https://api.github.com/repos/' + REPO;
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
saved.episodes ||= {}; saved.jobs ||= []; saved.version = 2;
let saveTimer, statusTimer, pollTimer, lastCheck = 0, lastPositionSave = 0;
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
async function localExport(clips){
  if(!state.localBuffer){status('Local export needs decoded audio. Open a file under 40 MB, or use an archive episode for GitHub export.',true);return}
  if(state.busy)return;state.busy=true;
  try{
    for(const clip of clips){
      const b=state.localBuffer,sr=b.sampleRate,channels=b.numberOfChannels,first=Math.floor(clip.start*sr),last=Math.min(b.length,Math.floor(clip.end*sr)),count=last-first;
      if(count*channels*2>128*1024*1024)throw new Error('Choose a shorter clip for local export');
      const bytes=new ArrayBuffer(44+count*channels*2),v=new DataView(bytes),str=(offset,s)=>[...s].forEach((c,i)=>v.setUint8(offset+i,c.charCodeAt(0)));
      str(0,'RIFF');v.setUint32(4,36+count*channels*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);v.setUint32(24,sr,true);v.setUint32(28,sr*channels*2,true);v.setUint16(32,channels*2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,count*channels*2,true);
      const data=Array.from({length:channels},(_,c)=>b.getChannelData(c));let offset=44;
      for(let i=first;i<last;i++)for(let c=0;c<channels;c++){const x=C.clamp(data[c][i],-1,1);v.setInt16(offset,x<0?x*32768:x*32767,true);offset+=2}
      downloadBlob(new Blob([bytes],{type:'audio/wav'}),clip.name.replace(/[^a-z0-9_-]/gi,'-')+'.wav');
    }status('WAV export ready. Check your downloads.');
  }catch(error){status(error.message,true)}finally{state.busy=false}
}
let pendingJob;
function exportClips(clips){
  if(!state.current)return;
  if(clips.length>10||clips.some(c=>c.end-c.start>600)||clips.reduce((n,c)=>n+c.end-c.start,0)>1800){status('Export up to 10 clips, 10 minutes each, 30 minutes total. Export a smaller selection.',true);return}
  if(state.current.local){localExport(clips);return}
  const requestId=id(),payload={version:1,request:requestId,episode:state.current.guid,fingerprint:state.current.fingerprint,clips:clips.map(c=>({name:c.name||'Good bit',start:Number(c.start.toFixed(2)),end:Number(c.end.toFixed(2))}))};
  const title='[clipper export] '+requestId.slice(0,8)+' · '+state.current.title;
  const body='Requested from the Yellow Five clipper. Submit this issue to render '+clips.length+' clip(s).\n\n```json\n'+JSON.stringify(payload,null,2)+'\n```\n\nReturn to https://aidanmore.github.io/clipper/ and use Check exports.';
  const url=new URL('https://github.com/'+REPO+'/issues/new');url.searchParams.set('title',title);url.searchParams.set('body',body);
  pendingJob={request:requestId,title:state.current.title,count:clips.length,createdAt:Date.now(),state:'awaiting',issue:null,assets:[]};
  $('submitExport').href=url.href;$('exportSummary').textContent=clips.length+' clip'+(clips.length===1?'':'s')+' · '+C.time(clips.reduce((n,c)=>n+c.end-c.start,0))+' total';$('exportDialog').showModal();
}
function renderJobs(){
  $('exportHistory').hidden=!saved.jobs.length;
  $('exportJobs').replaceChildren(...saved.jobs.slice().reverse().map(job=>{
    const row=element('div','export-job');row.append(element('strong','',job.title+' · '+job.count+' clip'+(job.count===1?'':'s')));
    row.append(element('p','',job.state==='ready'?'Ready to download':job.state==='awaiting'?'Waiting for your GitHub submission':job.state==='failed'?'Export needs attention — open the request for details':'Submitted · waiting for GitHub to finish rendering'));
    if(job.issue){const a=element('a','', 'Request #'+job.issue+' ↗');a.href='https://github.com/'+REPO+'/issues/'+job.issue;a.target='_blank';a.rel='noopener';row.append(a)}
    for(const asset of job.assets||[]){const a=element('a','',asset.name);a.href=asset.url;a.target='_blank';a.rel='noopener';row.append(a)}
    if(job.state==='awaiting')row.append(button('Dismiss',()=>{saved.jobs=saved.jobs.filter(j=>j.request!==job.request);persist();renderJobs()},'quiet small'));
    return row;
  }));
}
async function checkExports(force=false){
  clearTimeout(pollTimer);
  const jobs=saved.jobs.filter(j=>j.state!=='ready'&&j.state!=='failed');
  if(!jobs.length||document.hidden)return;
  if(Date.now()-lastCheck<30000){if(force)status('Checked recently. Try again in a few seconds.');schedulePoll();return}
  lastCheck=Date.now();$('checkExports').disabled=true;
  try{
    const issues=await request(API+'/issues?creator=aidanmore&state=all&per_page=50');
    for(const job of jobs){
      const issue=issues.find(i=>i.title.startsWith('[clipper export] '+job.request.slice(0,8)));
      if(!issue)continue;job.issue=issue.number;job.state='rendering';
      try{const release=await request(API+'/releases/tags/clipper-export-'+issue.number);job.assets=release.assets.filter(a=>/\.(mp3|zip)$/.test(a.name)&&https(a.browser_download_url)).map(a=>({name:a.name,url:a.browser_download_url}));if(job.assets.length)job.state='ready'}catch(error){if(error.code!==404)throw error;const comments=await request(API+'/issues/'+issue.number+'/comments');if(comments.some(c=>c.user?.type==='Bot'&&c.body.startsWith('Clip export failed:')))job.state='failed'}
    }
    persist();renderJobs();if(force)status('Export status updated.');
  }catch(error){if(force)status(error.code===403||error.code===429?'GitHub’s request limit was reached. Open your export request to check progress, or try later.':'Couldn’t check GitHub. You can also download from your export request.',true)}
  finally{$('checkExports').disabled=false;schedulePoll()}
}
function schedulePoll(){if(saved.jobs.some(j=>!['ready','failed'].includes(j.state)&&Date.now()-j.createdAt<30*60*1000)&&!document.hidden)pollTimer=setTimeout(()=>checkExports(),90000)}

async function openLocal(file){
  if(!file)return;
  if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);
  state.objectUrl=URL.createObjectURL(file);
  const guid='local-'+await shortHash(file.name+'/'+file.size+'/'+file.lastModified);
  openEpisode({guid,title:file.name,number:'',date:'',duration:0,audio:state.objectUrl,cover:'',local:true});
  const revision=state.revision;
  if(file.size>40*1024*1024){$('discoveryStatus').textContent='Large local file: listening and drafts are ready. Open the matching archive episode for export and prepared waveforms.';$('waveStatus').textContent='Seek timeline';return}
  let ctx;
  try{
    const AudioCtx=window.AudioContext||window.webkitAudioContext;ctx=new AudioCtx();
    const buffer=await ctx.decodeAudioData(await file.arrayBuffer());if(revision!==state.revision)return;
    state.localBuffer=buffer;state.duration=buffer.duration;
    const data=buffer.getChannelData(0),peakStep=.01,energyStep=.25,peaks=[],energy=[];
    for(let i=0;i<data.length;i+=Math.max(1,Math.floor(buffer.sampleRate*peakStep))){let max=0;const end=Math.min(data.length,i+Math.floor(buffer.sampleRate*peakStep));for(let j=i;j<end;j++)max=Math.max(max,Math.abs(data[j]));peaks.push(Math.round(max*255))}
    for(let i=0;i<data.length;i+=Math.floor(buffer.sampleRate*energyStep)){let sum=0;const end=Math.min(data.length,i+Math.floor(buffer.sampleRate*energyStep));for(let j=i;j<end;j++)sum+=data[j]*data[j];energy.push(Math.round(Math.sqrt(sum/(end-i))*65535))}
    state.analysis={duration:buffer.duration,peakStep,peaks,energyStep,energy};applyDuration();waveCaches.clear();draw();$('waveStatus').textContent='Waveform ready';$('discoveryStatus').textContent='Local audio analysis ready. Local clips export as WAV.';$('nextIdea').disabled=false;
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
$('submitExport').onclick=()=>{if(pendingJob){saved.jobs.push(pendingJob);saved.jobs=saved.jobs.slice(-30);pendingJob=null;persist();renderJobs();schedulePoll()}$('exportDialog').close()};
$('checkExports').onclick=()=>checkExports(true);
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
document.addEventListener('visibilitychange',()=>{remember(true);if(document.hidden){clearTimeout(pollTimer)}else{schedulePoll();draw()}});
window.addEventListener('pagehide',()=>remember(true));window.addEventListener('resize',()=>{waveCaches.clear();draw()});
if('mediaSession'in navigator){try{navigator.mediaSession.setActionHandler('play',play);navigator.mediaSession.setActionHandler('pause',()=>player.pause());navigator.mediaSession.setActionHandler('seekbackward',()=>seekTo(player.currentTime-10));navigator.mediaSession.setActionHandler('seekforward',()=>seekTo(player.currentTime+10))}catch{}}
(async()=>{renderJobs();await archive();const q=new URLSearchParams(location.search),episode=state.episodes.find(e=>e.guid===q.get('episode'));if(episode){const start=C.parseTime(q.get('start')||''),end=C.parseTime(q.get('end')||'');openEpisode(episode,Number.isFinite(start)&&Number.isFinite(end)?{start,end}:null)}schedulePoll()})();
