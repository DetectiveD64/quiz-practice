import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPracticeApp,calculateStats} from '../src/app.mjs';
import {gradeAnswer} from '../src/grading.mjs';

const origin='http://127.0.0.1:43877';
const items=[
  {id:'synthetic-1',text:'Name the author of Hamlet.',answerline:'William <b>Shakespeare</b>',topic:'Literature',level:'high',source:{provider:'Test fixture'}},
  {id:'synthetic-2',text:'Name the planet known as the Red Planet.',answerline:'<b>Mars</b>',topic:'Science',level:'middle',source:{provider:'Test fixture'}},
];
async function fixture(t,extra={}){
  const {cachedQuestions,...options}=extra;
  const root=await mkdtemp(path.join(os.tmpdir(),'quiz-practice-test-'));await mkdir(path.join(root,'public'));
  if(cachedQuestions){await mkdir(path.join(root,'data'));await writeFile(path.join(root,'data','questions.json'),JSON.stringify({questions:cachedQuestions,catalog:{totals:{tossups:cachedQuestions.length},fetchedAt:new Date().toISOString()}}));}
  const app=await createPracticeApp({root,grader:gradeAnswer,questionSource:async({topics,levels})=>({questions:items.filter(q=>topics.includes(q.topic)&&levels.includes(q.level))}),catalogSource:async()=>({totals:{tossups:2},fetchedAt:new Date().toISOString()}),...options});
  t.after(async()=>{await app.settle();assert(path.resolve(root).startsWith(path.join(os.tmpdir(),'quiz-practice-test-')));await rm(root,{recursive:true,force:true});});
  const get=async(url)=>{const response=await app.handle(new Request(origin+url));return {status:response.status,value:await response.json()};};
  const {value:{csrfToken}}=await get('/api/state');
  const post=async(url,body,headers={})=>{const response=await app.handle(new Request(origin+url,{method:'POST',headers:{origin,'content-type':'application/json','x-practice-token':csrfToken,...headers},body:JSON.stringify(body)}));return {status:response.status,value:await response.json()};};
  return {root,app,get,post};
}
test('question responses hide answers and duplicate submissions increment statistics once',async t=>{
  const {get,post}=await fixture(t);
  const result=await get('/api/question?topics=Literature&levels=high');
  assert.equal(result.status,200);assert.equal(result.value.question.answerline,undefined);assert.equal(result.value.question.answer,undefined);
  const body={id:result.value.question.id,attempt:'Shakespear',requestId:'same-attempt'};
  const results=await Promise.all([post('/api/answer',body),post('/api/answer',body)]);
  assert(results.every(result=>result.value.verdict==='correct'));
  const state=await get('/api/state');assert.equal(state.value.stats.answered,1);assert.equal(state.value.stats.correct,1);
});
test('separate simultaneous answers persist both results and survive reopening',async t=>{
  const {root,get,post}=await fixture(t);
  const literature=await get('/api/question?topics=Literature&levels=high'),science=await get('/api/question?topics=Science&levels=middle');
  await Promise.all([post('/api/answer',{id:literature.value.question.id,attempt:'Shakespeare',requestId:'a'}),post('/api/answer',{id:science.value.question.id,attempt:'Venus',requestId:'b'})]);
  const reopened=await createPracticeApp({root,questionSource:async()=>({questions:[]})});
  const state=await (await reopened.handle(new Request(origin+'/api/state'))).json();
  assert.equal(state.stats.answered,2);assert.equal(state.stats.correct,1);assert.equal(state.stats.incorrect,1);assert.equal(state.stats.accuracy,50);
});
test('explicitly empty filters return no question without contacting the source',async t=>{
  let calls=0;const {get}=await fixture(t,{questionSource:async()=>{calls++;return {questions:[]};}});
  const result=await get('/api/question?topics=&levels=high');
  assert.equal(result.value.empty,true);assert.equal(calls,0);
});
test('foreign origins and missing tokens cannot mutate statistics',async t=>{
  const {get,post,app}=await fixture(t);
  assert.equal((await post('/api/preferences',{topics:[],levels:[],readAloud:false},{origin:'https://example.com'})).status,403);
  assert.equal((await app.handle(new Request(origin+'/api/answer',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}))).status,403);
  assert.equal((await get('/api/state')).value.stats.answered,0);
});
test('a specificity prompt leaves statistics and answer unrevealed',async t=>{
  const {get,post}=await fixture(t,{grader:()=>({verdict:'prompt',method:'explicit-prompt'})});
  const question=(await get('/api/question?topics=Literature&levels=high')).value.question;
  const result=await post('/api/answer',{id:question.id,attempt:'writer',requestId:'prompt'});
  assert.equal(result.value.verdict,'prompt');assert.equal(result.value.answer,undefined);assert.equal(result.value.stats.answered,0);
});
test('an unavailable archive returns an honest empty state without synthetic questions',async t=>{
  const {get}=await fixture(t,{questionSource:async()=>{throw new Error('Unavailable');}});
  const result=await get('/api/question');assert.equal(result.value.question,null);assert.equal(result.value.empty,true);assert.match(result.value.message,/unavailable/);
});
test('statistics compute streaks from persisted final verdicts',()=>{
  const stats=calculateStats(['correct','correct','incorrect','correct'].map(verdict=>({verdict,topic:'Science',level:'high'})));
  assert.equal(stats.streak,1);assert.equal(stats.bestStreak,2);assert.equal(stats.accuracy,75);assert.equal(stats.byTopic.Science.correct,3);
});

