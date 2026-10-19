import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { TOPICS, LEVELS, getCatalog, randomQuestions } from './sources.mjs';
import { gradeAnswer } from './grading.mjs';
import { repairLegacySemanticAttempts } from './grading-repair.mjs';
import { createSpeechService } from './tts.mjs';

const headers = { 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer', 'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
const json = (value,status=200) => new Response(JSON.stringify(value), {status,headers:{...headers,'content-type':'application/json; charset=utf-8'}});
const assets = new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/app.css',['app.css','text/css']],['/icon.svg',['icon.svg','image/svg+xml']]]);
const levelIds = () => LEVELS.map(level => level.id);
const defaults = () => ({version:1,preferences:{topics:[...TOPICS],levels:levelIds(),readAloud:true},attempts:[],seen:[]});
const sameToken = (a,b) => typeof a==='string' && /^[a-f0-9]{64}$/.test(a) && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const filterList = (list, allowed) => Array.isArray(list) && list.length<=allowed.length && list.every(value=>allowed.includes(value));
const filterKey = (topics,levels) => JSON.stringify([[...new Set(topics)].sort(),[...new Set(levels)].sort()]);

export function calculateStats(attempts) {
  let correct=0,streak=0,bestStreak=0;
  const byTopic={},byLevel={};
  for(const item of attempts) {
    const right=item.verdict==='correct';
    if(right){correct++;streak++;bestStreak=Math.max(bestStreak,streak);}else streak=0;
    for(const [bucket,key] of [[byTopic,item.topic],[byLevel,item.level]]) {
      bucket[key] ||= {answered:0,correct:0}; bucket[key].answered++; if(right)bucket[key].correct++;
    }
  }
  return {answered:attempts.length,correct,incorrect:attempts.length-correct,accuracy:attempts.length?Math.round(correct/attempts.length*100):0,streak,bestStreak,byTopic,byLevel};
}

export async function createPracticeApp({root,questionSource=randomQuestions,catalogSource=getCatalog,grader=gradeAnswer,speechService=null,port=43877}={}) {
  const speech=speechService||createSpeechService({root});
  const data=path.join(root,'data'); await fs.mkdir(data,{recursive:true});
  async function load(name,fallback) { try {return JSON.parse(await fs.readFile(path.join(data,name),'utf8'));} catch(error){if(error.code==='ENOENT')return fallback;throw new Error('A saved practice file could not be read. The original file has been preserved.');} }
  let state=await load('state.json',defaults());
  if(!state || !Array.isArray(state.attempts) || !Array.isArray(state.seen) || !filterList(state.preferences?.topics,TOPICS) || !filterList(state.preferences?.levels,levelIds()) || typeof state.preferences?.readAloud!=='boolean')throw new Error('Saved practice settings are unreadable. The original file has been preserved.');
  const cached=await load('questions.json',{questions:[],catalog:null});
  const questions=new Map((cached.questions||[]).filter(q=>q?.id && q.text && q.answerline).map(q=>[q.id,q]));
  const repair=repairLegacySemanticAttempts(state,questions);
  if(repair.corrected.length){
    const backups=path.join(data,'grading-repairs');await fs.mkdir(backups,{recursive:true});
    await fs.writeFile(path.join(backups,'before-strict-grading-'+Date.now()+'-'+randomUUID()+'.json'),JSON.stringify(state,null,2),{flag:'wx'});
    await write('state.json',repair.state);state=repair.state;
  }
  let catalog=cached.catalog,cacheQueue=Promise.resolve(),stateQueue=Promise.resolve(),catalogPromise=null;
  const issued=new Map(), recent=new Set(state.seen), fetches=new Map();
  const prepared=new Map(),background=new Set();let activeWarm=null,preparationKey=null,manifestQueue=Promise.resolve(),warmPump=null,currentQuestionId=null,playbackSequence=-1;
  const BUFFER_SIZE=3,MAX_PRELOAD_PARTS=24;
  let token;
  try{token=(await fs.readFile(path.join(data,'csrf-token'),'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!token || !/^[a-f0-9]{64}$/.test(token)){token=randomBytes(32).toString('hex');await fs.writeFile(path.join(data,'csrf-token'),token,{mode:0o600});}
  async function write(name,value) {
    const target=path.join(data,name),temporary=target+'.'+randomUUID()+'.tmp';
    await fs.writeFile(temporary,JSON.stringify(value,null,2)); await fs.rename(temporary,target);
  }
  const saveCache=()=>{const job=cacheQueue.then(()=>write('questions.json',{questions:[...questions.values()].slice(-10000),catalog}));cacheQueue=job.catch(()=>{});return job;};
  const savePreparation=()=>{const job=manifestQueue.then(()=>write('preload.json',{version:1,queues:[...prepared.values()].filter(slot=>slot.queue.length).map(slot=>({topics:slot.topics,levels:slot.levels,ids:slot.queue.map(item=>item.question.id)}))}));manifestQueue=job.catch(()=>{});return job;};
  function editState(fn){const job=stateQueue.then(async()=>{const copy=structuredClone(state);const result=fn(copy);await write('state.json',copy);state=copy;return result;});stateQueue=job.catch(()=>{});return job;}
  function catalogBackground(){
    if(catalogPromise)return catalogPromise;
    if(catalog?.fetchedAt && Date.now()-Date.parse(catalog.fetchedAt)<86400000)return Promise.resolve(catalog);
    catalogPromise=(async()=>{try{catalog=await catalogSource();await saveCache();return catalog;}catch{return catalog;}finally{catalogPromise=null;}})();return catalogPromise;
  }
  async function refill(topics,levels) {
    const key=filterKey(topics,levels);
    if(fetches.has(key))return fetches.get(key);
    const job=(async()=>{
      const batch=await questionSource({topics,levels,count:20});let changed=false;
      for(const question of batch.questions||[]){if(JSON.stringify(questions.get(question.id))!==JSON.stringify(question)){questions.set(question.id,question);changed=true;}}
      // A downloaded question is usable immediately. Persist the archive in the
      // background rather than holding its first question behind a cache write.
      if(changed)void saveCache().catch(()=>{});
      return batch;
    })();
    fetches.set(key,job);try{return await job;}finally{fetches.delete(key);}
  }
  const matching=(topics,levels)=>[...questions.values()].filter(q=>topics.includes(q.topic)&&levels.includes(q.level));
  function trackBackground(job){background.add(job);void job.catch(()=>{}).then(()=>background.delete(job));return job;}
  function protectPreparation(){speech.setProtectedTexts?.(prepared.get(preparationKey)?.queue.map(item=>item.question.text)||[]);}
  function activatePreparation(key){
    preparationKey=key;
    for(const slot of prepared.values())if(slot.key!==key)slot.warmRequested=false;
    if(activeWarm&&activeWarm.slot.key!==key&&!activeWarm.item.consumed)activeWarm.controller.abort();
    protectPreparation();
  }
  const preparationSummary=slot=>({prepared:!!slot?.queue.length,buffered:slot?.queue.length||0,readyVoices:slot?.queue.filter(item=>item.parts.has(0)).length||0});
  async function cachedPreparationSummary(slot){
    const summary=preparationSummary(slot);
    if(slot&&typeof speech.hasCached==='function')summary.readyVoices=(await Promise.all(slot.queue.map(item=>Promise.resolve().then(()=>speech.hasCached(item.question.text,{part:0})).catch(()=>false)))).filter(Boolean).length;
    return summary;
  }
  function candidateToWarm(slot){
    const usable=slot.queue.filter(item=>!item.failed&&!item.consumed);
    // Give every upcoming question its opening before spending idle time on
    // the rest of the nearest question. Short questions may have one section.
    for(let depth=0;depth<2;depth++){
      const item=usable.find(item=>item.parts.size===depth&&!item.finished);
      if(item)return item;
    }
    const nearest=usable[0];return nearest&&!nearest.finished&&nearest.parts.size<MAX_PRELOAD_PARTS?nearest:null;
  }
  function pumpPrepared(){
    if(warmPump)return;
    warmPump=trackBackground(Promise.resolve().then(async()=>{
      while(true){
        const slot=prepared.get(preparationKey);if(!slot?.warmRequested)break;
        const item=candidateToWarm(slot);if(!item)break;
        const controller=new AbortController(),warm={slot,item,controller};activeWarm=warm;
        try{
          const part=item.nextPart;
          const result=await speech.generate(item.question.text,{part,priority:'background',signal:controller.signal});
          if(controller.signal.aborted)continue;
          item.parts.set(part,result?.nextPart??null);
          const next=result?.nextPart;
          item.finished=next===null||next===undefined;
          if(!item.finished){if(!Number.isInteger(next)||next<=part||next>100)item.failed=true;else item.nextPart=next;}
        }catch{if(!controller.signal.aborted)item.failed=true;}
        finally{if(activeWarm===warm)activeWarm=null;}
      }
    }).finally(()=>{warmPump=null;const slot=prepared.get(preparationKey);if(slot?.warmRequested&&candidateToWarm(slot))pumpPrepared();}));
  }
  function fillPrepared(slot){
    const previous=slot.queue.length;
    slot.queue=slot.queue.filter(item=>!recent.has(item.question.id));
    const reserved=new Set([...prepared.values()].flatMap(other=>other.queue.map(item=>item.question.id)));
    const pool=matching(slot.topics,slot.levels).filter(question=>!recent.has(question.id)&&!reserved.has(question.id));
    while(slot.queue.length<BUFFER_SIZE&&pool.length){
      const index=Math.floor(Math.random()*pool.length),question=pool.splice(index,1)[0];
      slot.queue.push({question,parts:new Map(),nextPart:0,finished:false,failed:false,consumed:false});
    }
    if(slot.queue.length!==previous)void savePreparation().catch(()=>{});
    protectPreparation();
    if(slot.warmRequested&&preparationKey===slot.key)pumpPrepared();
  }
  function getPreparation(topics,levels){
    const key=filterKey(topics,levels);let slot=prepared.get(key);
    if(!slot){
      slot={key,topics:[...new Set(topics)].sort(),levels:[...new Set(levels)].sort(),queue:[],pending:null,warmRequested:false};prepared.set(key,slot);
      if(prepared.size>8){const oldest=prepared.keys().next().value;if(oldest!==key)prepared.delete(oldest);}
    }
    return slot;
  }
  function prepareNext(topics,levels,warmSpeech=false){
    const key=filterKey(topics,levels);activatePreparation(key);
    if(!topics.length||!levels.length)return preparationSummary(null);
    const slot=getPreparation(topics,levels);
    slot.warmRequested ||= warmSpeech&&state.preferences.readAloud;
    if(warmSpeech)for(const item of slot.queue)item.failed=false;
    fillPrepared(slot);
    if(slot.queue.length<BUFFER_SIZE&&!slot.pending){
      slot.pending=trackBackground((async()=>{
        try{await refill(topics,levels);if(prepared.get(key)===slot)fillPrepared(slot);}
        finally{slot.pending=null;}
      })());
    }
    return preparationSummary(slot);
  }
  function takePrepared(key){
    const slot=prepared.get(key);if(!slot)return null;
    while(slot.queue.length&&recent.has(slot.queue[0].question.id))slot.queue.shift();
    const item=slot.queue.shift();if(!item)return null;
    item.consumed=true;void savePreparation().catch(()=>{});
    protectPreparation();
    // Keep an in-flight recording alive for the matching foreground request.
    // The player shares the recording; only future speculative work is dropped.
    return item.question;
  }
  function stopCurrentPlayback(expectedId=currentQuestionId){
    if(currentQuestionId!==expectedId)return;
    const current=issued.get(currentQuestionId);
    if(current){speech.setPlayback?.(current.question.text,false);if(activeWarm?.item.consumed&&activeWarm.item.question.id===current.question.id)activeWarm.controller.abort();}
    currentQuestionId=null;playbackSequence=-1;
  }
  async function nextQuestion(topics,levels) {
    const previousQuestionId=currentQuestionId,key=filterKey(topics,levels);activatePreparation(key);
    if(!topics.length || !levels.length){stopCurrentPlayback(previousQuestionId);return {question:null,count:0,empty:true,message:'Choose at least one topic and one level.'};}
    let question=takePrepared(key),pool=matching(topics,levels).filter(q=>!recent.has(q.id)),sourceError=null;
    if(!pool.length){try{await refill(topics,levels);}catch(error){sourceError=error.message;}pool=matching(topics,levels).filter(q=>!recent.has(q.id));}
    question ||= takePrepared(key);
    if(!pool.length && !sourceError && matching(topics,levels).length) {
      const ids=new Set(matching(topics,levels).map(q=>q.id));for(const id of ids)recent.delete(id);
      await editState(s=>{s.seen=s.seen.filter(id=>!ids.has(id));});pool=matching(topics,levels);
    }
    if(!pool.length){stopCurrentPlayback(previousQuestionId);return {question:null,count:0,empty:true,message:sourceError?'The archive is unavailable and no unread cached questions match. Try again shortly.':'No questions match those filters. Try another topic or level.'};}
    question ||= pool[Math.floor(Math.random()*pool.length)];const id=randomUUID();
    recent.add(question.id);issued.set(id,{question,result:null});
    if(activeWarm?.item.consumed&&activeWarm.item.question.id!==question.id)activeWarm.controller.abort();
    currentQuestionId=id;playbackSequence=-1;speech.setPlayback?.(question.text,state.preferences.readAloud);
    for(const slot of prepared.values())slot.queue=slot.queue.filter(item=>item.question.id!==question.id);
    if(issued.size>3000)issued.delete(issued.keys().next().value);
    await editState(s=>{s.seen=[...s.seen.filter(value=>value!==question.id),question.id].slice(-30000);});
    // Replenish the reserve without issuing those questions or changing history.
    prepareNext(topics,levels,prepared.get(key)?.warmRequested===true);
    if(pool.length<=8)void refill(topics,levels).catch(()=>{});
    void catalogBackground();
    return {question:{id,text:question.text,topic:question.topic,level:question.level,source:question.source},count:matching(topics,levels).length,archiveCount:catalog?.totals?.tossups||null};
  }
  async function answer(body) {
    if(typeof body.id!=='string' || typeof body.attempt!=='string' || body.attempt.length>400 || !body.attempt.trim() || typeof body.requestId!=='string' || body.requestId.length>100)throw new Error('Type an answer first.');
    const entry=issued.get(body.id);if(!entry)throw new Error('This question has expired. Load the next question.');
    if(entry.result)return {...entry.result,stats:calculateStats(state.attempts)};
    if(entry.pending)return entry.pending;
    entry.pending=(async()=>{
      const result=await grader({...entry.question,answer:entry.question.answerline},body.attempt.trim());
      if(!['correct','incorrect','prompt'].includes(result.verdict))throw new Error('The answer could not be checked. Try again.');
      if(result.verdict==='prompt')return {verdict:'prompt',message:'Be more specific.',method:result.method,stats:calculateStats(state.attempts)};
      const record={requestId:body.requestId,id:body.id,questionId:entry.question.id,attempt:body.attempt.trim(),verdict:result.verdict,method:result.method,topic:entry.question.topic,level:entry.question.level,at:new Date().toISOString()};
      await editState(s=>{if(!s.attempts.some(a=>a.id===body.id || a.requestId===body.requestId))s.attempts.push(record);});
      entry.result={verdict:result.verdict,answer:entry.question.answerText||entry.question.answerline.replace(/<[^>]*>/g,''),method:result.method,stats:calculateStats(state.attempts)};
      return entry.result;
    })();
    try{return await entry.pending;}finally{entry.pending=null;}
  }
  const origins=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
  async function handle(request) {
    try {
      const url=new URL(request.url),origin=request.headers.get('origin');
      if(!origins.has(url.origin)||(origin&&!origins.has(origin))||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'Open the local practice app.'},403);
      if(request.method==='GET') {
        if(url.pathname==='/api/health')return json({app:'quiz-practice',ok:true,preloading:'rolling-v1'});
        if(url.pathname==='/api/state')return json({stats:calculateStats(state.attempts),preferences:state.preferences,csrfToken:token,archiveCount:catalog?.totals?.tossups||null});
        if(url.pathname==='/api/preload/status')return json(await cachedPreparationSummary(prepared.get(preparationKey||filterKey(state.preferences.topics,state.preferences.levels))));
        const audio=url.pathname.match(/^\/api\/speech\/audio\/([a-f0-9]{64})\.wav$/);
        if(audio){try{return new Response(await speech.audio(audio[1]),{headers:{...headers,'content-type':'audio/wav'}});}catch{return json({error:'This voice recording is no longer cached. Replay the question.'},404);}}
        if(url.pathname==='/api/question') {
          const topics=url.searchParams.has('topics')?url.searchParams.get('topics').split(',').filter(Boolean):state.preferences.topics;
          const levels=url.searchParams.has('levels')?url.searchParams.get('levels').split(',').filter(Boolean):state.preferences.levels;
          if(!filterList(topics,TOPICS)||!filterList(levels,levelIds()))return json({error:'Choose filters from the checkboxes.'},400);
          return json(await nextQuestion(topics,levels));
        }
        const asset=assets.get(url.pathname);if(asset)return new Response(await fs.readFile(path.join(root,'public',asset[0])),{headers:{...headers,'content-type':asset[1]+'; charset=utf-8'}});
        return json({error:'Page not found.'},404);
      }
      if(request.method!=='POST')return json({error:'Action unavailable.'},405);
      if(!origin||!sameToken(request.headers.get('x-practice-token'),token))return json({error:'Reload the practice window before saving.'},403);
      if(!/^application\/json\b/i.test(request.headers.get('content-type')||''))return json({error:'Send a JSON app action.'},415);
      const text=await request.text();if(text.length>12000)return json({error:'The app action is too large.'},413);
      let body;try{body=JSON.parse(text);}catch{return json({error:'The app action was unreadable.'},400);}
      if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'Choose an app action.'},400);
      if(url.pathname==='/api/answer')return json(await answer(body));
      if(url.pathname==='/api/playback'){
        if(typeof body.id!=='string'||body.id.length>100||typeof body.active!=='boolean'||!Number.isSafeInteger(body.sequence)||body.sequence<0)throw new Error('Choose a valid reading state.');
        if(body.id!==currentQuestionId||body.sequence<=playbackSequence)return json({accepted:false});
        const entry=issued.get(body.id);if(!entry)return json({accepted:false});
        playbackSequence=body.sequence;speech.setPlayback?.(entry.question.text,body.active&&state.preferences.readAloud);
        if(!body.active&&activeWarm?.item.consumed&&activeWarm.item.question.id===entry.question.id)activeWarm.controller.abort();
        return json({accepted:true});
      }
      if(url.pathname==='/api/speech')return json(await speech.generate(body.text,{signal:request.signal,part:body.part??0}));
      if(url.pathname==='/api/prepare-next'){
        if(!filterList(body.topics,TOPICS)||!filterList(body.levels,levelIds())||(body.warmSpeech!==undefined&&typeof body.warmSpeech!=='boolean'))throw new Error('Choose filters using the checkboxes.');
        prepareNext(body.topics,body.levels,body.warmSpeech===true);
        return json(await cachedPreparationSummary(prepared.get(filterKey(body.topics,body.levels))));
      }
      if(url.pathname==='/api/preferences') {
        if(!filterList(body.topics,TOPICS)||!filterList(body.levels,levelIds())||typeof body.readAloud!=='boolean')throw new Error('Choose filters using the checkboxes.');
        await editState(s=>{s.preferences={topics:[...new Set(body.topics)],levels:[...new Set(body.levels)],readAloud:body.readAloud};});
        if(!body.readAloud){
          for(const slot of prepared.values())slot.warmRequested=false;
          if(activeWarm)activeWarm.controller.abort();
          const current=issued.get(currentQuestionId);if(current)speech.setPlayback?.(current.question.text,false);
        }
        return json(state.preferences);
      }
      return json({error:'Action not found.'},404);
    }catch(error){return json({error:error.message||'The action could not be completed.'},400);}
  }
  // This file contains only archive IDs and filters, never answers or attempts.
  // A stale or incomplete manifest is disposable; the question cache and real
  // practice history remain the sources of truth.
  try{
    const manifest=JSON.parse(await fs.readFile(path.join(data,'preload.json'),'utf8'));
    if(manifest?.version===1&&Array.isArray(manifest.queues)){
      const reserved=new Set();
      for(const saved of manifest.queues.slice(0,8)){
        if(!filterList(saved?.topics,TOPICS)||!filterList(saved?.levels,levelIds())||!saved.topics.length||!saved.levels.length||!Array.isArray(saved.ids))continue;
        const slot=getPreparation(saved.topics,saved.levels);
        for(const id of saved.ids.slice(0,BUFFER_SIZE)){
          if(slot.queue.length>=BUFFER_SIZE)break;
          const question=questions.get(id);
          if(!question||recent.has(id)||reserved.has(id)||!slot.topics.includes(question.topic)||!slot.levels.includes(question.level))continue;
          reserved.add(id);const parts=new Map();
          if(typeof speech.hasCached==='function'&&await speech.hasCached(question.text,{part:0}))parts.set(0,undefined);
          slot.queue.push({question,parts,nextPart:0,finished:false,failed:false,consumed:false});
        }
      }
    }
  }catch{}
  if(state.preferences.readAloud&&typeof speech.warm==='function')trackBackground(Promise.resolve().then(()=>speech.warm()));
  return {handle,prime:async()=>{await Promise.allSettled([refill([...TOPICS],levelIds()),catalogBackground()]);},snapshot:()=>structuredClone(state),settle:async()=>{while(background.size)await Promise.allSettled([...background]);await Promise.allSettled([catalogPromise,...fetches.values()]);await Promise.allSettled([stateQueue,cacheQueue,manifestQueue]);}};
}
