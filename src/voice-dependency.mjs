import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

export const PHONEMIZER_URL='https://registry.npmjs.org/phonemizer/-/phonemizer-1.2.1.tgz';
export const PHONEMIZER_INTEGRITY='v0KJ4mi2T4Q7eJQ0W15Xd4G9k4kICSXE8bpDeJ8jisL4RyJhNWsweKTOi88QXFc4r4LZlz5jVL5lCHhkpdT71A==';
const MAX_COMPRESSED=8*1024*1024,MAX_EXPANDED=32*1024*1024;
const REQUIRED_FILES=Object.freeze({
  'package.json':'997824e7b16a1d30b000256146f4d8251eb1348823640bfa251b56ef5678a060',
  'LICENSE':'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  'dist/phonemizer.js':'193481f474f7c1ea81df3195d18b45df8ef7254dbdccb3f193d60215c4897bec',
});
const decode=bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const within=(parent,child)=>{const relative=path.relative(parent,child);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

function field(header,start,length){
  const bytes=header.subarray(start,start+length),zero=bytes.indexOf(0);
  if(zero>=0&&bytes.subarray(zero).some(value=>value!==0))throw new Error('Invalid voice archive header.');
  return decode(zero<0?bytes:bytes.subarray(0,zero));
}
function octal(header,start,length){
  const value=header.subarray(start,start+length).toString('ascii').replace(/[\0 ]+$/,'').replace(/^ +/,'');
  if(!/^[0-7]+$/.test(value))throw new Error('Invalid voice archive number.');
  const number=parseInt(value,8);
  if(!Number.isSafeInteger(number)||number<0)throw new Error('Invalid voice archive number.');
  return number;
}
function safeName(name){
  if(!name||name.startsWith('/')||name.includes('\\')||/^[a-z]:/i.test(name)||/[\x00-\x1f\x7f]/.test(name))return false;
  const parts=name.replace(/\/$/,'').split('/');
  return parts[0]==='package'&&parts.every(part=>part!==''&&part!=='.'&&part!=='..');
}
function validPackage(bytes){
  let value;try{value=JSON.parse(decode(bytes));}catch{throw new Error('Invalid local voice package.');}
  if(value.name!=='phonemizer'||value.version!=='1.2.1'||value.type!=='module'
    ||value.exports?.node?.import!=='./dist/phonemizer.js'||value.exports?.default!=='./dist/phonemizer.js')throw new Error('Unexpected local voice package.');
}

// Verify the pinned registry artifact before inspecting any archive entries.
// Only three known files are returned; no package scripts are ever executed.
export function readVoiceArchive(compressed,{integrity=PHONEMIZER_INTEGRITY,fileHashes=REQUIRED_FILES}={}){
  if(!Buffer.isBuffer(compressed)||compressed.length>MAX_COMPRESSED)throw new Error('The voice download is too large.');
  const expected=Buffer.from(integrity,'base64'),actual=createHash('sha512').update(compressed).digest();
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('The voice download failed its integrity check.');
  let tar;try{tar=gunzipSync(compressed,{maxOutputLength:MAX_EXPANDED});}catch{throw new Error('The voice archive could not be expanded safely.');}
  if(tar.length%512!==0)throw new Error('Invalid voice archive length.');
  const files=new Map(),names=new Set();let offset=0,ended=false;
  while(offset+512<=tar.length){
    const header=tar.subarray(offset,offset+512);
    if(header.every(value=>value===0)){
      if(offset+1024>tar.length||tar.subarray(offset).some(value=>value!==0))throw new Error('Invalid voice archive ending.');
      ended=true;break;
    }
    let checksum=0;for(let index=0;index<512;index++)checksum+=index>=148&&index<156?32:header[index];
    if(checksum!==octal(header,148,8))throw new Error('Invalid voice archive checksum.');
    if(field(header,257,6)!=='ustar')throw new Error('Unsupported voice archive format.');
    const prefix=field(header,345,155),name=(prefix?prefix+'/':'')+field(header,0,100);
    if(!safeName(name)||names.has(name))throw new Error('Unsafe or duplicate voice archive path.');
    names.add(name);
    const type=header[156],size=octal(header,124,12),start=offset+512,end=start+size;
    if(end>tar.length||size>MAX_EXPANDED)throw new Error('Invalid voice archive entry size.');
    // Reject links, devices, GNU/PAX metadata and all other entry types.
    if(type!==0&&type!==48&&type!==53)throw new Error('Unsupported voice archive entry type.');
    if(type===53&&size!==0)throw new Error('Invalid voice archive directory.');
    const relative=name.slice('package/'.length);
    if(Object.hasOwn(fileHashes,relative)){
      if(type===53)throw new Error('A required voice file is not a regular file.');
      files.set(relative,Buffer.from(tar.subarray(start,end)));
    }
    offset=start+Math.ceil(size/512)*512;
  }
  if(!ended)throw new Error('The voice archive is incomplete.');
  for(const [name,digest] of Object.entries(fileHashes)){
    const bytes=files.get(name);
    if(!bytes||hash(bytes)!==digest)throw new Error('A local voice file failed its integrity check.');
  }
  validPackage(files.get('package.json'));
  decode(files.get('dist/phonemizer.js'));
  return files;
}

async function regularFile(file){const item=await fs.lstat(file);return item.isFile()&&!item.isSymbolicLink();}
async function validInstallation(target,fileHashes){
  try{
    const directory=await fs.lstat(target),dist=await fs.lstat(path.join(target,'dist'));
    if(!directory.isDirectory()||directory.isSymbolicLink()||!dist.isDirectory()||dist.isSymbolicLink())return false;
    for(const [name,digest] of Object.entries(fileHashes)){
      const file=path.join(target,name);if(!await regularFile(file))return false;
      if(hash(await fs.readFile(file))!==digest)return false;
    }
    validPackage(await fs.readFile(path.join(target,'package.json')));return true;
  }catch{return false;}
}
async function download(fetchImpl,url){
  const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok||response.status!==200||!response.body)throw new Error('The local voice could not be downloaded. Connect to the internet and try again.');
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_COMPRESSED))throw new Error('The voice download is too large.');
  const reader=response.body.getReader(),parts=[];let size=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_COMPRESSED)throw new Error('The voice download is too large.');parts.push(Buffer.from(value));}
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  return Buffer.concat(parts,size);
}

