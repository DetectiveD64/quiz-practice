import test from 'node:test';
import assert from 'node:assert/strict';
import {createChunkPreparer} from '../src/tts-engine.mjs';

const chars='abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ.,!?;:—-\'()';
const vocab=Object.fromEntries([...chars].map((char,index)=>[char,index+1]));
const decode=ids=>ids.map(id=>Object.keys(vocab).find(char=>vocab[char]===id)).join('');
const helper=(text,options={})=>createChunkPreparer(text,{phonemize:async word=>word,vocab,...options});

test('only the requested section and its boundary word are phonemized',async()=>{
  const calls=[];
  const preparer=helper('aaa bbb ccc ddd eee fff',{maxTokens:8,phonemize:async word=>{calls.push(word);return word;}});
  const first=await preparer.get(0);
  assert.deepEqual(calls,['aaa','bbb','ccc']);assert.equal(decode(first.ids),'aaa bbb ');assert.equal(first.nextPart,1);
  assert.deepEqual(first.words.map(word=>word.position),[0,4]);
  assert.equal(await preparer.get(0),first);assert.equal(calls.length,3);
  const second=await preparer.get(1);assert.equal(decode(second.ids),'ccc ddd ');assert.deepEqual(calls,['aaa','bbb','ccc','ddd','eee']);
});

test('sections retain punctuation and original UTF-16 word positions',async()=>{
  const text="😀 'Alpha,' beta—gamma!";
  const preparer=helper(text,{maxTokens:12});let part=0,previousEnd=-1,joined='';const words=[];
  do{
    const chunk=await preparer.get(part);assert(chunk);assert(chunk.words.length>0);joined+=decode(chunk.ids);
    for(const word of chunk.words){assert(word.position>=previousEnd);previousEnd=word.position+word.count;words.push(text.slice(word.position,previousEnd));}
    part=chunk.nextPart;
  }while(part!==null);
  assert.equal(joined," 'Alpha,' beta—gamma!");assert.deepEqual(words,['Alpha','beta','gamma']);
  assert.equal((await preparer.get(0)).words[0].position,4);
});

test('trailing punctuation stays with its last word and creates no empty section',async()=>{
  const preparer=helper('aaa bbb!!!  ...',{maxTokens:8});
  const first=await preparer.get(0),last=await preparer.get(first.nextPart);
  assert.equal(decode(first.ids),'aaa ');assert.equal(decode(last.ids),'bbb!!! ...');
  assert.equal(last.nextPart,null);assert.equal(await preparer.get(2),null);
});

test('a cancelled partial preparation retries without dropping prefix words',async()=>{
  const controller=new AbortController();let calls=0;
  const preparer=helper('alpha beta gamma delta',{maxTokens:12,phonemize:async word=>{if(++calls===2)controller.abort();return word;}});
  await assert.rejects(preparer.get(0,{signal:controller.signal}),/stopped/);
  const first=await preparer.get(0);assert.equal(decode(first.ids),'alpha beta ');assert.deepEqual(first.words.map(word=>word.position),[0,6]);
  const second=await preparer.get(1);assert.equal(decode(second.ids),'gamma delta');assert.equal(second.nextPart,null);
});

test('unpronounceable trailing words do not advertise an empty next section',async()=>{
  const preparer=helper('alpha beta zzz zzz',{maxTokens:12,phonemize:async word=>word==='zzz'?'':word});
  const first=await preparer.get(0);assert.equal(decode(first.ids),'alpha beta ');assert.equal(first.nextPart,null);assert.equal(await preparer.get(1),null);
});

test('nonsequential requests prepare earlier sections with globally ordered word positions',async()=>{
  const text='aaa bbb ccc ddd eee fff';const preparer=helper(text,{maxTokens:8});
  const third=await preparer.get(2);assert.equal(decode(third.ids),'eee fff');assert.equal(third.nextPart,null);
  const all=await Promise.all([0,1,2].map(part=>preparer.get(part)));
  assert.deepEqual(all.flatMap(chunk=>chunk.words.map(word=>text.slice(word.position,word.position+word.count))),['aaa','bbb','ccc','ddd','eee','fff']);
  assert.equal(all.map(chunk=>decode(chunk.ids)).join(''),text);
});

test('concurrent requests share prepared sections rather than consuming words twice',async()=>{
  let calls=0;const preparer=helper('aaa bbb ccc ddd',{maxTokens:8,phonemize:async word=>{calls++;await Promise.resolve();return word;}});
  const [a,b,c]=await Promise.all([preparer.get(0),preparer.get(1),preparer.get(0)]);
  assert.equal(a,c);assert.equal(decode(b.ids),'ccc ddd');assert.equal(calls,4);
});

test('a single long word is kept intact within the model token limit',async()=>{
  const text='a'.repeat(150)+'! bbb';const preparer=helper(text);
  const first=await preparer.get(0),last=await preparer.get(1);
  assert.equal(first.words[0].count,150);assert.equal(decode(first.ids),'a'.repeat(150)+'! ');assert.equal(last.words[0].position,152);assert.equal(last.nextPart,null);
});

test('oversized words and invalid section numbers are rejected',async()=>{
  await assert.rejects(helper('a'.repeat(481)).get(0),/too long/);
  const preparer=helper('alpha');for(const part of [-1,.5,101])await assert.rejects(preparer.get(part),/valid speech part/);
});

test('punctuation without spoken words never produces an invalid timing section',async()=>{
  assert.equal(await helper(' ... ! ').get(0),null);assert.equal(await helper('zzz',{phonemize:async()=>''}).get(0),null);
});
