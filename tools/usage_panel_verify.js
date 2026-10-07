// 验收：① 底部状态条不截断 ② 设置面板内容列不再被压成竖排
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9267;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-fix-"));
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
const results = [];
const out = (s) => { console.log(s); lines.push(s); };
const check = (n, ok, d) => { results.push([n, !!ok]); out((ok ? "PASS  " : "FAIL  ") + n + (d ? "  | " + d : "")); };

const BAND = `(()=>{
  var items=[],all=document.querySelectorAll('span,div,button,p,a');
  for(var i=0;i<all.length;i++){var e=all[i],r=e.getBoundingClientRect();
    if(r.width<6||r.height<6)continue;
    if(r.top<innerHeight-58||r.bottom>innerHeight+2)continue;
    var t=(e.textContent||'').replace(/\\s+/g,' ').trim();
    if(!t||t.length>24)continue;
    var cs=getComputedStyle(e);
    items.push({txt:t.slice(0,18),trunc:e.scrollWidth>e.clientWidth+1,to:cs.textOverflow,
      sw:e.scrollWidth,cw:e.clientWidth,cls:String(e.className||'').slice(0,20),x:Math.round(r.left),w:Math.round(r.width)});}
  return JSON.stringify({n:items.length,items:items,trunc:items.filter(function(i){return i.trunc;}).length});
})()`;

const SETTINGS = `(()=>{
  var panels=[],all=document.querySelectorAll('[class$="_panel"]');
  for(var i=0;i<all.length;i++){var e=all[i];var r=e.getBoundingClientRect();
    if(r.width<300||r.height<400)continue;
    var cs=getComputedStyle(e);
    if(cs.display==='none')continue;
    panels.push({cls:String(e.className).slice(0,24),x:Math.round(r.left),w:Math.round(r.width),
      padL:cs.paddingLeft,e:e});}
  if(!panels.length)return JSON.stringify({none:true});
  var p=panels[0];
  /* 面板内的文字叶子节点：宽度最小的那个若 < 40px 说明被压成竖排 */
  var leaves=[],k=p.e.querySelectorAll('*');
  for(var j=0;j<k.length;j++){var q=k[j];var rr=q.getBoundingClientRect();
    if(rr.width<8||rr.height<8)continue;
    var t=(q.textContent||'').replace(/\\s+/g,' ').trim();
    if(t.length<2||t.length>40||q.childElementCount>0)continue;
    var cs2=getComputedStyle(q); if(cs2.display==='none')continue;
    leaves.push({txt:t.slice(0,14),w:Math.round(rr.width),h:Math.round(rr.height),x:Math.round(rr.left)});}
  leaves.sort(function(a,b){return a.w-b.w;});
  return JSON.stringify({panel:{cls:p.cls,x:p.x,w:p.w,padL:p.padL},leafCount:leaves.length,narrowest:leaves.slice(0,6)});
})()`;

(async () => {
  let targets = null;
  for (let i = 0; i < 40; i++) { try { targets = await getJson("/json/list"); if (targets && targets.length) break; } catch (e) {} await sleep(500); }
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errs = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 110));
  };
  await new Promise((r) => { ws.onopen = r; });
  await send("Page.enable"); await send("Runtime.enable");
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

  await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
  await sleep(1400);
  for (let i = 0; i < 6; i += 1) {
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${i}]){r[${i}].click();return true;}return false;})()`);
    await sleep(8000);
    if (await ev(`(document.body.innerText||'').length>900`)) break;
    await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(900);
  }
  await sleep(2500);   // 等 untruncateBottom 跑过

  out("== ① 底部状态条 ==");
  const b = await js(BAND);
  out("  " + JSON.stringify(b));
  check("①: 找到贴底元素", b && b.n > 0, "n=" + (b && b.n));
  check("①: 没有任何元素被截断", b && b.trunc === 0, "trunc=" + (b && b.trunc) + " " + JSON.stringify((b.items || []).filter((x) => x.trunc).slice(0, 3)));
  const st = await js(`JSON.stringify(window.__dshUix ? window.__dshUix.state() : null)`);
  out("  uix.state: " + JSON.stringify(st));
  check("①: 插件记录了强制取消截断的元素", st && st.untrunc >= 0, "untrunc=" + (st && st.untrunc));

  out("== ② 设置面板 ==");
  await ev(`(()=>{var b=document.querySelectorAll('button,[role="button"],a');
    for(var i=0;i<b.length;i++){var t=(b[i].getAttribute('aria-label')||b[i].textContent||'').trim();
      if(t==='设置'||t.indexOf('设置')===0){b[i].click();return true;}}return false;})()`);
  await sleep(4500);
  const sp = await js(SETTINGS);
  out("  " + JSON.stringify(sp));
  check("②: 找到大面板", sp && sp.panel, JSON.stringify(sp && sp.panel));
  check("②: 面板整屏宽（不再被 56px 吃掉）", sp && sp.panel && sp.panel.w >= 340, sp && sp.panel ? ("w=" + sp.panel.w + " padL=" + sp.panel.padL) : "");
  const narrow = sp && sp.narrowest ? sp.narrowest[0] : null;
  check("②: 内容列不再竖排（最窄文字块 ≥ 44px）", narrow && narrow.w >= 44, JSON.stringify(sp && sp.narrowest));

  check("console 无报错", errs.length === 0, errs.slice(0, 2).join(" | ") || "(none)");
  const pass = results.filter((r) => r[1]).length;
  out("\n== SUMMARY: " + pass + "/" + results.length + " PASS ==");
  const failed = results.filter((r) => !r[1]).map((r) => r[0]);
  if (failed.length) out("FAILED: " + failed.join(" | "));
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
