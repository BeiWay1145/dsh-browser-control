
const { spawn } = require('child_process');
const WebSocket = require('D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/ws');
const fs=require('fs'),path=require('path'),os=require('os');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function run(label, PORT, extraArgs, minimize){
  const PROFILE=path.join(os.tmpdir(),'cdp4-'+PORT+'-'+Date.now());
  const child=spawn(EDGE,['--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,
    '--no-first-run','--no-default-browser-check','--window-position=100,100',...extraArgs,'about:blank'],{stdio:'ignore'});
  let ver=null;
  for(let i=0;i<60;i++){try{ver=await (await fetch('http://127.0.0.1:'+PORT+'/json/version')).json();break;}catch{await sleep(250);}}
  if(!ver){child.kill();return {label,ERR:'START_FAIL'};}
  const mk=async u=>(await (await fetch('http://127.0.0.1:'+PORT+'/json/new?'+encodeURIComponent(u),{method:'PUT'})).json());
  const tA=await mk('data:text/html,<h1>A</h1>');
  const tB=await mk('data:text/html,<h1>B</h1><button id=b>GO</button>');
  await sleep(800);
  const connect=u=>new Promise((res,rej)=>{const s=new WebSocket(u,{perMessageDeflate:false});s.on('open',()=>res(s));s.on('error',rej);});
  const attach=s=>{const pend=new Map();let idc=0;
    s.on('message',d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}});
    return (method,params={})=>new Promise((res,rej)=>{const id=++idc;pend.set(id,{res,rej});s.send(JSON.stringify({id,method,params}));});};
  const sB=await connect(tB.webSocketDebuggerUrl); const sendB=attach(sB);
  const sBr=await connect(ver.webSocketDebuggerUrl); const sendBr=attach(sBr);
  await sendB('Runtime.enable');
  const evB=async e=>{const r=await sendB('Runtime.evaluate',{expression:e,returnByValue:true});return r.exceptionDetails?{ERR:r.exceptionDetails.text}:r.result.value;};
  const out={label};
  await evB("(()=>{window.__t=[];['mousedown','click'].forEach(t=>document.addEventListener(t,e=>window.__t.push({t,trusted:e.isTrusted,x:e.clientX,y:e.clientY,id:e.target&&e.target.id}),true));return 'ok'})()");
  await sendBr('Target.activateTarget',{targetId:tA.id});
  await sleep(700);

  if(minimize){
    try{
      const {windowId}=await sendBr('Browser.getWindowForTarget',{targetId:tA.id});
      await sendBr('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
      out.minimized='ok'; await sleep(1200);
    }catch(e){out.minimized='ERR '+e.message.slice(0,120);}
  }
  out.geom=await evB("JSON.stringify({iw:innerWidth,ih:innerHeight,vis:document.visibilityState,hasFocus:document.hasFocus()})");
  const btn=JSON.parse(await evB("(()=>{const r=document.getElementById('b').getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()"));
  const fire=async(x,y)=>{await sendB('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await sendB('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
    await sendB('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});};
  try{await fire(btn.x,btn.y);out.fire='sent';}catch(e){out.fire='ERR '+e.message.slice(0,150);}
  await sleep(500);
  out.events=await evB("JSON.stringify(window.__t)");
  try{sB.close();sBr.close();}catch{}
  child.kill();await sleep(600);
  try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch{}
  return out;
}

(async()=>{
  const normal = await run('headed-正常', 9336, [], false);
  console.log(JSON.stringify(normal,null,2));
  const min = await run('headed-窗口最小化', 9337, [], true);
  console.log(JSON.stringify(min,null,2));
})();
