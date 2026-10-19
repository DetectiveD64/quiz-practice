import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {promises as fileOperations} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {encodeWav,alignWords,createSpeechService} from '../src/tts.mjs';
import {createPracticeApp} from '../src/app.mjs';
async function folder(t){const root=await mkdtemp(path.join(os.tmpdir(),'quiz-voice-test-'));t.after(async()=>{assert(path.resolve(root).startsWith(path.join(os.tmpdir(),'quiz-voice-test-')));await rm(root,{recursive:true,force:true});});return root;}
test('voice WAV has valid PCM header and clips samples safely',()=>{
 const wav=encodeWav(Float32Array.of(-2,-.5,0,.5,2));assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),24000);assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt32LE(40),10);assert.equal(wav.readInt16LE(44),-32767);assert.equal(wav.readInt16LE(52),32767);
});
test('word times follow rounded model frames and original UTF-16 positions',()=>{
 const words=[{position:3,count:5,tokenStart:0},{position:9,count:4,tokenStart:2}];
 const timed=alignWords(words,Float32Array.of(3.2,4.2,1.1,5.3,2),2);
 assert.deepEqual(timed,[{position:3,count:5,time:2},{position:9,count:4,time:2.125}]);
});
test('identical concurrent requests share generation, and cached audio survives a new service',async t=>{
 const root=await folder(t);let calls=0;
 const service=createSpeechService({root,engineFactory:async()=>({generate:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return {wav:encodeWav(Float32Array.of(0,1)),words:[{position:0,count:5,time:0}],duration:1,voice:'fixture',nextPart:1};}})});
 const [a,b]=await Promise.all([service.generate('Hello world'),service.generate('Hello world')]);assert.equal(calls,1);assert.equal(a.audioUrl,b.audioUrl);assert.equal(a.nextPart,1);
 const reopened=createSpeechService({root,engineFactory:async()=>{throw new Error('Must not load for cache');}});
 assert.deepEqual(await reopened.generate('Hello world'),a);assert.equal((await reopened.audio(a.audioUrl.match(/([a-f0-9]{64})\.wav$/)[1])).toString('ascii',0,4),'RIFF');
});
test('speech parts retain separate audio keys and global question indices',async t=>{
 const root=await folder(t);const service=createSpeechService({root,engineFactory:async()=>({generate:async(_text,{part})=>({wav:encodeWav(Float32Array.of(0)),words:[{position:part*10,count:5,time:0}],duration:1,voice:'fixture',nextPart:part?null:1})})});
 const first=await service.generate('First question part',{part:0}),second=await service.generate('First question part',{part:1});assert.notEqual(first.audioUrl,second.audioUrl);assert.equal(first.words[0].position,0);assert.equal(second.words[0].position,10);assert.equal(second.nextPart,null);
});
test('invalid paths, text, and part numbers cannot read files or start inference',async t=>{
 const root=await folder(t);const service=createSpeechService({root,engineFactory:async()=>{throw new Error('Should not start');}});
 await assert.rejects(service.audio('../state'));await assert.rejects(service.generate(''));await assert.rejects(service.generate('x'.repeat(8001)));await assert.rejects(service.generate('hello',{part:-1}));await assert.rejects(service.generate('hello',{part:1.5}));
});
test('a stopped queued request does not start the voice model',async t=>{
 const root=await folder(t);let starts=0;const controller=new AbortController();controller.abort();const service=createSpeechService({root,engineFactory:async()=>{starts++;throw new Error('Should not start');}});
 await assert.rejects(service.generate('No more words',{signal:controller.signal}),/stopped/);assert.equal(starts,0);
});
test('speech HTTP actions require the existing local origin and session token',async t=>{
 const root=await folder(t);let calls=0;const fake={generate:async(text,{part})=>{calls++;return {text,part,audioUrl:'/api/speech/audio/'+'a'.repeat(64)+'.wav'};},audio:async()=>encodeWav(Float32Array.of(0))};
 const app=await createPracticeApp({root,speechService:fake});const origin='http://127.0.0.1:43877';const state=await(await app.handle(new Request(origin+'/api/state'))).json();
 const post=async(headers={})=>app.handle(new Request(origin+'/api/speech',{method:'POST',headers:{origin,'content-type':'application/json','x-practice-token':state.csrfToken,...headers},body:JSON.stringify({text:'Read this',part:1})}));
 assert.equal((await post({'x-practice-token':'bad'})).status,403);assert.equal((await post({origin:'https://example.com'})).status,403);assert.equal(calls,0);const result=await(await post()).json();assert.equal(result.part,1);assert.equal(calls,1);
 const audio=await app.handle(new Request(origin+'/api/speech/audio/'+'a'.repeat(64)+'.wav'));assert.equal(audio.headers.get('content-type'),'audio/wav');assert.equal((await audio.arrayBuffer()).byteLength,46);
});

test('cancelling speculative preparation preserves a foreground listener for the same recording',async t=>{
 const root=await folder(t);let release,started,calls=0;
 const running=new Promise(resolve=>{started=resolve;});
 const service=createSpeechService({root,engineFactory:async()=>({generate:async(_text,{signal})=>{calls++;started();await new Promise(resolve=>{release=resolve;});assert.equal(signal.aborted,false);return {wav:encodeWav(Float32Array.of(0)),words:[{position:0,count:5,time:0}],duration:1,voice:'fixture'};}})});
 const background=new AbortController(),foreground=new AbortController();
 const speculative=service.generate('Hello world',{priority:'background',signal:background.signal});
 await running;const needed=service.generate('Hello world',{signal:foreground.signal});
 // Cache lookups are asynchronous filesystem reads; allow the second consumer
 // to subscribe before cancelling the speculative caller.
 await new Promise(resolve=>setTimeout(resolve,20));
 background.abort();await assert.rejects(speculative,/stopped/);release();
 assert.equal((await needed).voice,'fixture');assert.equal(calls,1);
});

