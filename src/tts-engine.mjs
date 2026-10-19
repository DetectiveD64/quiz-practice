import {promises as fs} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ensurePhonemizer} from './voice-dependency.mjs';

const SAMPLE_RATE=24000,VOICE='af_heart',SPEED=.96;
const abort=signal=>{if(signal?.aborted)throw new Error('Speech was stopped.');};

export function encodeWav(samples){
  const out=Buffer.alloc(44+samples.length*2);
  out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVE',8);out.write('fmt ',12);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(SAMPLE_RATE,24);out.writeUInt32LE(SAMPLE_RATE*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(samples.length*2,40);
  for(let i=0;i<samples.length;i++)out.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]*.92))*32767),44+i*2);
  return out;
}

export function alignWords(words,durations,offset=0){
  // Kokoro's duration frames are 600 samples at 24 kHz. The official
  // KPipeline timestamp convention removes three leading decoder frames.
  const edges=[0];for(const duration of durations)edges.push(edges.at(-1)+Math.max(1,Math.round(Number(duration))));
  return words.map(word=>({position:word.position,count:word.count,time:offset+Math.max(0,(edges[word.tokenStart+1]||0)-3)/40}));
}

const punctuation=text=>text.replace(/\s+/g,' ').replace(/[‘’]/g,"'").replace(/[“”]/g,'"');

// Segmenting the original text is cheap and preserves its UTF-16 offsets.
// Phonemization is lazy: only the requested section and one boundary word
// are prepared. A word keeps its following punctuation in the same section.
export function createChunkPreparer(text,{phonemize,vocab,maxTokens=100}={}){
  if(typeof text!=='string'||typeof phonemize!=='function'||!vocab||!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>480)throw new Error('Invalid local voice preparation.');
  const units=[];let leading='';
  for(const segment of new Intl.Segmenter('en',{granularity:'word'}).segment(text)){
    if(segment.isWordLike)units.push({text:segment.segment,position:segment.index,count:segment.segment.length,suffix:'',prefix:units.length?'':leading});
    else if(units.length)units.at(-1).suffix+=segment.segment;
    else leading+=segment.segment;
  }
  const tokenized=new Map(),chunks=[];
  let cursor=0,finished=false,queue=Promise.resolve();
  const idsFor=phones=>[...phones].map(char=>vocab[char]).filter(id=>id!==undefined);
  async function unitAt(index,signal){
    abort(signal);
    if(tokenized.has(index))return tokenized.get(index);
    const unit=units[index];
    const phones=idsFor(await phonemize(unit.text,'a'));
    abort(signal);
    if(phones.length>480)throw new Error('A word is too long for the local voice.');
    if(!phones.length){tokenized.set(index,null);return null;}
    const prefix=idsFor(punctuation(unit.prefix));
    const suffix=idsFor(punctuation(unit.suffix));
    // Very long runs of punctuation cannot exceed the model's token limit.
    const prefixIds=prefix.slice(0,Math.max(0,509-phones.length));
    const ids=[...prefixIds,...phones,...suffix.slice(0,Math.max(0,509-prefixIds.length-phones.length))];
    const result={ids,position:unit.position,count:unit.count,tokenStart:prefixIds.length};
    tokenized.set(index,result);return result;
  }
  async function build(signal){
    // Commit the input cursor only after a whole section is prepared. A
    // cancelled request can retry without dropping any words from the text.
    let next=cursor;const ids=[],words=[];
    while(next<units.length){
      const unit=await unitAt(next,signal);
      if(!unit){next++;continue;}
      if(words.length&&ids.length+unit.ids.length>maxTokens){
        chunks.push({ids,words,nextPart:chunks.length+1});cursor=next;return;
      }
      words.push({position:unit.position,count:unit.count,tokenStart:ids.length+unit.tokenStart});
      ids.push(...unit.ids);next++;
    }
    abort(signal);cursor=next;finished=true;
    if(words.length)chunks.push({ids,words,nextPart:null});
  }
  return {
    get(part,{signal}={}){
      if(!Number.isInteger(part)||part<0||part>100)return Promise.reject(new Error('Choose a valid speech part.'));
      const job=queue.catch(()=>{}).then(async()=>{
        abort(signal);
        while(!finished&&chunks.length<=part)await build(signal);
        return chunks[part]||null;
      });
      queue=job;return job;
    },
  };
}

export async function loadEngine(root){
  const runtime=path.join(root,'neural');
  await ensurePhonemizer(runtime);
  const ort=(await import(pathToFileURL(path.join(runtime,'node_modules/onnxruntime-node/dist/index.js')).href)).default;
  const {phonemize}=await import(pathToFileURL(path.join(runtime,'phonemize.mjs')).href);
  const vocab=JSON.parse(await fs.readFile(path.join(runtime,'model/tokenizer.json'),'utf8')).model.vocab;
  const voiceBytes=await fs.readFile(path.join(runtime,'model/'+VOICE+'.bin'));
  const voices=new Float32Array(Uint8Array.from(voiceBytes).buffer);
  const session=await ort.InferenceSession.create(path.join(runtime,'model/kokoro-q8-timed.onnx'),{executionProviders:['cpu'],intraOpNumThreads:4,interOpNumThreads:1,logSeverityLevel:3});
  if(!session.outputNames.some(name=>['durations','duration','pred_dur'].includes(name)))throw new Error('The local voice model has no speech timings.');
  const prepared=new Map();
  async function generate(text,{signal,part=0}={}){
    abort(signal);
    let preparer=prepared.get(text);
    if(!preparer){preparer=createChunkPreparer(text,{phonemize,vocab});prepared.set(text,preparer);if(prepared.size>8)prepared.delete(prepared.keys().next().value);}
    const chunk=await preparer.get(part,{signal});
    if(!chunk)throw new Error('This part of the question is unavailable.');
    abort(signal);
    const tokens=[0,...chunk.ids,0],index=Math.min(chunk.ids.length,509)*256;
    const result=await session.run({input_ids:new ort.Tensor('int64',BigInt64Array.from(tokens.map(BigInt)),[1,tokens.length]),style:new ort.Tensor('float32',voices.slice(index,index+256),[1,256]),speed:new ort.Tensor('float32',Float32Array.of(SPEED),[1])});
    abort(signal);
    const audio=result.waveform?.data,durations=(result.durations||result.duration||result.pred_dur)?.data;
    if(!audio?.length||!durations||durations.length!==tokens.length)throw new Error('The local voice returned incomplete timings.');
    if(audio.length>SAMPLE_RATE*260)throw new Error('This question is too long to read aloud.');
    return {wav:encodeWav(audio),words:alignWords(chunk.words,durations),duration:audio.length/SAMPLE_RATE,voice:'Kokoro Heart (local neural)',nextPart:chunk.nextPart};
  }
  return {generate};
}
