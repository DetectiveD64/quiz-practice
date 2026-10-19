import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createVoiceDependencyInstaller,readVoiceArchive,PHONEMIZER_URL,PHONEMIZER_INTEGRITY} from '../src/voice-dependency.mjs';

const sha=(bytes,algorithm='sha256',encoding='hex')=>createHash(algorithm).update(bytes).digest(encoding);
const packageBytes=Buffer.from(JSON.stringify({name:'phonemizer',version:'1.2.1',type:'module',exports:{node:{import:'./dist/phonemizer.js'},default:'./dist/phonemizer.js'}}));
const fixtureFiles={'package.json':packageBytes,LICENSE:Buffer.from('test fixture license'),'dist/phonemizer.js':Buffer.from('export const phonemize = text => [text];\n')};
const fileHashes=Object.fromEntries(Object.entries(fixtureFiles).map(([name,bytes])=>[name,sha(bytes)]));
const entries=()=>Object.entries(fixtureFiles).map(([name,bytes])=>({name:'package/'+name,bytes}));
function archive(items=entries(),{badChecksum=false,endBlocks=2}={}){
  const parts=[];
  for(const {name,bytes=Buffer.alloc(0),type='0'} of items){
    const header=Buffer.alloc(512);header.write(name,0,100);header.write('0000644\0',100,8);header.write('0000000\0',108,8);header.write('0000000\0',116,8);
    header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124,12);header.write('00000000000\0',136,12);header.fill(32,148,156);header.write(type,156,1);header.write('ustar\0',257,6);header.write('00',263,2);
    const checksum=header.reduce((sum,value)=>sum+value,0)+(badChecksum?1:0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);
    parts.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  parts.push(Buffer.alloc(512*endBlocks));const packed=gzipSync(Buffer.concat(parts));
  return {packed,options:{integrity:sha(packed,'sha512','base64'),fileHashes}};
}
function factory(fixture,extra={}){
  let calls=0,options;
  const ensure=createVoiceDependencyInstaller({integrity:fixture.options.integrity,fileHashes,fetchImpl:async(url,received)=>{calls++;options=received;assert.equal(url,PHONEMIZER_URL);return new Response(fixture.packed);},...extra});
  return {ensure,get calls(){return calls;},get options(){return options;}};
}
async function runtime(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'quiz-voice-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const neural=path.join(root,'neural');await fs.mkdir(neural);return {root,neural};}

test('production download is pinned to the official package and SHA-512 digest',()=>{
  assert.equal(PHONEMIZER_URL,'https://registry.npmjs.org/phonemizer/-/phonemizer-1.2.1.tgz');
  assert.equal(Buffer.from(PHONEMIZER_INTEGRITY,'base64').length,64);
});

test('only the three required verified files are selected from a valid archive',()=>{
  const fixture=archive([...entries(),{name:'package/README.md',bytes:Buffer.from('not extracted')},{name:'package/dist/phonemizer.cjs',bytes:Buffer.from('not extracted')}]);
  const selected=readVoiceArchive(fixture.packed,fixture.options);assert.deepEqual([...selected.keys()],Object.keys(fixtureFiles));
  for(const [name,bytes] of selected)assert.deepEqual(bytes,fixtureFiles[name]);
});

test('integrity failure is rejected before archive parsing or decompression',()=>{
  const bytes=Buffer.from('not a gzip archive');assert.throws(()=>readVoiceArchive(bytes),/integrity/);
  const fixture=archive();fixture.packed[fixture.packed.length-1]^=1;assert.throws(()=>readVoiceArchive(fixture.packed,fixture.options),/integrity/);
});

test('compressed and expanded size limits reject oversized downloads',()=>{
  assert.throws(()=>readVoiceArchive(Buffer.alloc(8*1024*1024+1)),/too large/);
  const packed=gzipSync(Buffer.alloc(32*1024*1024+1));assert.throws(()=>readVoiceArchive(packed,{integrity:sha(packed,'sha512','base64'),fileHashes}),/expanded safely/);
});

test('unsafe absolute, traversal, Windows and ambiguous archive paths are rejected',()=>{
  for(const name of ['/tmp/escape','../escape','package/../escape','C:/escape','package/dir\\escape','package//escape','package/./escape']){
    const fixture=archive([...entries(),{name}]);assert.throws(()=>readVoiceArchive(fixture.packed,fixture.options),/Unsafe/);
  }
});

test('links, devices and archive metadata are rejected even for ignored files',()=>{
  for(const type of ['1','2','3','4','6','x','g','L']){
    const fixture=archive([...entries(),{name:'package/other',type}]);assert.throws(()=>readVoiceArchive(fixture.packed,fixture.options),/entry type/);
  }
});

test('duplicate entries, bad checksums, truncated endings and file corruption are rejected',()=>{
  let fixture=archive([...entries(),entries()[0]]);assert.throws(()=>readVoiceArchive(fixture.packed,fixture.options),/duplicate/);
  fixture=archive(entries(),{badChecksum:true});assert.throws(()=>readVoiceArchive(fixture.packed,fixture.options),/checksum/);
  fixture=archive(entries(),{endBlocks:1});assert.throws(()=>readVoiceArchive(fixture.packed,fixture.options),/ending/);
  fixture=archive(entries().map(item=>item.name.endsWith('.js')?{...item,bytes:Buffer.from('corrupt')}:item));assert.throws(()=>readVoiceArchive(fixture.packed,fixture.options),/file failed/);
});

test('package identity, version and exports must match the expected ESM package',()=>{
  for(const changes of [{name:'other'},{version:'9.0.0'},{type:'commonjs'},{exports:{default:'../escape.js'}}]){
    const value=Buffer.from(JSON.stringify({...JSON.parse(packageBytes),...changes}));const fixture=archive(entries().map(item=>item.name==='package/package.json'?{...item,bytes:value}:item));
    fixture.options.fileHashes={...fileHashes,'package.json':sha(value)};assert.throws(()=>readVoiceArchive(fixture.packed,fixture.options),/(Unexpected|Invalid) local voice package/);
  }
});

test('fresh installation is atomic, ignores scripts and creates no practice history',async t=>{
  const {root,neural}=await runtime(t),fixture=archive(),install=factory(fixture);const target=await install.ensure(neural);
  assert.equal(target,path.join(neural,'node_modules','phonemizer'));assert.equal(install.calls,1);assert.equal(install.options.redirect,'error');assert(install.options.signal instanceof AbortSignal);
  assert.deepEqual((await fs.readdir(root)).sort(),['neural']);assert.deepEqual(await fs.readdir(path.join(neural,'node_modules')),['phonemizer']);
  assert.deepEqual((await fs.readdir(target)).sort(),['LICENSE','dist','package.json']);assert.equal(await fs.readFile(path.join(target,'dist/phonemizer.js'),'utf8'),fixtureFiles['dist/phonemizer.js'].toString());
});

test('valid cached installation works offline and preserves unrelated data',async t=>{
  const {root,neural}=await runtime(t),fixture=archive(),install=factory(fixture);await install.ensure(neural);
  const history=path.join(root,'data');await fs.mkdir(history);await fs.writeFile(path.join(history,'state.json'),'private sentinel');
  const offline=createVoiceDependencyInstaller({integrity:fixture.options.integrity,fileHashes,fetchImpl:()=>{throw new Error('must remain offline');}});
  await offline(neural);assert.equal(await fs.readFile(path.join(history,'state.json'),'utf8'),'private sentinel');assert.equal(install.calls,1);
});

test('concurrent first starts share one download and one installation',async t=>{
  const {neural}=await runtime(t),fixture=archive(),install=factory(fixture);const a=install.ensure(neural),b=install.ensure(neural);assert.equal(a,b);
  const result=await Promise.all([a,b,install.ensure(neural)]);assert(result.every(value=>value===result[0]));assert.equal(install.calls,1);
});

test('corrupt existing installations are preserved and never loaded or overwritten',async t=>{
  const {neural}=await runtime(t),fixture=archive(),install=factory(fixture),target=await install.ensure(neural);const file=path.join(target,'dist/phonemizer.js');await fs.writeFile(file,'corrupt sentinel');
  await assert.rejects(install.ensure(neural),/incomplete/);assert.equal(install.calls,1);assert.equal(await fs.readFile(file,'utf8'),'corrupt sentinel');
});

test('failed downloads leave no installation and a later attempt can recover',async t=>{
  const {neural}=await runtime(t),fixture=archive();let attempt=0;
  const ensure=createVoiceDependencyInstaller({integrity:fixture.options.integrity,fileHashes,fetchImpl:async()=>++attempt===1?new Response('failed',{status:503}):new Response(fixture.packed)});
  await assert.rejects(ensure(neural),/downloaded/);assert.deepEqual(await fs.readdir(path.join(neural,'node_modules')),[]);
  await ensure(neural);assert.equal(attempt,2);
});

test('response and streaming limits reject excessive data without writing a package',async t=>{
  const {neural}=await runtime(t),fixture=archive();
  for(const response of [new Response(fixture.packed,{headers:{'content-length':String(8*1024*1024+1)}}),new Response(Buffer.alloc(8*1024*1024+1))]){
    const ensure=createVoiceDependencyInstaller({fetchImpl:async()=>response});await assert.rejects(ensure(neural),/too large/);
    assert.deepEqual(await fs.readdir(path.join(neural,'node_modules')),[]);
  }
});
