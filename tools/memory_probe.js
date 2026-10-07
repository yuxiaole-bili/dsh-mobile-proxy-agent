// 内存实测：加载 -> 进会话 -> 75 秒持续操作（切标签/开关抽屉/开覆盖层）-> 看堆与 DOM 增长
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9277;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-mem-"));
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--js-flags=--expose-gc",
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

const SAMPLE = `(()=>{
  var m = performance.memory || {};
  return JSON.stringify({
    heapMB: m.usedJSHeapSize ? +(m.usedJSHeapSize/1048576).toFixed(2) : null,
    totalMB: m.totalJSHeapSize ? +(m.totalJSHeapSize/1048576).toFixed(2) : null,
    dom: document.querySelectorAll('*').length,
    hotErr: (window.__dshHotErrors||[]).length,
    uixErr: (window.__dshUix && window.__dshUix.state().errors.length) || 0,
    toggles: document.querySelectorAll('[data-dsh-uix]').length,
    listeners: 0
  });})()`;

(async () => {
  let targets = null;
  for (let i = 0; i < 40; i++) { try { targets = await getJson("/json/list"); if (targets && targets.length) break; } catch (e) {} await sleep(500); }
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); } };
  await new Promise((r) => { ws.onopen = r; });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setUserAgentOverride", { userAgent: UA });
  await send("Page.navigate", { url: BASE });
  await sleep(16000);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
    return r && r.result ? r.result.value : null;
  };
  const sample = async () => { const v = await ev(SAMPLE); try { return JSON.parse(v); } catch (e) { return { raw: v }; } };

  // 进会话
  await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
  await sleep(1400);
  for (let i = 0; i < 6; i += 1) {
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${i}]){r[${i}].click();return true;}return false;})()`);
    await sleep(8000);
    if (await ev(`(document.body.innerText||'').length>900`)) break;
    await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(900);
  }
  await sleep(3000);
  if (await ev(`!!window.gc`)) { await ev(`window.gc()`); await sleep(500); }
  const s0 = await sample();
  out("基线: " + JSON.stringify(s0));

  // 75 秒持续操作：每 3 秒做一次（切标签 / 开关抽屉 / 开关节流条折叠）
  const ACT = `(async()=>{
    var acts=[];
    function clickSafe(){
      var cands=[].slice.call(document.querySelectorAll('[class*="tab"],[class*="headerUtilities"] button,[data-dsh-uix]'))
        .filter(function(b){var r=b.getBoundingClientRect();return r.width>8&&r.height>8&&r.top<200;});
      if(cands.length){var b=cands[Math.floor(Math.random()*cands.length)];b.click();acts.push('t');}
    }
    function toggleDrawer(){ try{ window.__dshGestures && (window.__dshGestures.state&&window.__dshGestures.state().open ? window.__dshGestures.close() : window.__dshGestures.open()); acts.push('d'); }catch(e){} }
    function toggleUsage(){ var b=document.querySelector('[data-dsh-uix="usage-toggle"]'); if(b){b.click();acts.push('u');} }
    for(var i=0;i<25;i++){
      if(i%3===0) toggleUsage(); else if(i%3===1) clickSafe(); else toggleDrawer();
      await new Promise(function(r){setTimeout(r,3000);});
    }
    return acts.length;})()`;
  const acts = await ev(ACT);
  await sleep(2500);
  if (await ev(`!!window.gc`)) { await ev(`window.gc()`); await sleep(800); }
  const s1 = await sample();
  out("75s 操作 %d 次后: %s".replace("%s", JSON.stringify(s1)).replace("%d", String(acts)));

  const grow = (s1.heapMB != null && s0.heapMB != null) ? +(s1.heapMB - s0.heapMB).toFixed(2) : null;
  out("堆增长: " + grow + " MB     DOM 增长: " + (s1.dom - s0.dom) + " 节点");
  out("热补丁错误数组: " + s0.hotErr + " -> " + s1.hotErr + "（应 ≤60）");
  out("注：无 --expose-gc 时数值含未回收垃圾，趋势比绝对值重要");

  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
