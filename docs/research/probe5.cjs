const { spawn } = require('child_process');
const WebSocket = require('D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/ws');
const fs=require('fs'),path=require('path'),os=require('os');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9338; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PROFILE=path.join(os.tmpdir(),'cdp5-'+Date.now());
const HTML = [
  '<style>body{margin:0}',
  '#btn{position:absolute;left:100px;top:200px;width:200px;height:60px;background:#4ade80}',
  '#overlay{position:absolute;left:0;top:0;width:100%;height:100%;background:rgba(255,0,0,.01);z-index:99}',
  '</style>',
  '<button id="btn">REAL BUTTON</button><div id="overlay"></div>',
  '<script>',
  'window.__t=[];',
  "['mousedown','mouseup','click'].forEach(function(t){document.addEventListener(t,function(e){window.__t.push({t:t,trusted:e.isTrusted,x:e.clientX,y:e.clientY,id:e.target&&e.target.id});},true);});",
  '</script>'
].join('');
async function main(){
  const child=spawn(EDGE,['--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
  let ver=null;
  for(let i=0;i<60;i++){try{ver=await (await fetch('http://127.0.0.1:'+PORT+'/json/version')).json();break;}catch{await sleep(250);}}
  if(!ver){console.log('START_FAIL');child.kill();return;}
  const mk=async u=>(await (await fetch('http://127.0.0.1:'+PORT+'/json/new?'+encodeURIComponent(u),{method:'PUT'})).json());
  const tA=await mk('data:text/html,<h1>A</h1>');
  const tB=await mk('data:text/html,'+encodeURIComponent(HTML));
  await sleep(1000);
  const connect=u=>new Promise((res,rej)=>{const s=new WebSocket(u,{perMessageDeflate:false});s.on('open',()=>res(s));s.on('error',rej);});
  const attach=s=>{const pend=new Map();let idc=0;
    s.on('message',d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}});
    return (method,params={})=>new Promise((res,rej)=>{const id=++idc;pend.set(id,{res,rej});s.send(JSON.stringify({id,method,params}));});};
  const sB=await connect(tB.webSocketDebuggerUrl); const sendB=attach(sB);
  const sBr=await connect(ver.webSocketDebuggerUrl); const sendBr=attach(sBr);
  await sendB('Runtime.enable');
  const evB=async e=>{const r=await sendB('Runtime.evaluate',{expression:e,returnByValue:true});return r.exceptionDetails?{ERR:r.exceptionDetails.text}:r.result.value;};
  const out={};
  await sendBr('Target.activateTarget',{targetId:tA.id});
  await sleep(800);
  out.geom=await evB("JSON.stringify({iw:innerWidth,ih:innerHeight,vis:document.visibilityState,hasFocus:document.hasFocus()})");
  const box=JSON.parse(await evB("(()=>{const r=document.getElementById('btn').getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()"));
  out.box=box;
  const fire=async(x,y)=>{await sendB('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await sendB('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
    await sendB('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});};
  await fire(box.x,box.y);
  await sleep(500);
  out.events=await evB("JSON.stringify(window.__t)");
  out.hitAtPoint=await evB("(document.elementFromPoint("+box.x+","+box.y+")||{}).id");
  console.log(JSON.stringify(out,null,2));
  try{sB.close();sBr.close();}catch{}
  child.kill();await sleep(500);
  try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch{}
}
main().catch(e=>{console.log('FATAL',e.message);});