test('the default app grader rejects a random letter and still accepts spelling mistakes',async t=>{
  const {get,post}=await fixture(t,{grader:undefined});
  const science=(await get('/api/question?topics=Science&levels=middle')).value.question;
  const wrong=await post('/api/answer',{id:science.id,attempt:'w',requestId:'random-letter'});
  assert.equal(wrong.value.verdict,'incorrect');assert.equal(wrong.value.method,'no-match');
  const literature=(await get('/api/question?topics=Literature&levels=high')).value.question;
  const typo=await post('/api/answer',{id:literature.id,attempt:'Shakespear',requestId:'real-typo'});
  assert.equal(typo.value.verdict,'correct');assert.equal(typo.value.stats.answered,2);assert.equal(typo.value.stats.correct,1);
});

test('startup repairs proven AI false positives, backs up the full history, and runs only once',async t=>{
  const {root,app}=await fixture(t);await app.settle();
  const original={...app.snapshot(),seen:['synthetic-2'],attempts:[
    {id:'old-wrong',questionId:'synthetic-2',requestId:'old',attempt:'w',verdict:'correct',method:'local-semantic-equivalent',topic:'Science',level:'middle'},
    {id:'valid',questionId:'synthetic-1',requestId:'valid',attempt:'Shakespear',verdict:'correct',method:'conservative-typo',topic:'Literature',level:'high'},
  ]};
  await writeFile(path.join(root,'data','state.json'),JSON.stringify(original));
  await writeFile(path.join(root,'data','questions.json'),JSON.stringify({questions:items,catalog:null}));
  const repaired=await createPracticeApp({root});
  const result=await (await repaired.handle(new Request(origin+'/api/state'))).json();
  assert.equal(result.stats.answered,2);assert.equal(result.stats.correct,1);assert.equal(result.stats.incorrect,1);assert.equal(result.stats.streak,1);
  const backupNames=await readdir(path.join(root,'data','grading-repairs'));assert.equal(backupNames.length,1);
  assert.deepEqual(JSON.parse(await readFile(path.join(root,'data','grading-repairs',backupNames[0]),'utf8')),original);
  const saved=JSON.parse(await readFile(path.join(root,'data','state.json'),'utf8'));
  assert.equal(saved.attempts[0].originalVerdict,'correct');assert.equal(saved.attempts[0].verdict,'incorrect');
  assert.deepEqual(saved.preferences,original.preferences);assert.deepEqual(saved.seen,original.seen);
  await createPracticeApp({root});
  assert.equal((await readdir(path.join(root,'data','grading-repairs'))).length,1);
});

test('preparing the next question hides it and changes no history or statistics',async t=>{
  let recordings=0;
  const {app,get,post}=await fixture(t,{cachedQuestions:items,speechService:{generate:async()=>{recordings++;}}});
  const before=app.snapshot();
  const prepared=await post('/api/prepare-next',{topics:['Science'],levels:['middle']});
  assert.deepEqual(prepared,{status:200,value:{prepared:true,buffered:1,readyVoices:0}});assert.deepEqual(app.snapshot(),before);assert.equal(recordings,0);
  const question=(await get('/api/question?topics=Science&levels=middle')).value.question;
  assert.equal(question.text,items[1].text);assert.equal(question.answer,undefined);assert.equal(question.answerline,undefined);
  assert.equal(app.snapshot().seen.length,1);assert.equal(app.snapshot().attempts.length,0);
});

