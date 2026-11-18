const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('../core.js');
test('timestamps round across minute boundaries and parse fractional seconds',()=>{
  assert.equal(C.time(59.999,true),'1:00.00');
  assert.equal(C.time(3661.25,true),'1:01:01.25');
  assert.equal(C.parseTime('12:34.50'),754.5);
  assert.ok(Number.isNaN(C.parseTime('bad')));
});
test('selection stays in the source and keeps a minimum playable length',()=>{
  assert.deepEqual(C.selection(100,90,60),{start:59.5,end:60});
  assert.deepEqual(C.selection(-2,5,60),{start:0,end:5});
  assert.equal(C.normalizeSearch('₇₅ gentle men'),'75 gentle men');
});
test('suggestions ignore silent stretches and reviewed locations',()=>{
  const energy=Array.from({length:1200},(_,i)=>i>300&&i<800?5000+(i%10)*2000:0);
  const a={energy,energyStep:.25,duration:300};
  const picks=C.candidates(a,15);
  assert.ok(picks.length>0);
  assert.ok(picks.every(c=>c.start>=55&&c.end<=220));
  const reviewed=picks.map(p=>p.start);
  const fresh=C.candidates(a,15,reviewed);
  assert.ok(fresh.every(p=>reviewed.every(t=>Math.abs(t-p.start)>=9)));
});
