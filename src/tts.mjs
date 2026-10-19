import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {loadEngine} from './tts-engine.mjs';
export {encodeWav,alignWords} from './tts-engine.mjs';

const abort=signal=>{if(signal?.aborted)throw new Error('Speech was stopped.');};
const cacheKey=(text,part)=>createHash('sha256').update('kokoro-timed-v3-lazy100-heart-.96\0'+part+'\0'+text).digest('hex');
const rank=priority=>priority==='foreground'?0:priority==='current'?1:2;

export function createSpeechService({root,engineFactory=loadEngine}={}){
  const cacheRoot=path.join(root,'data/speech-cache');
  let enginePromise=null,draining=false,playback=null;
  const protectedTexts=new Set();
  const pending=new Map(),queue=[];
  function engine(){
    if(!enginePromise)enginePromise=Promise.resolve().then(()=>engineFactory(root)).catch(error=>{enginePromise=null;throw error;});
    return enginePromise;
  }
  async function readCached(hash){try{const metadata=JSON.parse(await fs.readFile(path.join(cacheRoot,hash+'.json'),'utf8'));await fs.access(path.join(cacheRoot,hash+'.wav'));return metadata;}catch{return null;}}
  async function trimCache(current){
    try{
      const protectedKeys=new Set();
      for(const text of new Set([...protectedTexts,...(playback?[playback.text]:[])]))for(let part=0;part<=100;part++)protectedKeys.add(cacheKey(text,part));
      const files=(await fs.readdir(cacheRoot)).filter(name=>/^[a-f0-9]{64}\.wav$/.test(name));
      const entries=await Promise.all(files.map(async name=>({name,stat:await fs.stat(path.join(cacheRoot,name))})));
      entries.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);let bytes=0;
      for(let i=0;i<entries.length;i++){
        const entry=entries[i];bytes+=entry.stat.size;
        if((i>=100||bytes>256*1024*1024)&&entry.name!==current+'.wav'&&!protectedKeys.has(entry.name.slice(0,-4)))await Promise.allSettled([fs.unlink(path.join(cacheRoot,entry.name)),fs.unlink(path.join(cacheRoot,entry.name.replace(/\.wav$/,'.json')))]);
      }
    }catch{}
  }
  async function run(job){
    const {text,part,hash,controller}=job,signal=controller.signal;
    abort(signal);const ready=await readCached(hash);if(ready)return ready;
    const generated=await (await engine()).generate(text,{signal,part});abort(signal);
    const result={audioUrl:'/api/speech/audio/'+hash+'.wav',words:generated.words,duration:generated.duration,voice:generated.voice,nextPart:generated.nextPart??null};
    await fs.mkdir(cacheRoot,{recursive:true});
    const wavTemp=path.join(cacheRoot,hash+'.'+randomUUID()+'.tmp');await fs.writeFile(wavTemp,generated.wav);await fs.rename(wavTemp,path.join(cacheRoot,hash+'.wav'));
    const metaTemp=path.join(cacheRoot,hash+'.'+randomUUID()+'.tmp');await fs.writeFile(metaTemp,JSON.stringify(result));await fs.rename(metaTemp,path.join(cacheRoot,hash+'.json'));
    await trimCache(hash);return result;
  }
  async function drain(){
    if(draining)return;draining=true;
    try{
      while(queue.length){
        // Finish buffering the current question before unrelated recordings.
        // Playback requests always win; speculative work cannot create a gap
        // in the current reading by occupying the model between its sections.
        const eligible=queue.map((job,index)=>({job,index})).filter(({job})=>job.controller.signal.aborted||job.priority!=='background'||!playback?.preparing);
        if(!eligible.length)break;
        eligible.sort((a,b)=>rank(a.job.priority)-rank(b.job.priority)||a.index-b.index);
        const job=queue.splice(eligible[0].index,1)[0];job.started=true;
        try{const result=await run(job);job.done=true;job.resolve(result);}
        catch(error){job.done=true;job.reject(error);}
        finally{if(pending.get(job.hash)===job)pending.delete(job.hash);}
      }
    }finally{draining=false;}
  }
  function waitFor(job,signal){
    return new Promise((resolve,reject)=>{
      const waiter={};let settled=false;
      function finish(error,result){
        if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);job.waiters.delete(waiter);
        if(error)reject(error);else resolve(result);
        // A prewarm and the actual player may share a recording. Stopping one
        // caller must not cancel work still required by the other.
        if(!job.done&&!job.waiters.size){job.controller.abort();if(pending.get(job.hash)===job)pending.delete(job.hash);}
      }
      function cancel(){finish(new Error('Speech was stopped.'));}
      job.waiters.add(waiter);signal?.addEventListener('abort',cancel,{once:true});
      job.promise.then(value=>finish(null,value),error=>finish(error));
      if(signal?.aborted)cancel();
    });
  }
  async function generate(text,{signal,part=0,priority='foreground'}={}){
    if(typeof text!=='string'||!text.trim()||text.length>8000)throw new Error('Choose a readable question.');
    if(!Number.isInteger(part)||part<0||part>100)throw new Error('Choose a valid speech part.');
    abort(signal);
    const hash=cacheKey(text,part);
    const old=await readCached(hash);abort(signal);if(old)return old;
    let job=pending.get(hash);
    if(!job||job.controller.signal.aborted){
      job={text,part,hash,priority:['background','current'].includes(priority)?priority:'foreground',controller:new AbortController(),waiters:new Set(),started:false,done:false};
      job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});
      job.promise.catch(()=>{});pending.set(hash,job);queue.push(job);queueMicrotask(drain);
    }else if(rank(priority)<rank(job.priority)){job.priority=priority;queueMicrotask(drain);}
    return waitFor(job,signal);
  }
  async function audio(hash){if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Audio not found.');return fs.readFile(path.join(cacheRoot,hash+'.wav'));}
  function setPlayback(text,active){
    if(active&&playback?.text===text)return playback.task;
    if(!active&&playback?.text!==text)return Promise.resolve(false);
    const previous=playback;playback=null;previous?.controller.abort();
    if(!active||typeof text!=='string'||!text.trim()||text.length>8000){queueMicrotask(drain);return Promise.resolve(false);}
    const state={text,controller:new AbortController(),preparing:true,ready:false,task:null};playback=state;
    state.task=(async()=>{
      try{
        for(let part=0;part<=100;){
          abort(state.controller.signal);
          const result=await generate(text,{part,priority:'current',signal:state.controller.signal});
          if(result.nextPart===null){state.ready=true;return true;}
          if(!Number.isInteger(result.nextPart)||result.nextPart<=part||result.nextPart>100)throw new Error('Invalid next speech part.');
          part=result.nextPart;
        }
        return false;
      }catch{return false;}
      finally{state.preparing=false;queueMicrotask(drain);}
    })();
    return state.task;
  }
  function setProtectedTexts(texts){
    protectedTexts.clear();
    for(const text of Array.isArray(texts)?texts.slice(0,3):[])if(typeof text==='string'&&text.length<=8000)protectedTexts.add(text);
  }
  async function hasCached(text,{part=0}={}){
    if(typeof text!=='string'||text.length>8000||!Number.isInteger(part)||part<0||part>100)return false;
    return !!await readCached(cacheKey(text,part));
  }
  function getStatus(){return {playbackActive:!!playback,playbackBuffered:!!playback?.ready,pendingRecordings:queue.filter(job=>!job.controller.signal.aborted).length};}
  return {generate,audio,warm:async()=>{await engine();},setPlayback,setProtectedTexts,hasCached,getStatus};
}
