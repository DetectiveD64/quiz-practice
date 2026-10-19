import http from 'node:http';
import path from 'node:path';
import { createPracticeApp } from './app.mjs';

const root=path.resolve(process.env.QUIZ_PRACTICE_ROOT||path.join(import.meta.dirname,'..'));
const app=await createPracticeApp({root});
const server=http.createServer(async(incoming,outgoing)=>{
  try {
    const host=incoming.headers.host;
    if(!['127.0.0.1:43877','localhost:43877'].includes(host)){outgoing.writeHead(403);outgoing.end('Open the local practice app.');return;}
    let bytes=0;const chunks=[];
    for await(const chunk of incoming){bytes+=chunk.length;if(bytes>12000){outgoing.writeHead(413);outgoing.end('App action too large.');return;}chunks.push(chunk);}
    const cancellation=new AbortController();
    outgoing.on('close',()=>{if(!outgoing.writableFinished)cancellation.abort();});
    const options={method:incoming.method,headers:incoming.headers,signal:cancellation.signal};
    if(!['GET','HEAD'].includes(incoming.method))options.body=Buffer.concat(chunks);
    const response=await app.handle(new Request(`http://${host}${incoming.url}`,options));
    if(outgoing.destroyed)return;
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch{outgoing.writeHead(500);outgoing.end('Practice could not complete the request.');}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'The practice app is already running or its port is occupied.':'The local practice app could not start.');process.exitCode=1;});
server.listen(43877,'127.0.0.1',()=>console.log('Quiz Practice ready: http://127.0.0.1:43877/'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit()));