test('an unfinished background voice never blocks the prepared question',async t=>{
  let release,started;const recording=new Promise(resolve=>{release=resolve;}),begun=new Promise(resolve=>{started=resolve;});
  const calls=[];
  const {get,post,app}=await fixture(t,{cachedQuestions:items,speechService:{generate:async(text,options)=>{calls.push({text,options});started();return recording;}}});
  try{
    await post('/api/prepare-next',{topics:['Science'],levels:['middle'],warmSpeech:true});await begun;
    const result=await get('/api/question?topics=Science&levels=middle');
    assert.equal(result.status,200);assert.equal(result.value.question.text,items[1].text);
    assert.equal(calls.length,1);assert.equal(calls[0].options.priority,'background');assert.equal(calls[0].options.part,0);
    assert.equal(calls[0].options.signal.aborted,false);assert.equal(app.snapshot().attempts.length,0);
  }finally{release({});}
});

test('preparing an uncached filter returns immediately while archive metadata is fetched',async t=>{
  let release;const archive=new Promise(resolve=>{release=resolve;});let calls=0;
  const {get,post,app}=await fixture(t,{questionSource:async()=>{calls++;return archive;}});
  try{
    const result=await post('/api/prepare-next',{topics:['Science'],levels:['middle']});
    assert.deepEqual(result,{status:200,value:{prepared:false,buffered:0,readyVoices:0}});assert.equal(calls,1);assert.equal(app.snapshot().seen.length,0);
    release({questions:[items[1]]});await app.settle();
    const question=(await get('/api/question?topics=Science&levels=middle')).value.question;
    assert.equal(question.text,items[1].text);
  }finally{release({questions:[]});}
});

test('filter changes preserve in-flight consumed speech for the foreground player',async t=>{
  const calls=[];
  const {get,post}=await fixture(t,{cachedQuestions:items,speechService:{generate:async(text,options)=>{
    return new Promise(resolve=>{calls.push({text,options,resolve});options.signal.addEventListener('abort',()=>resolve({}),{once:true});});
  }}});
  try{
    await post('/api/prepare-next',{topics:['Science'],levels:['middle'],warmSpeech:true});
    await Promise.resolve();assert.equal(calls.length,1);
    const question=(await get('/api/question?topics=Science&levels=middle')).value.question;
    assert.equal(calls[0].options.signal.aborted,false);
    await post('/api/prepare-next',{topics:['Literature'],levels:['high']});
    assert.equal(calls[0].options.signal.aborted,false);
    assert.equal(question.text,items[1].text);
  }finally{for(const call of calls)call.resolve({});}
});

test('background refill begins with seven unread questions left and does not block cached questions',async t=>{
  const cachedQuestions=Array.from({length:9},(_,i)=>({...items[1],id:'cached-'+i}));let release,calls=0;
  const archive=new Promise(resolve=>{release=resolve;});
  const {get}=await fixture(t,{cachedQuestions,questionSource:async()=>{calls++;return archive;}});
  try{
    assert((await get('/api/question?topics=Science&levels=middle')).value.question);assert.equal(calls,0);
    assert((await get('/api/question?topics=Science&levels=middle')).value.question);assert.equal(calls,1);
    assert((await get('/api/question?topics=Science&levels=middle')).value.question);assert.equal(calls,1);
  }finally{release({questions:[]});}
});

test('preparation keeps canonical filter reservations and validates authenticated input',async t=>{
  const mixed=[...items,{...items[1],id:'synthetic-3',text:'Name the star nearest the Earth.'}];const calls=[];
  const {get,post}=await fixture(t,{cachedQuestions:mixed,speechService:{generate:async(text)=>{calls.push(text);}}});
  await post('/api/prepare-next',{topics:['Science','Literature'],levels:['middle','high']});
  await post('/api/prepare-next',{topics:['Literature','Science'],levels:['high','middle'],warmSpeech:true});
  await Promise.resolve();assert(calls.length>=1);
  const question=(await get('/api/question?topics=Science,Literature&levels=middle,high')).value.question;
  assert.equal(question.text,calls[0]);
  assert.equal((await post('/api/prepare-next',{topics:['Unknown'],levels:['middle']})).status,400);
  assert.equal((await post('/api/prepare-next',{topics:['Science'],levels:['middle'],warmSpeech:'yes'})).status,400);
  assert.equal((await post('/api/prepare-next',{topics:['Science'],levels:['middle']},{origin:'https://example.com'})).status,403);
});