test('queued foreground speech runs before speculative recordings',async t=>{
 const root=await folder(t);let release,started;const order=[];
 const running=new Promise(resolve=>{started=resolve;});
 const service=createSpeechService({root,engineFactory:async()=>({generate:async text=>{
   order.push(text);if(text==='Current'){started();await new Promise(resolve=>{release=resolve;});}
   return {wav:encodeWav(Float32Array.of(0)),words:[{position:0,count:1,time:0}],duration:1,voice:'fixture'};
 }})});
 const current=service.generate('Current');await running;
 const speculative=service.generate('Later',{priority:'background'}),needed=service.generate('Now');
 await new Promise(resolve=>setTimeout(resolve,20));release();await Promise.all([current,speculative,needed]);
 assert.deepEqual(order,['Current','Now','Later']);
});

test('startup warming shares model initialization without generating audio',async t=>{
 const root=await folder(t);let loads=0,generations=0;
 const service=createSpeechService({root,engineFactory:async()=>{loads++;return {generate:async()=>{generations++;throw new Error('Not requested');}};}});
 await Promise.all([service.warm(),service.warm()]);assert.equal(loads,1);assert.equal(generations,0);
});

test('the current question finishes buffering before an unrelated preloaded voice',async t=>{
 const root=await folder(t);const order=[];let release,started;
 const begun=new Promise(resolve=>{started=resolve;});
 const service=createSpeechService({root,engineFactory:async()=>({generate:async(text,{part})=>{
   order.push([text,part]);if(text==='Current'&&part===0){started();await new Promise(resolve=>{release=resolve;});}
   return {wav:encodeWav(Float32Array.of(0)),words:[{position:part*5,count:1,time:0}],duration:1,voice:'fixture',nextPart:text==='Current'&&part<2?part+1:null};
 }})});
 const buffered=service.setPlayback('Current',true);await begun;
 const future=service.generate('Later',{priority:'background'});
 await new Promise(resolve=>setTimeout(resolve,10));release();await Promise.all([buffered,future]);
 assert.deepEqual(order,[['Current',0],['Current',1],['Current',2],['Later',0]]);
 assert.equal(service.getStatus().playbackBuffered,true);
 assert.equal(await service.hasCached('Current',{part:2}),true);
 assert.equal(await service.hasCached('Unprepared'),false);
 await service.setPlayback('Current',false);assert.equal(service.getStatus().playbackActive,false);
});

test('typing stops speculative current buffering and frees the queue for upcoming questions',async t=>{
 const root=await folder(t);const order=[];let release,started;
 const begun=new Promise(resolve=>{started=resolve;});
 const service=createSpeechService({root,engineFactory:async()=>({generate:async(text,{part})=>{
   order.push([text,part]);if(text==='Current'){started();await new Promise(resolve=>{release=resolve;});}
   return {wav:encodeWav(Float32Array.of(0)),words:[{position:0,count:1,time:0}],duration:1,voice:'fixture',nextPart:text==='Current'?1:null};
 }})});
 const buffered=service.setPlayback('Current',true);await begun;
 const future=service.generate('Later',{priority:'background'});
 await service.setPlayback('Current',false);release();await Promise.all([buffered,future]);
 assert.deepEqual(order,[['Current',0],['Later',0]]);assert.equal(service.getStatus().playbackActive,false);
});

test('joining a held background recording wakes the idle queue for foreground playback',async t=>{
 const root=await folder(t);const calls=[];let currentReadStarted,releaseCurrentRead,laterStarted;
 const held=new Promise(resolve=>{releaseCurrentRead=resolve;});
 const reading=new Promise(resolve=>{currentReadStarted=resolve;});
 const played=new Promise(resolve=>{laterStarted=resolve;});
 const service=createSpeechService({root,engineFactory:async()=>({generate:async text=>{
   calls.push(text);if(text==='Later')laterStarted();
   return {wav:encodeWav(Float32Array.of(0)),words:[{position:0,count:1,time:0}],duration:1,voice:'fixture',nextPart:null};
 }})});
 const cached=await service.generate('Current');calls.length=0;
 const metadataPath=path.join(root,'data/speech-cache',cached.audioUrl.match(/([a-f0-9]{64})\.wav$/)[1]+'.json');
 const originalReadFile=fileOperations.readFile;
 // Hold one cache read, rather than racing timers against the scheduler. This
 // leaves playback preparing while its own recording has not entered the queue.
 fileOperations.readFile=async function(file,...args){
   if(file===metadataPath){currentReadStarted();await held;}
   return originalReadFile.call(this,file,...args);
 };
 let buffered,speculative,foreground,deadline;
 try{
   buffered=service.setPlayback('Current',true);await reading;
   speculative=service.generate('Later',{priority:'background'});
   while(service.getStatus().pendingRecordings!==1)await new Promise(resolve=>setImmediate(resolve));
   await new Promise(resolve=>queueMicrotask(resolve));
   assert.deepEqual(calls,[]);assert.equal(service.getStatus().playbackBuffered,false);
   foreground=service.generate('Later');
   await Promise.race([played,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Promoted speech queue did not wake.')),2000);})]);
   clearTimeout(deadline);await Promise.all([speculative,foreground]);
   assert.deepEqual(calls,['Later']);assert.equal(service.getStatus().playbackBuffered,false);
 }finally{
   clearTimeout(deadline);fileOperations.readFile=originalReadFile;releaseCurrentRead();
   await Promise.allSettled([buffered,speculative,foreground].filter(Boolean));
 }
});
