const { spawn } = require('child_process');
const http = require('http');
const fs=require('fs'),path=require('path'),os=require('os');
const WebSocket = require('D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/ws');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9340; const WEBPORT=4999; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PROFILE=path.join(os.tmpdir(),'cdp7-'+Date.now());
const EXT='D:/VibeCoding/project/dsh-plugin/dsh-browser-control/.research/mvext';
const HTML='<button id="b">GO</button> target page';
http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(HTML);}).listen(WEBPORT);
async function main(){
  const child=spawn(EDGE,['--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,
    '--no-first-run','--no-default-browser-check','--disable-extensions-except='+EXT,'--load-extension='+EXT,
    '--window-position=200,200','about:blank'],{stdio:'ignore'});
  let ver=null;
  for(let i=0;i<80;i++){try{ver=await (await fetch('http://127.0.0.1:'+PORT+'/json/version')).json();break;}catch{await sleep(300);}}
  if(!ver){console.log('START_FAIL');child.kill();process.exit(1);}
  const mk=async u=>(await (await fetch('http://127.0.0.1:'+PORT+'/json/new?'+encodeURIComponent(u),{method:'PUT'})).json());
  const tA=await mk('data:text/html,<h1>USER TAB</h1>');
  const tB=await mk('http://127.0.0.1:'+WEBPORT+'/');
  await sleep(1500);
  // 找到扩展的 service worker
  let sw=null;
  for(let i=0;i<40;i++){
    const list=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();
    sw=list.find(t=>t.type==='service_worker'&&/\/sw\.js$/.test(t.url));
    if(sw)break; await sleep(400);
  }
  if(!sw){console.log('NO_SW'); const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json(); console.log(JSON.stringify(l.map(t=>t.type+' '+t.url).slice(0,12),null,1)); child.kill();process.exit(1);}
  const connect=u=>new Promise((res,rej)=>{const s=new WebSocket(u,{perMessageDeflate:false});s.on('open',()=>res(s));s.on('error',rej);});
  const attach=s=>{const pend=new Map();let idc=0;
    s.on('message',d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}});
    return (method,params={})=>new Promise((res,rej)=>{const id=++idc;pend.set(id,{res,rej});s.send(JSON.stringify({id,method,params}));});};
  const sSw=await connect(sw.webSocketDebuggerUrl); const sendSw=attach(sSw);
  const sBr=await connect(ver.webSocketDebuggerUrl); const sendBr=attach(sBr);
  await sendSw('Runtime.enable');
  // 让 A 成为活动标签，B 成为后台
  await sendBr('Target.activateTarget',{targetId:tA.id});
  await sleep(900);
  const callRun = async (focusEmu) => {
    const expr = 'globalThis.__RUN(' + JSON.stringify({focusEmu:focusEmu}) + ')';
    const r = await sendSw('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    if (r.exceptionDetails) return {ERR:r.exceptionDetails.text};
    return r.result.value;
  };
  const out={};
  out.withoutFocusEmu = await callRun(false);
  out.withFocusEmu = await callRun(true);
  console.log('===RESULTS===');
  console.log(JSON.stringify(out,null,2));
  try{sSw.close();sBr.close();}catch{}
  child.kill(); await sleep(600);
  try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch{}
  process.exit(0);
}
main().catch(e=>{console.log('FATAL',e.message);process.exit(1);});