test('warming the local voice model at startup does not delay cached questions or statistics',async t=>{
  let release,warmed=0;const warming=new Promise(resolve=>{release=resolve;});
  const {get}=await fixture(t,{cachedQuestions:items,speechService:{warm:async()=>{warmed++;return warming;},generate:async()=>{throw new Error('No question should be synthesized at startup.');}}});
  try{
    assert.equal(warmed,1);assert.equal((await get('/api/state')).value.stats.answered,0);
    assert.equal((await get('/api/question?topics=Science&levels=middle')).value.question.text,items[1].text);
  }finally{release();}
});

const scienceItems=count=>Array.from({length:count},(_,i)=>({...items[1],id:'buffer-'+i,text:'Practice question '+i+'.'}));

test('a canonical three-question buffer persists only IDs and replenishes without issuing future questions',async t=>{
  const cachedQuestions=scienceItems(7);
  const {root,get,post,app}=await fixture(t,{cachedQuestions,questionSource:async()=>({questions:[]})});
  const before=app.snapshot();
  const result=await post('/api/prepare-next',{topics:['Science'],levels:['middle']});
  assert.deepEqual(result.value,{prepared:true,buffered:3,readyVoices:0});
  await app.settle();
  const manifest=JSON.parse(await readFile(path.join(root,'data','preload.json'),'utf8'));
  assert.equal(manifest.version,1);assert.equal(manifest.queues.length,1);
  assert.deepEqual(Object.keys(manifest.queues[0]).sort(),['ids','levels','topics']);
  const ids=manifest.queues[0].ids;assert.equal(ids.length,3);assert.equal(new Set(ids).size,3);
  assert.deepEqual(app.snapshot(),before);
  const expected=cachedQuestions.find(q=>q.id===ids[0]);
  const next=(await get('/api/question?topics=Science&levels=middle')).value.question;
  assert.equal(next.text,expected.text);assert.equal(next.answerline,undefined);
  assert.deepEqual((await get('/api/preload/status')).value,{prepared:true,buffered:3,readyVoices:0});
  assert.equal(app.snapshot().seen.length,1);assert.equal(app.snapshot().attempts.length,0);
});

test('voice preparation warms two opening sections round-robin before finishing only the nearest question',async t=>{
  const calls=[];
  const {post,app}=await fixture(t,{cachedQuestions:scienceItems(5),speechService:{generate:async(text,{part,priority})=>{
    calls.push({text,part,priority});return {nextPart:part<3?part+1:null};
  }}});
  await post('/api/prepare-next',{topics:['Science'],levels:['middle'],warmSpeech:true});await app.settle();
  assert.equal(calls.length,8);assert(calls.every(call=>call.priority==='background'));
  assert.deepEqual(calls.slice(0,3).map(call=>call.part),[0,0,0]);assert.equal(new Set(calls.slice(0,3).map(call=>call.text)).size,3);
  assert.deepEqual(calls.slice(3,6).map(call=>call.part),[1,1,1]);
  assert.deepEqual(calls.slice(3,6).map(call=>call.text),calls.slice(0,3).map(call=>call.text));
  assert.deepEqual(calls.slice(6).map(call=>call.part),[2,3]);assert(calls.slice(6).every(call=>call.text===calls[0].text));
});

test('speculative completion has a fixed section budget',async t=>{
  const calls=[];
  const {post,app}=await fixture(t,{cachedQuestions:scienceItems(3),speechService:{generate:async(text,{part})=>{calls.push({text,part});return {nextPart:part+1};}}});
  await post('/api/prepare-next',{topics:['Science'],levels:['middle'],warmSpeech:true});await app.settle();
  assert.equal(calls.length,28);assert.equal(Math.max(...calls.map(call=>call.part)),23);
});

test('filter changes cancel queued speculative speech while leaving history untouched',async t=>{
  let started;const begun=new Promise(resolve=>{started=resolve;});const calls=[];
  const {post,app}=await fixture(t,{cachedQuestions:scienceItems(3),speechService:{generate:async(text,options)=>{
    calls.push({text,options});started();return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve({}),{once:true}));
  }}});
  await post('/api/prepare-next',{topics:['Science'],levels:['middle'],warmSpeech:true});await begun;
  await post('/api/prepare-next',{topics:['Literature'],levels:['high']});
  assert.equal(calls[0].options.signal.aborted,true);assert.equal(app.snapshot().seen.length,0);assert.equal(app.snapshot().attempts.length,0);
});

