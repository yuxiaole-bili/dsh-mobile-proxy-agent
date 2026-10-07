// 在 PC 上复现"文件资源服务不可用"：打开含指定文件名的会话，点文件 chip，读预览面板文字。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9252;
const BASE = process.argv[2];
const OUT = process.argv[3];
const NEEDLE = process.argv[4] || "t54_ortho3b";
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-repro-"));
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=360,780", "about:blank"], { stdio: "ignore" });

const lines = [];
const out = (s) => { console.log(s); lines.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
    let d = ""; r.on("data", (c) => d += c);
    r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

(async () => {
  let targets = null;
  for (let i = 0; i < 40; i++) { try { targets = await getJson("/json/list"); if (targets && targets.length) break; } catch (e) {} await sleep(500); }
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const reqs = []; const errs = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") {
      const u = m.params.request.url;
      if (u.indexOf("/favicon") < 0 && u.indexOf("alert-chime") < 0 && u.indexOf("/__health") < 0) reqs.push(m.params.request.method + " " + u.slice(0, 90));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 150));
    if (m.method === "Runtime.exceptionThrown") errs.push("EXC " + String((m.params.exceptionDetails.exception || {}).description || "").slice(0, 150));
  };
  await new Promise((r) => { ws.onopen = r; });
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setUserAgentOverride", { userAgent: UA });
  await send("Page.navigate", { url: BASE });
  await sleep(15000);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
    return r && r.result ? r.result.value : null;
  };
  const js = async (expr) => { const v = await ev(expr); try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return { __raw: v }; } };

  // 找出含目标文件的会话
  let found = -1;
  for (let idx = 0; idx < 6; idx += 1) {
    await ev(`(()=>{try{window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(600);
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${idx}]){r[${idx}].click();return true;}return false;})()`);
    await sleep(8500);
    const has = await ev(`(document.body.innerText||'').indexOf(${JSON.stringify(NEEDLE)})>=0`);
    out("会话#" + idx + " 含目标: " + has);
    if (has === true) { found = idx; break; }
  }
  if (found < 0) { out("!! 没找到含 " + NEEDLE + " 的会话"); }
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  if (found < 0) { edge.kill(); process.exit(1); }

  out("== 会话内所有文件名 chip ==");
  out("  " + JSON.stringify(await js(`(()=>{var b=document.querySelectorAll('button[class*="_fileMention"],button[class*="_fileLink"]'),o=[];
    for(var i=0;i<b.length&&o.length<10;i++){o.push({t:(b[i].textContent||'').trim().slice(0,34),title:b[i].getAttribute('title')});}
    return JSON.stringify(o);})()`)));

  reqs.length = 0;
  const clicked = await ev(`(()=>{
    var b=document.querySelectorAll('button[class*="_fileMention"],button[class*="_fileLink"]');
    for(var i=0;i<b.length;i++){var t=(b[i].textContent||'');if(t.indexOf(${JSON.stringify(NEEDLE)})>=0){b[i].click();return t.trim().slice(0,34);}}
    if(b.length){b[0].click();return 'fallback:'+(b[0].textContent||'').trim().slice(0,30);}
    return null;})()`);
  out("== 点击: " + JSON.stringify(clicked) + " ==");
  await sleep(4500);
  out("  请求: " + JSON.stringify(reqs.slice(0, 10)));
  out("== 预览面板内容 ==");
  out("  " + JSON.stringify(await js(`(()=>{
    var f=document.querySelector('[class*="frame"]'),rb=null,k=f?f.children:[];
    for(var i=0;i<k.length;i++){if(String(k[i].className).indexOf('rightbarCol')>=0)rb=k[i];}
    var txt=rb?(rb.innerText||'').replace(/\\s+/g,' ').slice(0,260):null;
    var img=document.querySelector('img[src^="blob:"]');
    var r=img?img.getBoundingClientRect():null;
    return JSON.stringify({panelText:txt,blobImg:r?{x:Math.round(r.left),w:Math.round(r.width)}:null,
      flag:document.documentElement.getAttribute('data-dsh-rb')});})()`)));
  out("  控制台错误: " + JSON.stringify(errs.slice(0, 4)));

  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => {
  out("ERR " + (e && e.stack || e));
  if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} }
  try { edge.kill(); } catch (_) {}
  process.exit(1);
});