// The exported factory keeps the installer independently testable. Production
// uses the fixed defaults below, including the registry URL and SHA-512 digest.
export function createVoiceDependencyInstaller({fetchImpl=globalThis.fetch,url=PHONEMIZER_URL,integrity=PHONEMIZER_INTEGRITY,fileHashes=REQUIRED_FILES}={}){
  const pending=new Map();
  async function install(runtime){
    const root=path.resolve(runtime),rootInfo=await fs.lstat(root);
    if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error('The local voice folder is unavailable.');
    const modules=path.join(root,'node_modules');await fs.mkdir(modules,{recursive:true});
    const modulesInfo=await fs.lstat(modules);
    if(!modulesInfo.isDirectory()||modulesInfo.isSymbolicLink())throw new Error('The local voice dependency folder is unsafe.');
    const target=path.join(modules,'phonemizer');
    if(await validInstallation(target,fileHashes))return target;
    try{await fs.lstat(target);throw new Error('The local voice files are incomplete. Extract a fresh copy of Quiz Practice to repair them.');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const files=readVoiceArchive(await download(fetchImpl,url),{integrity,fileHashes});
    const stage=path.join(modules,'.phonemizer-'+randomUUID());
    if(!within(modules,stage)||!/^\.phonemizer-[a-f0-9-]+$/.test(path.basename(stage)))throw new Error('Invalid voice staging folder.');
    await fs.mkdir(stage,{recursive:false});
    try{
      await fs.mkdir(path.join(stage,'dist'));
      for(const [name,bytes] of files)await fs.writeFile(path.join(stage,name),bytes,{flag:'wx',mode:0o644});
      try{await fs.rename(stage,target);}
      catch(error){if(!await validInstallation(target,fileHashes))throw error;}
      return target;
    }finally{
      // The only removable path is this invocation's generated staging folder.
      try{const item=await fs.lstat(stage);if(item.isDirectory()&&!item.isSymbolicLink()&&within(modules,stage))await fs.rm(stage,{recursive:true,force:true});}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }
  return function ensure(runtime){
    const key=path.resolve(runtime);if(pending.has(key))return pending.get(key);
    const job=install(key);pending.set(key,job);
    job.finally(()=>{if(pending.get(key)===job)pending.delete(key);}).catch(()=>{});
    return job;
  };
}

export const ensurePhonemizer=createVoiceDependencyInstaller();
