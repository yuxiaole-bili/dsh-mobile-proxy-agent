// v2：等会话渲染完成后，量顶部 chip / 底部用量条 / 全页按键重叠
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9262;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-uip2-"));
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

const SNAP = `(()=>{
  function R(e){var r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};}
  function vis(e){var r=e.getBoundingClientRect();var cs=getComputedStyle(e);
    return r.width>2&&r.height>2&&cs.display!=='none'&&cs.visibility!=='hidden';}
  var res={vw:innerWidth,vh:innerHeight,scrollH:document.documentElement.scrollHeight};

  /* 按文案找元素 */
  function findByText(re,max){
    var o=[],all=document.querySelectorAll('*');
    for(var i=0;i<all.length;i++){var e=all[i];
      if(!vis(e))continue;
      var t=(e.textContent||'').replace(/\\s+/g,' ').trim();
      if(!t||t.length>70)continue;
      if(!re.test(t))continue;
      if(e.childElementCount>0)continue;
      var cs=getComputedStyle(e);
      o.push({txt:t.slice(0,44),cls:String(e.className||'').slice(0,30),r:R(e),
        trunc:e.scrollWidth>e.clientWidth+1,sw:e.scrollWidth,cw:e.clientWidth,
        overflow:cs.textOverflow,ws:cs.whiteSpace,ovf:cs.overflow,
        pcls:String((e.parentElement&&e.parentElement.className)||'').slice(0,30),
        pgi:getComputedStyle(e.parentElement).gridTemplateColumns.slice(0,50),
        pdisp:getComputedStyle(e.parentElement).display});
      if(o.length>=max)break;}
    return o;
  }
  res.chips = findByText(/个子智能体|个后台任务|子智能体|后台任务/, 10);
  res.usage = findByText(/tokens|调用|今日|累计|%$|^\\d+%/, 12);

  /* 底部 200px 内所有可见元素（含容器），看是谁在截断 */
  var bot=[];
  var all=document.querySelectorAll('*');
  for(var i=0;i<all.length;i++){var e=all[i];
    if(!vis(e))continue;
    var r=e.getBoundingClientRect();
    if(r.top<innerHeight-200)continue;
    var t=(e.textContent||'').replace(/\\s+/g,' ').trim();
    if(!t)continue;
    var cs=getComputedStyle(e);
    bot.push({txt:t.slice(0,36),cls:String(e.className||'').slice(0,26),r:R(e),kids:e.childElementCount,
      trunc:e.scrollWidth>e.clientWidth+1,ovf:cs.overflow,ws:cs.whiteSpace,disp:cs.display,
      pcls:String((e.parentElement&&e.parentElement.className)||'').slice(0,26)});
  }
  res.bottomArea=bot.slice(0,20);

  /* 全页可见按键的两两重叠 */
  var click=[],sel='button,[role="button"],a[href],[class*="iconButton"]';
  var cs2=document.querySelectorAll(sel);
  for(var j=0;j<cs2.length;j++){var q=cs2[j];
    if(!vis(q))continue;var rr=q.getBoundingClientRect();
    click.push({el:q,r:rr,txt:(q.getAttribute('aria-label')||q.textContent||'').replace(/\\s+/g,' ').trim().slice(0,16),cls:String(q.className||'').slice(0,24)});}
  var ov=[];
  for(var a=0;a<click.length;a++)for(var b=a+1;b<click.length;b++){
    var A=click[a],B=click[b];
    if(A.el.contains(B.el)||B.el.contains(A.el))continue;
    var ox=Math.min(A.r.right,B.r.right)-Math.max(A.r.left,B.r.left);
    var oy=Math.min(A.r.bottom,B.r.bottom)-Math.max(A.r.top,B.r.top);
    if(ox>2&&oy>2)ov.push({a:A.txt+'|'+A.cls,b:B.txt+'|'+B.cls,ox:Math.round(ox),oy:Math.round(oy),
      ax:Math.round(A.r.left),bx:Math.round(B.r.left),ay:Math.round(A.r.top),by:Math.round(B.r.top)});}
  res.overlaps=ov.slice(0,24); res.clickCount=click.length;
  return JSON.stringify(res);
})()`;

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
  await sleep(15000);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
    return r && r.result ? r.result.value : null;
  };
  // 轮询：抽屉 -> 会话行
  let opened = false;
  for (let i = 0; i < 8 && !opened; i += 1) {
    await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(1200);
    const n = await ev(`document.querySelectorAll('[class*="sessionRow"]').length`);
    out("  第" + (i + 1) + "次尝试：会话行 " + n);
    if (n > 0) {
      await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');r[${i % n}].click();return true;})()`);
      await sleep(9000);
      opened = true;
    }
  }
  // 等正文
  for (let i = 0; i < 6; i += 1) {
    const has = await ev(`document.body.innerText.length > 400`);
    if (has) break;
    await sleep(3000);
  }
  out("== 布局快照 v2 ==");
  const raw = await ev(SNAP);
  let d = null;
  try { d = JSON.parse(raw); } catch (e) { out("解析失败 " + String(raw).slice(0, 160)); }
  if (d) {
    out("  视口 " + d.vw + "x" + d.vh + "  可点 " + d.clickCount);
    out("\n-- 顶部 chip --");
    for (const c of d.chips) out("   " + JSON.stringify(c));
    out("\n-- 用量类文字 --");
    for (const c of d.usage) out("   " + JSON.stringify(c));
    out("\n-- 底部 200px 内元素 --");
    for (const c of d.bottomArea) out("   " + JSON.stringify(c));
    out("\n-- 重叠按键对 (" + d.overlaps.length + ") --");
    for (const o of d.overlaps) out("   " + JSON.stringify(o));
  }
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
