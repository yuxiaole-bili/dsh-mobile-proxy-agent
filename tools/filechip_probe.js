// 抓"会话里的文件引用（如 t80_v14_cmp.png）"到底是什么元素、点下去会发什么请求。
// 用 CDP Network 域记录点击前后的全部请求。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9246;
const BASE = process.argv[2];
const OUT = process.argv[3];
const NEEDLE = process.argv[4] || "t80_v14_cmp";
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-chip-"));
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

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
  let id = 0; const pending = new Map(); const reqs = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") {
      const u = m.params.request.url;
      if (u.indexOf("/favicon") < 0 && u.indexOf("alert-chime") < 0) reqs.push(m.params.request.method + " " + u.slice(0, 120));
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

  // 打开会话：先在抽屉里按标题找，找不到就逐个试，直到正文里出现目标文件名
  out("== 挑选会话 ==");
  const rows = await js(`(()=>{try{window.__dshGestures.open();}catch(e){}
    var r=document.querySelectorAll('[class*="sessionRow"]');var o=[];
    for(var i=0;i<r.length;i++){o.push({i:i,t:(r[i].innerText||'').replace(/\\s+/g,' ').slice(0,24)});}
    return JSON.stringify(o);}catch(e){return JSON.stringify({err:String(e)});}})()`);
  out("  会话行: " + JSON.stringify(rows));
  await sleep(800);
  let hit = false;
  const order = Array.isArray(rows) ? rows.map((r) => r.i) : [0, 1, 2];
  const preferred = (Array.isArray(rows) ? rows.filter((r) => /主写手/.test(r.t)).map((r) => r.i) : []);
  const tryOrder = preferred.concat(order.filter((i) => preferred.indexOf(i) < 0));
  for (const idx of tryOrder.slice(0, 5)) {
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${idx}]){r[${idx}].click();return true;}return false;})()`);
    await sleep(9000);
    const has = await ev(`(document.body.innerText||'').indexOf(${JSON.stringify(NEEDLE)})>=0`);
    out("  行#" + idx + " -> 含目标文件名: " + has);
    if (has === true) { hit = true; break; }
    await ev(`(window.__dshGestures && window.__dshGestures.open())`);
    await sleep(700);
  }
  if (!hit) out("  !! 没找到含 '" + NEEDLE + "' 的会话，后面结果仅供参考");

  out("== 找含 '" + NEEDLE + "' 的最内层元素 ==");
  const found = await js(`(()=>{
    var all=document.querySelectorAll('*'),best=[];
    for(var i=0;i<all.length;i++){
      var e=all[i];
      if((e.textContent||'').indexOf(${JSON.stringify(NEEDLE)})<0) continue;
      var deeper=false;
      for(var j=0;j<e.children.length;j++){ if((e.children[j].textContent||'').indexOf(${JSON.stringify(NEEDLE)})>=0){deeper=true;break;} }
      if(deeper) continue;
      var chain=[],p=e,h=0;
      while(p&&h<4){chain.push({tag:p.tagName,cls:String(p.className||'').slice(0,30),
        href:p.getAttribute&&p.getAttribute('href'),role:p.getAttribute&&p.getAttribute('role'),
        txt:(p.textContent||'').replace(/\\s+/g,' ').trim().slice(0,20)});p=p.parentElement;h++;}
      best.push({html:e.outerHTML.slice(0,260),chain:chain});
      if(best.length>=3) break;
    }
    return JSON.stringify({n:best.length,items:best});
  })()`);
  out("  " + JSON.stringify(found).slice(0, 1400));

  out("== 点它，看发什么请求 ==");
  reqs.length = 0;
  const clicked = await ev(`(()=>{
    var all=document.querySelectorAll('*'),target=null;
    for(var i=0;i<all.length;i++){
      var e=all[i];
      if((e.textContent||'').indexOf(${JSON.stringify(NEEDLE)})<0) continue;
      var deeper=false;
      for(var j=0;j<e.children.length;j++){ if((e.children[j].textContent||'').indexOf(${JSON.stringify(NEEDLE)})>=0){deeper=true;break;} }
      if(deeper) continue;
      target=e; break;
    }
    if(!target) return null;
    var clickable = (target.closest && target.closest('a,button,[role="button"]')) || target;
    clickable.click();
    return clickable.tagName+' cls='+String(clickable.className||'').slice(0,40)+' href='+(clickable.getAttribute&&clickable.getAttribute('href'));
  })()`);
  out("  clicked: " + JSON.stringify(clicked));
  await sleep(3500);
  out("  点击后的请求:");
  for (const r of reqs.slice(0, 14)) out("    " + r);
  const after = await js(`JSON.stringify({
    overlay:(function(){var e=document.getElementById("dsh-fv");return e?e.style.display:null;})(),
    fvState:(window.__dshFileView?window.__dshFileView.state():null),
    hotErrs:(window.__dshHotErrors||[]).length
  })`);
  out("  页面状态: " + JSON.stringify(after));

  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => {
  out("ERR " + (e && e.stack || e));
  if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} }
  try { edge.kill(); } catch (_) {}
  process.exit(1);
});
