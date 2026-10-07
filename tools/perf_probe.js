// 性能基线/复测：长任务、请求数、点击延迟、DOM 规模
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9268;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-perf-"));
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=360,780", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
    let d = ""; r.on("data", (c) => d += c);
    r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});
const lines = [];
const out = (s) => { console.log(s); lines.push(s); };

(async () => {
  let targets = null;
  for (let i = 0; i < 40; i++) { try { targets = await getJson("/json/list"); if (targets && targets.length) break; } catch (e) {} await sleep(500); }
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const reqs = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") {
      const u = m.params.request.url;
      if (u.indexOf("/favicon") < 0 && u.indexOf("alert-chime") < 0 && u.indexOf("/__diag") < 0 && u.indexOf("/__health") < 0) {
        reqs.push(u.replace(/[?&]k=[^&]*/, "").replace(/^http:\/\/[^/]+/, "").slice(0, 64));
      }
    }
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

  // 装长任务观察器
  await ev(`(()=>{window.__lt={n:0,total:0,max:0};
    try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__lt.n++;window.__lt.total+=e.duration;
      if(e.duration>window.__lt.max)window.__lt.max=e.duration;});}).observe({entryTypes:['longtask']});}catch(e){}
    window.__dom=document.querySelectorAll('*').length; return true;})()`);

  // 进会话
  await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
  await sleep(1400);
  let opened = false;
  for (let i = 0; i < 6 && !opened; i += 1) {
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${i}]){r[${i}].click();return true;}return false;})()`);
    await sleep(8000);
    if (await ev(`(document.body.innerText||'').length>900`)) opened = true;
    await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(900);
  }
  out("进入会话: " + opened);
  await sleep(3000);

  const domBefore = await ev(`document.querySelectorAll('*').length`);
  const reqBefore = reqs.length;

  // 静置 12 秒：看后台定时器/轮询造成的长任务
  await ev(`window.__lt={n:0,total:0,max:0}; true`);
  await sleep(12000);
  const idle = await js(`JSON.stringify({lt:window.__lt, dom:document.querySelectorAll('*').length, reqs:0})`);
  out("静置 12s: " + JSON.stringify(idle));

  // 连续点击 10 次（模拟"点多个控件"）：头部工具按钮 + 标签页
  reqs.length = 0;
  await ev(`window.__lt={n:0,total:0,max:0}; window.__tapStart=performance.now(); true`);
  const tapLog = await ev(`(async()=>{
    var out=[];
    function pick(){
      var cands=[].slice.call(document.querySelectorAll('[class*="headerUtilities"] button,[class*="tab"],[class*="toolbar"] button,button[aria-label]'));
      return cands.filter(function(b){var r=b.getBoundingClientRect();return r.width>8&&r.height>8&&r.top<200;});
    }
    var btns=pick();
    for(var i=0;i<10;i++){
      var b=btns[i%Math.max(1,btns.length)];
      if(!b) break;
      var t0=performance.now();
      b.click();
      await new Promise(function(r){setTimeout(r,260);});
      out.push({i:i,label:(b.getAttribute('aria-label')||b.textContent||'').trim().slice(0,12),ms:Math.round(performance.now()-t0)});
    }
    return JSON.stringify({taps:out, total:Math.round(performance.now()-window.__tapStart)});
  })()`);
  await sleep(2500);
  const tap = await js(`JSON.stringify({lt:window.__lt, dom:document.querySelectorAll('*').length})`);
  out("连点 10 次: " + String(tapLog));
  out("   期间长任务: " + JSON.stringify(tap));
  out("   期间请求数: " + reqs.length);
  const byCount = {};
  for (const r of reqs) { byCount[r] = (byCount[r] || 0) + 1; }
  const top = Object.entries(byCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
  out("   请求分布: " + JSON.stringify(top));
  out("DOM 节点数: " + domBefore + " -> " + (await ev(`document.querySelectorAll('*').length`)));

  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
