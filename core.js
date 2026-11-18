(function(root){
  const clamp=(v,l,h)=>Math.max(l,Math.min(h,v));
  function parseTime(text){const p=String(text).trim().split(':');if(p.length>3||p.some(x=>!/^\d+(?:\.\d+)?$/.test(x)))return NaN;return p.reduce((s,x)=>s*60+Number(x),0)}
  function time(value,precise=false){const total=Math.round(Math.max(0,Number(value)||0)*(precise?100:1)),sec=precise?Math.floor(total/100):total,h=Math.floor(sec/3600),m=Math.floor(sec/60)%60,s=sec%60;return(h?h+':'+String(m).padStart(2,'0'):String(m))+':'+String(s).padStart(2,'0')+(precise?'.'+String(total%100).padStart(2,'0'):'')}
  function selection(start,end,duration){const d=Math.max(.5,duration||.5);start=clamp(Number(start)||0,0,d-.5);end=clamp(Number(end)||start+.5,start+.5,d);return{start,end}}
  const normalizeSearch=text=>String(text).normalize('NFKC').toLowerCase().replace(/^#/,'').trim();
  function candidates(a,length,reviewed=[]){
    const step=a.energyStep,v=a.energy.map(x=>x/65535),d=a.duration;length=clamp(length,.5,d);
    const n=Math.max(1,Math.round(length/step)),sum=[0],active=[0],change=[0],sorted=[...v].sort((a,b)=>a-b),threshold=Math.max(.003,sorted[Math.floor(sorted.length*.25)]||0);
    v.forEach((x,i)=>{sum.push(sum[i]+x);active.push(active[i]+(x>threshold?1:0));change.push(change[i]+Math.abs(x-(v[i-1]||x)))});
    const result=[],margin=Math.min(20,d*.04);
    for(let i=Math.ceil(margin/step);i+n<v.length-margin/step;i+=Math.max(1,Math.round(3/step))){
      const average=(sum[i+n]-sum[i])/n,density=(active[i+n]-active[i])/n,variation=(change[i+n]-change[i])/n;if(density<.35)continue;
      let first=i,last=i+n;
      for(let j=Math.max(0,i-4);j<=Math.min(v.length-1,i+4);j++)if(v[j]<v[first])first=j;
      for(let j=Math.max(first+2,i+n-4);j<=Math.min(v.length-1,i+n+4);j++)if(v[j]<v[last])last=j;
      const start=first*step,end=Math.min(d,last*step);
      if(reviewed.some(r=>Math.abs(r-start)<Math.min(length*.6,15)))continue;
      result.push({start,end,score:average*.55+variation*.3+density*.015,reason:variation>average*.35?'Energy shifts':'Active conversation'});
    }
    result.sort((a,b)=>b.score-a.score);const selected=[];
    for(const c of result){if(!selected.some(p=>Math.max(0,Math.min(p.end,c.end)-Math.max(p.start,c.start))>length*.25))selected.push(c);if(selected.length>=50)break}
    return selected;
  }
  const api={clamp,parseTime,time,selection,normalizeSearch,candidates};root.ClipCore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
