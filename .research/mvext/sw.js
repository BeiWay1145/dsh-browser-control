// 最小验证：chrome.debugger 在【后台标签】上发坐标点击，观察 isTrusted
let LOG = [];
function dbg(tabId, method, params){ return new Promise((res,rej)=>{
  chrome.debugger.sendCommand({tabId}, method, params||{}, (r)=>{
    if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message)); else res(r); }); }); }
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function run(opts){
  const tabs = await chrome.tabs.query({});
  const bg = tabs.find(t => t.url && t.url.startsWith('http://127.0.0.1:4999/'));
  if (!bg) return { error: 'bg tab not found', tabs: tabs.map(t=>t.url).slice(0,10) };
  const active = tabs.find(t=>t.active);
  const out = { bgTabId: bg.id, bgActiveBefore: bg.active, activeUrl: active && active.url, steps: {} };
  await chrome.debugger.attach({tabId: bg.id}, '1.3');
  try {
    await dbg(bg.id,'Runtime.enable');
    // 安装监听器
    await dbg(bg.id,'Runtime.evaluate',{expression:"(()=>{window.__t=[];['mousedown','mouseup','click'].forEach(function(t){document.addEventListener(t,function(e){window.__t.push({t:t,trusted:e.isTrusted,x:e.clientX,y:e.clientY,id:e.target&&e.target.id});},true);});return 'ok'})()",returnByValue:true});
    const g = await dbg(bg.id,'Runtime.evaluate',{expression:"JSON.stringify({iw:innerWidth,ih:innerHeight,vis:document.visibilityState,hasFocus:document.hasFocus()})",returnByValue:true});
    out.steps.geom = g.result.value;
    const b = await dbg(bg.id,'Runtime.evaluate',{expression:"(()=>{const r=document.getElementById('b').getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()",returnByValue:true});
    const box = JSON.parse(b.result.value);
    if (opts.focusEmu) { await dbg(bg.id,'Emulation.setFocusEmulationEnabled',{enabled:true}); out.steps.focusEmu='enabled'; await sleep(200); }
    await dbg(bg.id,'Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x,y:box.y});
    await dbg(bg.id,'Input.dispatchMouseEvent',{type:'mousePressed',x:box.x,y:box.y,button:'left',buttons:1,clickCount:1});
    await dbg(bg.id,'Input.dispatchMouseEvent',{type:'mouseReleased',x:box.x,y:box.y,button:'left',buttons:0,clickCount:1});
    await sleep(400);
    const ev = await dbg(bg.id,'Runtime.evaluate',{expression:'JSON.stringify(window.__t)',returnByValue:true});
    out.steps.events = ev.result.value;
    const tabsAfter = await chrome.tabs.query({});
    out.bgActiveAfter = tabsAfter.find(t=>t.id===bg.id).active;
    out.activeAfter = (tabsAfter.find(t=>t.active)||{}).url;
    if (opts.focusEmu) await dbg(bg.id,'Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});
  } finally { await chrome.debugger.detach({tabId: bg.id}).catch(()=>{}); }
  return out;
}
chrome.runtime.onMessage.addListener((m, s, send) => { run(m||{}).then(r=>send(r)).catch(e=>send({error:String(e)})); return true; });
chrome.runtime.onInstalled.addListener(()=>{});
globalThis.__RUN = run;