test('reopening validates persisted question IDs and recognizes cached opening voices',async t=>{
  const cachedQuestions=scienceItems(5),{root,post,app}=await fixture(t,{cachedQuestions});
  await post('/api/preferences',{topics:['Science'],levels:['middle'],readAloud:true});
  await post('/api/prepare-next',{topics:['Science'],levels:['middle']});await app.settle();
  const original=JSON.parse(await readFile(path.join(root,'data','preload.json'),'utf8'));
  const valid=original.queues[0].ids;
  original.queues.push({topics:['Science'],levels:['middle'],ids:[valid[0],'missing',valid[1]]});
  await writeFile(path.join(root,'data','preload.json'),JSON.stringify(original));
  const reopened=await createPracticeApp({root,questionSource:async()=>({questions:[]}),speechService:{hasCached:async()=>true}});
  const status=await (await reopened.handle(new Request(origin+'/api/preload/status'))).json();
  assert.deepEqual(status,{prepared:true,buffered:3,readyVoices:3});
  const next=await (await reopened.handle(new Request(origin+'/api/question?topics=Science&levels=middle'))).json();
  assert.equal(next.question.text,cachedQuestions.find(q=>q.id===valid[0]).text);
  assert.equal(reopened.snapshot().attempts.length,0);await reopened.settle();
});

test('playback state is authenticated, sequence ordered, and limited to the current issued question',async t=>{
  const playback=[];
  const {get,post}=await fixture(t,{cachedQuestions:items,speechService:{setPlayback:(text,active)=>playback.push({text,active})}});
  const first=(await get('/api/question?topics=Science&levels=middle')).value.question;
  assert.deepEqual(playback.at(-1),{text:items[1].text,active:true});
  assert.equal((await post('/api/playback',{id:first.id,active:false,sequence:2})).value.accepted,true);
  assert.equal(playback.at(-1).active,false);
  assert.equal((await post('/api/playback',{id:first.id,active:true,sequence:1})).value.accepted,false);
  assert.equal(playback.at(-1).active,false);
  const second=(await get('/api/question?topics=Literature&levels=high')).value.question;
  const count=playback.length;
  assert.equal((await post('/api/playback',{id:first.id,active:false,sequence:99})).value.accepted,false);assert.equal(playback.length,count);
  assert.equal((await post('/api/playback',{id:second.id,active:false,sequence:0})).value.accepted,true);
  assert.equal((await post('/api/playback',{id:second.id,active:true,sequence:-1})).status,400);
});

test('turning read aloud off cancels speculative audio and releases active playback',async t=>{
  const playback=[];
  const {get,post,app}=await fixture(t,{cachedQuestions:scienceItems(4),speechService:{setPlayback:(text,active)=>playback.push(active),generate:async()=>{throw new Error('Read aloud is off.');}}});
  await get('/api/question?topics=Science&levels=middle');assert.equal(playback.at(-1),true);
  await post('/api/preferences',{topics:['Science'],levels:['middle'],readAloud:false});assert.equal(playback.at(-1),false);
  await post('/api/prepare-next',{topics:['Science'],levels:['middle'],warmSpeech:true});await app.settle();
  assert.deepEqual((await get('/api/preload/status')).value,{prepared:true,buffered:3,readyVoices:0});
});

test('stopping a consumed question releases its speculative waiter without abandoning the reserve',async t=>{
  const calls=[];
  const {get,post}=await fixture(t,{cachedQuestions:scienceItems(4),speechService:{generate:async(text,options)=>new Promise(resolve=>{
    calls.push({text,options});options.signal.addEventListener('abort',()=>resolve({}),{once:true});
  })}});
  try{
    await post('/api/prepare-next',{topics:['Science'],levels:['middle'],warmSpeech:true});
    const question=(await get('/api/question?topics=Science&levels=middle')).value.question;
    assert.equal(calls[0].options.signal.aborted,false);
    await post('/api/playback',{id:question.id,active:false,sequence:0});
    assert.equal(calls[0].options.signal.aborted,true);
    assert.equal((await get('/api/preload/status')).value.buffered,3);
  }finally{await post('/api/preferences',{topics:['Science'],levels:['middle'],readAloud:false});}
});

test('empty filters stop old playback and reject subsequent stale playback reports',async t=>{
  const playback=[];
  const {get,post}=await fixture(t,{cachedQuestions:items,speechService:{setPlayback:(text,active)=>playback.push(active)}});
  const question=(await get('/api/question?topics=Science&levels=middle')).value.question;
  await get('/api/question?topics=&levels=middle');assert.equal(playback.at(-1),false);
  const count=playback.length;
  assert.equal((await post('/api/playback',{id:question.id,active:true,sequence:5})).value.accepted,false);assert.equal(playback.length,count);
});
