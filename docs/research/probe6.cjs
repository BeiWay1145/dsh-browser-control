const { spawn } = require('child_process');
const WebSocket = require('D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/ws');
const fs=require('fs'),path=require('path'),os=require('os');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9339; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PROFILE=path.join(os.tmpdir(),'cdp6-'+Date.now());
const HTML = '<button id="b">GO</button><input id="i"><script>window.__t=[];["mousedown","click"].forEach(function(t){document.addEventListener(t,function(e){window.__t.push({t:t,trusted:e.isTrusted,id:e.target&&e.target.id});},true);});</script>';
async function main(){
  const child=spawn(EDGE,['--remote-debugging-port='+PORT,'--user-data-dir='+PROFILE,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
  let ver=null;
  for(let i=0;i<60;i++){try{ver=await (await fetch('http://127.0.0.1:'+PORT+'/json/version')).json();break;}catch{await sleep(250);}}
  if(!ver){console.log('START_FAIL');child.kill();return;}
  const mk=async u=>(await (await fetch('http://127.0.0.1:'+PORT+'/json/new?'+encodeURIComponent(u),{method:'PUT'})).json());
  const tA=await mk('data:text/html,<h1>A</h1>');
  const tB=await mk('data:text/html,'+encodeURIComponent(HTML));
  await sleep(900);
  const connect=u=>new Promise((res,rej)=>{const s=new WebSocket(u,{perMessageDeflate:false});s.on('open',()=>res(s));s.on('error',rej);});
  const attach=s=>{const pend=new Map();let idc=0;
    s.on('message',d=>{const m=JSON.parse(d);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}});
    return (method,params={})=>new Promise((res,rej)=>{const id=++idc;pend.set(id,{res,rej});s.send(JSON.stringify({id,method,params}));});};
  const sB=await connect(tB.webSocketDebuggerUrl); const sendB=attach(sB);
  const sBr=await connect(ver.webSocketDebuggerUrl); const sendBr=attach(sBr);
  await sendB('Runtime.enable');
  const out={};
  await sendBr('Target.activateTarget',{targetId:tA.id});
  await sleep(700);
  out.geom=await sendB('Runtime.evaluate',{expression:"JSON.stringify({vis:document.visibilityState,hasFocus:document.hasFocus()})",returnByValue:true}).then(r=>r.result.value);
  const withGesture = await sendB('Runtime.evaluate',{expression:"(()=>{window.__synth=[];const b=document.getElementById('b');const h=e=>window.__synth.push({trusted:e.isTrusted,tag:e.target.tagName});b.addEventListener('click',h,true);b.click();return JSON.stringify(window.__synth)})()",returnByValue:true,userGesture:true});
  out.syntheticClick_userGestureTrue = withGesture.result.value;
  const noGesture = await sendB('Runtime.evaluate',{expression:"(()=>{window.__s2=[];const b=document.getElementById('b');const h=e=>window.__s2.push({trusted:e.isTrusted});b.addEventListener('click',h,true);b.click();return JSON.stringify(window.__s2)})()",returnByValue:true,userGesture:false});
  out.syntheticClick_userGestureFalse = noGesture.result.value;
  out.navigator_userActivation_before = await sendB('Runtime.evaluate',{expression:"navigator.userActivation.isActive",returnByValue:true}).then(r=>r.result.value);
  const ua = await sendB('Runtime.evaluate',{expression:"navigator.userActivation.isActive",returnByValue:true,userGesture:true});
  out.navigator_userActivation_withGesture = ua.result.value;
  await sendB('Input.dispatchMouseEvent',{type:'mousePressed',x:10,y:10,button:'left',buttons:1,clickCount:1});
  await sendB('Input.dispatchMouseEvent',{type:'mouseReleased',x:10,y:10,button:'left',buttons:0,clickCount:1});
  await sleep(200);
  out.navigator_userActivation_afterRealMouse = await sendB('Runtime.evaluate',{expression:"navigator.userActivation.isActive",returnByValue:true}).then(r=>r.result.value);
  console.log(JSON.stringify(out,null,2));
  try{sB.close();sBr.close();}catch{}
  child.kill();await sleep(500);
  try{fs.rmSync(PROFILE,{recursive:true,force:true});}catch{}
}
main().catch(e=>{console.log('FATAL',e.message);});