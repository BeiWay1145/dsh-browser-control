// 错误契约实测：分类是否正确、写操作是否被标成「结果未知」、HTTP 面是否把
// code / effectState / hint 一起回给调用方。
import net from "node:net";
import { classify, BridgeError, isWriteCommand } from "../src/errors.ts";
import { BridgeServer } from "../src/server.ts";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

// ---- 纯函数层：分类表 ----
const cases = [
  ["click", "browser command timed out after 60000ms: click", "command_timeout", "unknown"],
  ["screenshot", "browser command timed out after 60000ms: screenshot", "command_timeout", "not_started"],
  ["input", "the browser extension disconnected mid-command", "link_lost", "unknown"],
  ["read-cmd", "the browser extension disconnected mid-command", "link_lost", "not_started"],
  ["nav", "no browser extension connected — open the browser", "extension_offline", "not_started"],
  ["eval", "Runtime.evaluate failed: cannot access context", "command_failed", "unknown"],
  ["content", "content failed: no such element", "command_failed", "not_started"],
  ["click", "browser command cancelled: click", "cancelled", "not_started"],
  ["tabs.open", "browser-bridge stopped", "link_lost", "unknown"],
  ["click", "浏览器控制未启用 —— 在 profile 的 cordis.patch.yml 里配 enabled: true", "bridge_disabled", "not_started"],
  ["cleanup", "browser-bridge is not configured yet —— 尚未加载配置", "not_configured", "not_started"],
];
for (const [cmd, msg, code, effect] of cases) {
  const e = classify(cmd, new Error(msg));
  check(`classify(${cmd}) → ${code}/${effect}`, e.code === code && e.effectState === effect, `${e.code}/${e.effectState}｜${e.message.slice(0, 46)}`);
}

// hint 必须每条都有，且 message 带 [code] 前缀
const codes = new Set(cases.map((c) => c[2]));
for (const code of codes) {
  const sample = classify("click", new Error(cases.find((c) => c[2] === code)[1]));
  check(`code=${code} 有 hint 且 message 带前缀`, typeof sample.hint === "string" && sample.hint.length > 12 && sample.message.startsWith(`[${code}]`), sample.hint.slice(0, 40));
}

// 幂等：已经分类过的不再重复包裹
const once = classify("click", new Error("browser command timed out after 1ms: click"));
const twice = classify("click", once);
check("classify 幂等（不洗掉 code）", twice === once, twice === once ? "同一实例" : "被重新分类了");

// 读/写判定
check("click/input/nav 是写操作", isWriteCommand("click") && isWriteCommand("input") && isWriteCommand("nav"));
check("screenshot/find/content 是只读", !isWriteCommand("screenshot") && !isWriteCommand("find") && !isWriteCommand("content"));
check("BridgeError.toJSON 带三个字段", (() => {
  const j = once.toJSON();
  return j.ok === false && j.code === "command_timeout" && j.effectState === "unknown" && typeof j.hint === "string";
})(), JSON.stringify(once.toJSON()).slice(0, 120));

// ---- 集成层：真 BridgeServer + 不回话的假扩展 ----
const PORT = 9778;
const TOKEN = "err-test-token";
const server = new BridgeServer({ port: PORT, token: TOKEN, shotsDir: "dsh-browser-shots", log: () => {} });
await server.start();

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
let saw = [];
await new Promise((r) => {
  ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", client: "fake", version: "1", browser: { name: "f", version: "1", ua: "" } })); r(); };
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === "command") saw.push(m.command); /* 故意不回 result */ };
  setTimeout(r, 250);
});

const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

const write = await post({ command: "click", params: { selector: "button.submit" }, timeoutMs: 800 });
check("写操作超时 → HTTP 504", write.status === 504, `实际 ${write.status}`);
check("写操作超时 → effectState=unknown（不许盲目重试）", write.json.effectState === "unknown", JSON.stringify(write.json).slice(0, 100));
check("写操作超时 → code=command_timeout + hint", write.json.code === "command_timeout" && (write.json.hint || "").length > 10);

const read = await post({ command: "screenshot", params: {}, timeoutMs: 800 });
check("只读超时 → effectState=not_started（重试安全）", read.json.effectState === "not_started", JSON.stringify(read.json).slice(0, 100));

ws.close();
await new Promise((r) => setTimeout(r, 150));
const offline = await post({ command: "nav", params: { url: "https://example.com" }, timeoutMs: 800 });
check("扩展掉线后 → HTTP 503 + extension_offline", offline.status === 503 && offline.json.code === "extension_offline", JSON.stringify(offline.json).slice(0, 110));
check("前两条确实发到链路上；断线后不再下发（不是空转也不是乱发）",
  saw.includes("click") && saw.includes("screenshot") && !saw.includes("nav"), saw.join(","));

await server.stop();
console.log(`\n结论：${fails === 0 ? "错误契约全部通过" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
