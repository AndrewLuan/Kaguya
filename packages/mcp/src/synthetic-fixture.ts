/**
 * 功能概述：为 MCP 集成测试提供独立 Node stdio/HTTP 合成服务源码，不接触真实账号或外部网络。
 * syntheticServerSource 写入测试临时目录后运行；日志精确记录启动、RPC 和副作用次数。
 * 参数控制协议、分页、断连、晚到、认证和 schema 变化；fs.watch 只用于测试 barrier 的显式释放。
 * 本文件无自动运行入口，生产 Server 不导入；测试在失败路径也回收其直接子进程及临时文件。
 */
export const syntheticServerSource = String.raw`
/** 合成 MCP 服务：stdin 或回环 HTTP；每次请求在 journal 记录独立 rpcId。 */
import {readFileSync,appendFileSync,watch} from 'node:fs';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const [mode,statePath,journalPath]=process.argv.slice(2);
let lastState={};
const state=()=>{try{lastState=JSON.parse(readFileSync(statePath,'utf8'));}catch{}return lastState;};
const log=value=>appendFileSync(journalPath,JSON.stringify(value)+'\n');
log({kind:'start',pid:process.pid});
const held=[];
let notified=false;
let unknownReplied=false;
const watcher=watch(statePath,()=>{if(mode==='stdio'&&state().unknownReply&&!unknownReplied){unknownReplied=true;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:999999,result:{content:[]}})+'\n');}if(mode==='stdio'&&state().notify&&!notified){notified=true;process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\n');log({kind:'notification'});}if(state().release)for(const release of held.splice(0))release();});
function tool(name){return {name,description:'synthetic '+name,inputSchema:{type:'object',properties:{value:{type:state().schemaType||'number'}},required:['value'],additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true}};}
async function handle(request,reply,drop){
  const current=state();log({kind:'request',rpcId:request.id??null,method:request.method,params:request.params});
  if(request.id===undefined)return;
  const complete=result=>reply({jsonrpc:'2.0',id:request.id,result:current.protocol==='2026-07-28'&&request.method!=='server/discover'?{resultType:'complete',ttlMs:0,cacheScope:'private',...result}:result});
  if(request.method==='server/discover'){reply({jsonrpc:'2.0',id:request.id,result:{supportedVersions:[current.protocol],capabilities:current.unsupported?{}:{tools:{listChanged:true},resources:{},prompts:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'synthetic',version:'1'}}}});return;}
  if(request.method==='initialize'){complete({protocolVersion:current.protocol,capabilities:current.unsupported?{}:{tools:{listChanged:true},resources:{},prompts:{}},serverInfo:{name:'synthetic',version:'1'}});return;}
  if(request.method==='tools/list'){
    if(current.holdList&&!current.release)await new Promise(resolve=>held.push(resolve));
    const cursor=request.params?.cursor;
    complete({tools:[tool(cursor?'increment':'echo')],...((!cursor||current.loopPages)?{nextCursor:current.loopPages?'repeat':'second'}:{})});return;
  }
  if(request.method==='tools/call'){
    log({kind:'effect',operation:request.params.name});
    if(current.worker){const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(worker,'spawn');log({kind:'worker',pid:worker.pid});}
    if(current.exit){process.exit(0);return;}
    if(current.drop){drop();return;}
    if(current.headerMismatch){reply({jsonrpc:'2.0',id:request.id,error:{code:-32020,message:'mismatch'}});return;}
    if(current.inputRequired){reply({jsonrpc:'2.0',id:request.id,result:{resultType:'input_required',inputRequests:{},requestState:'opaque'}});return;}
    if(current.hold&&!current.release)await new Promise(resolve=>held.push(resolve));
    complete({content:[{type:'text',text:current.echoSecret?process.env.SYNTHETIC_SECRET:JSON.stringify(request.params.arguments)}],isError:!!current.isError});log({kind:'returned'});return;
  }
  if(request.method==='resources/list'){complete({resources:[{name:'test',uri:'fixture://allowed/item',mimeType:'text/plain'}]});return;}
  if(request.method==='resources/templates/list'){complete({resourceTemplates:[{name:'template',uriTemplate:'fixture://allowed/{id}'}]});return;}
  if(request.method==='resources/read'){complete({contents:[{uri:current.escapeResource?'fixture://denied/item':request.params.uri,mimeType:'text/plain',text:'untrusted resource'}]});return;}
  if(request.method==='prompts/list'){complete({prompts:[{name:'summarize',arguments:[{name:'topic',required:true}]}]});return;}
  if(request.method==='prompts/get'){complete({messages:[{role:'user',content:{type:'text',text:'untrusted prompt '+request.params.arguments.topic}}]});return;}
  reply({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unsupported'}});
}
if(mode==='stdio'){
  const reader=createInterface({input:process.stdin});
  reader.on('line',line=>{void handle(JSON.parse(line),value=>process.stdout.write(JSON.stringify(value)+'\n'),()=>process.exit(0));});
  reader.on('close',()=>process.exit(0));
}else{
  const server=createServer(async(req,res)=>{
    log({kind:'http',method:req.method,authorization:req.headers.authorization||null,session:req.headers['mcp-session-id']||null});
    if(state().auth&&req.headers.authorization!=='Bearer synthetic-token'){res.writeHead(401).end();return;}
    if(req.method==='DELETE'){res.writeHead(200).end();return;}
    if(req.method!=='POST'){res.writeHead(405).end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const request=JSON.parse(Buffer.concat(chunks).toString());
    res.on('close',()=>log({kind:'network-close',method:request.method}));
    if(request.id===undefined){res.writeHead(202).end();void handle(request,()=>{},()=>{});return;}
    await handle(request,value=>{
      if(state().sse){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify(value)+'\n\n');}
      else {res.writeHead(200,{'content-type':'application/json',...(request.method==='initialize'?{'mcp-session-id':'synthetic-session'}:{})});res.end(JSON.stringify(value));}
    },()=>res.destroy());
  });
  server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\n'));
}
`;
