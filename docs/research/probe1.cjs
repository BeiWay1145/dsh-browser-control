
// 独立 CDP 实验台：启动一个隔离的 Edge 实例，跑后台标签鼠标派发实验
const { spawn } = require('child_process');
const WebSocket = require('D:/VibeCoding/DSH_Desktop/DSH Desktop/resources/app/node_modules/ws');
const fs = require('fs'), path = require('path'), os = require('os');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = path.join(os.tmpdir(), 'cdp-probe-' + Date.now());
const PORT = 9333;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check',
    '--headless=new',            // 先测 headless（无窗口，天然"无前台"）
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  // 等 DevTools 端口就绪
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      ver = await r.json(); break;
    } catch { await sleep(250); }
  }
  if (!ver) { console.log('EDGE_START_FAIL'); child.kill(); return; }
  console.log('Browser:', ver.Browser);

  // 建两个标签：A 保持前台，B 作为后台
  const mk = async (url) => (await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json());
  const tA = await mk('data:text/html,<h1>FOREGROUND</h1>');
  const tB = await mk('data:text/html,<h1 id=h>BACKGROUND</h1><button id=b>GO</button>');
  await sleep(500);

  // 让 A 成为活动标签
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  console.log('Tabs:', list.map(t => t.id.slice(0,8) + ' ' + t.type).join(' | '));

  const connect = (wsUrl) => new Promise((res, rej) => {
    const s = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256*1024*1024 });
    s.on('open', () => res(s)); s.on('error', rej);
  });
  let idc = 0; const pend = new Map();
  const mkSend = (s) => (method, params={}) => new Promise((res, rej) => {
    const id = ++idc; pend.set(id, {res, rej});
    s.send(JSON.stringify({id, method, params}));
  });
  const attach = async (s) => {
    s.on('message', d => {
      const m = JSON.parse(d);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.rej(new Error(m.method + ' ' + JSON.stringify(m.error))) : p.res(m.result); }
    });
    return mkSend(s);
  };

  // 连到 B
  const sB = await connect(tB.webSocketDebuggerUrl);
  const sendB = await attach(sB);
  await sendB('Runtime.enable'); await sendB('Page.enable');

  const evB = async (expr) => {
    const r = await sendB('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
    if (r.exceptionDetails) return { ERR: r.exceptionDetails.text };
    return r.result.value;
  };

  const results = {};

  // 安装事件记录器
  await evB("(()=>{window.__t=[];['mousedown','mouseup','click'].forEach(t=>document.addEventListener(t,e=>window.__t.push({t,trusted:e.isTrusted,x:e.clientX,y:e.clientY,tag:e.target&&e.target.tagName,id:e.target&&e.target.id}),true));return 'ok'})()");

  results.geometry = await evB("JSON.stringify({iw:innerWidth,ih:innerHeight,vis:document.visibilityState,hasFocus:document.hasFocus()})");

  // === 实验 1：无焦点仿真，直接 dispatchMouseEvent ===
  const fire = async (x, y) => {
    await sendB('Input.dispatchMouseEvent', {type:'mouseMoved', x, y});
    await sendB('Input.dispatchMouseEvent', {type:'mousePressed', x, y, button:'left', buttons:1, clickCount:1});
    await sendB('Input.dispatchMouseEvent', {type:'mouseReleased', x, y, button:'left', buttons:0, clickCount:1});
  };
  const btn = JSON.parse(await evB("(()=>{const r=document.getElementById('b').getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()"));

  try { await fire(btn.x, btn.y); results.plainDispatch = 'sent'; }
  catch (e) { results.plainDispatch = 'ERR ' + e.message.slice(0,120); }
  await sleep(300);
  results.afterPlain = await evB("JSON.stringify(window.__t)");
  results.afterPlain_state = await evB("JSON.stringify({active:document.activeElement&&document.activeElement.id, vis:document.visibilityState, focus:document.hasFocus()})");

  // === 实验 2：开启 setFocusEmulationEnabled 后再派发 ===
  await evB("(window.__t=[],1)");
  try { await sendB('Emulation.setFocusEmulationEnabled', {enabled:true}); results.focusEmu = 'enabled'; }
  catch (e) { results.focusEmu = 'ERR ' + e.message.slice(0,120); }
  await sleep(200);
  results.afterFocusEmu_state = await evB("JSON.stringify({vis:document.visibilityState, focus:document.hasFocus()})");
  try { await fire(btn.x, btn.y); results.emulatedDispatch = 'sent'; }
  catch (e) { results.emulatedDispatch = 'ERR ' + e.message.slice(0,120); }
  await sleep(300);
  results.afterEmulated = await evB("JSON.stringify(window.__t)");

  console.log('===RESULTS===');
  console.log(JSON.stringify(results, null, 2));

  try { sB.close(); } catch {}
  child.kill();
  await sleep(500);
  try { fs.rmSync(PROFILE, {recursive:true, force:true}); } catch {}
}
main().catch(e => { console.log('FATAL', e.message); process.exit(1); });
