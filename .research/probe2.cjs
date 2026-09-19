
// v2: 真正把 B 变成后台标签（用 Target.activateTarget 把 A 拉前台，或直接关掉 B 的前台性）
const { spawn } = require('child_process');
const WebSocket = require('D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/ws');
const fs = require('fs'), path = require('path'), os = require('os');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = path.join(os.tmpdir(), 'cdp-probe2-' + Date.now());
const PORT = 9334;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, ['--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,
    '--no-first-run','--no-default-browser-check','--headless=new','about:blank'], {stdio:'ignore'});
  let ver=null;
  for (let i=0;i<60;i++){ try{ ver=await (await fetch('http://127.0.0.1:'+PORT+'/json/version')).json(); break;}catch{await sleep(250);} }
  if(!ver){console.log('START_FAIL');child.kill();return;}
  console.log('Browser:', ver.Browser);

  const mk = async (u) => (await (await fetch('http://127.0.0.1:'+PORT+'/json/new?'+encodeURIComponent(u),{method:'PUT'})).json());
  const tA = await mk('data:text/html,<h1>A</h1>');
  const tB = await mk('data:text/html,<h1 id=h>B</h1><button id=b>GO</button><input id=i>');
  await sleep(600);

  const connect = (u) => new Promise((res,rej)=>{const s=new WebSocket(u,{perMessageDeflate:false});s.on('open',()=>res(s));s.on('error',rej);});
  const attach = (s) => { const pend=new Map(); let idc=0;
    s.on('message', d=>{const m=JSON.parse(d); if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}});
    return (method,params={})=>new Promise((res,rej)=>{const id=++idc;pend.set(id,{res,rej});s.send(JSON.stringify({id,method,params}));});
  };

  // B 的连接 + 浏览器级连接
  const sB = await connect(tB.webSocketDebuggerUrl); const sendB = attach(sB);
  const sBr = await connect(ver.webSocketDebuggerUrl); const sendBr = attach(sBr);
  await sendB('Runtime.enable'); await sendB('Page.enable');

  const evB = async (e) => { const r = await sendB('Runtime.evaluate',{expression:e,returnByValue:true});
    return r.exceptionDetails ? {ERR:r.exceptionDetails.text} : r.result.value; };

  const out = {};
  await evB("(()=>{window.__t=[];['mousedown','mouseup','click','keydown'].forEach(t=>document.addEventListener(t,e=>window.__t.push({t,trusted:e.isTrusted,x:e.clientX,y:e.clientY,tag:e.target&&e.target.tagName,id:e.target&&e.target.id}),true));return 'ok'})()");

  // 把 A 激活，B 变后台
  await sendBr('Target.activateTarget', {targetId: tA.id});
  await sleep(700);
  out.beforeGeom = await evB("JSON.stringify({iw:innerWidth,ih:innerHeight,vis:document.visibilityState,hasFocus:document.hasFocus()})");

  const btn = JSON.parse(await evB("(()=>{const r=document.getElementById('b').getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()"));
  out.btn = btn;
  const fire = async (x,y)=>{ await sendB('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await sendB('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
    await sendB('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1}); };

  // 实验1：后台 + 无焦点仿真
  try{ await fire(btn.x,btn.y); out.step1='sent'; }catch(e){ out.step1='ERR '+e.message.slice(0,150); }
  await sleep(400);
  out.step1_events = await evB("JSON.stringify(window.__t)");

  // 实验2：后台 + setFocusEmulationEnabled
  await evB("(window.__t=[],1)");
  try{ await sendB('Emulation.setFocusEmulationEnabled',{enabled:true}); out.step2_emu='enabled'; }catch(e){ out.step2_emu='ERR '+e.message.slice(0,150); }
  await sleep(300);
  out.step2_geom = await evB("JSON.stringify({vis:document.visibilityState,hasFocus:document.hasFocus()})");
  try{ await fire(btn.x,btn.y); out.step2='sent'; }catch(e){ out.step2='ERR '+e.message.slice(0,150); }
  await sleep(400);
  out.step2_events = await evB("JSON.stringify(window.__t)");

  console.log('===RESULTS===');
  console.log(JSON.stringify(out,null,2));
  try{sB.close();sBr.close();}catch{}
  child.kill(); await sleep(500);
  try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch{}
}
main().catch(e=>{console.log('FATAL',e.message);process.exit(1);});
