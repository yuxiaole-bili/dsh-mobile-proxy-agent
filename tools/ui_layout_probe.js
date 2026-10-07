// 量手机端布局：底部用量条为什么被截断、顶部/其它按键哪里重叠
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9261;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-uip-"));
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
  function rect(e){var r=e.getBoundingClientRect();
    return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};}
  function vis(e){var r=e.getBoundingClientRect();var cs=getComputedStyle(e);
    return r.width>2&&r.height>2&&cs.display!=='none'&&cs.visibility!=='hidden'&&Number(cs.opacity)>0.05;}
  var res={vw:innerWidth,vh:innerHeight};

  /* 底部区域（y>vh-140）里的所有文字节点与容器 */
  var bottom=[];
  var all=document.querySelectorAll('*');
  for(var i=0;i<all.length;i++){
    var e=all[i];
    if(!vis(e))continue;
    var r=e.getBoundingClientRect();
    if(r.top<innerHeight-150)continue;
    var t=(e.textContent||'').replace(/\\s+/g,' ').trim();
    if(!t||t.length>60)continue;
    if(e.childElementCount>0)continue;
    var cs=getComputedStyle(e);
    bottom.push({txt:t.slice(0,40),cls:String(e.className||'').slice(0,28),r:rect(e),
      overflow:cs.textOverflow,ws:cs.whiteSpace,ov:cs.overflow,
      trunc:e.scrollWidth>e.clientWidth+1,sw:e.scrollWidth,cw:e.clientWidth,
      parentCls:String((e.parentElement&&e.parentElement.className)||'').slice(0,28),
      gi:cs.gridTemplateColumns.slice(0,60),fw:cs.flexWrap});
  }
  res.bottom=bottom.slice(0,26);

  /* 可点元素之间的重叠检测（互不包含的） */
  var click=[];
  var sel='button,[role="button"],a[href],[class*="iconButton"],[class*="toolbar"] button';
  var cs2=document.querySelectorAll(sel);
  for(var j=0;j<cs2.length;j++){
    var q=cs2[j];
    if(!vis(q))continue;
    var rr=q.getBoundingClientRect();
    if(rr.width<10||rr.height<10)continue;
    click.push({el:q,r:rr,txt:(q.getAttribute('aria-label')||q.textContent||'').replace(/\\s+/g,' ').trim().slice(0,18),
      cls:String(q.className||'').slice(0,26),y:Math.round(rr.top)});
  }
  var ov=[];
  for(var a=0;a<click.length;a++){
    for(var b=a+1;b<click.length;b++){
      var A=click[a],B=click[b];
      if(A.el.contains(B.el)||B.el.contains(A.el))continue;
      var ox=Math.min(A.r.right,B.r.right)-Math.max(A.r.left,B.r.left);
      var oy=Math.min(A.r.bottom,B.r.bottom)-Math.max(A.r.top,B.r.top);
      if(ox>2&&oy>2){
        ov.push({a:A.txt+'|'+A.cls,b:B.txt+'|'+B.cls,ox:Math.round(ox),oy:Math.round(oy),
                 ay:Math.round(A.r.top),by:Math.round(B.r.top)});
      }
    }
  }
  res.overlaps=ov.slice(0,20);
  res.clickCount=click.length;

  /* 顶部一行（y<90）的元素 */
  var top=[];
  for(var k=0;k<click.length;k++){ if(click[k].y<90) top.push({txt:click[k].txt,cls:click[k].cls,r:rect(click[k].el)}); }
  res.top=top.slice(0,14);
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
  await sleep(16000);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
    return r && r.result ? r.result.value : null;
  };
  // 打开一个会话（抽屉 → 第一行）
  await ev(`(()=>{try{window.__dshGestures.open();}catch(e){}return true;})()`);
  await sleep(800);
  await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[0]){r[0].click();return true;}return false;})()`);
  await sleep(9000);
  out("== 布局快照 ==");
  const raw = await ev(SNAP);
  let d = null;
  try { d = JSON.parse(raw); } catch (e) { out("解析失败: " + String(raw).slice(0, 200)); }
  if (d) {
    out("  视口: " + d.vw + "x" + d.vh + "   可点元素: " + d.clickCount);
    out("\n-- 底部区域文字节点 --");
    for (const b of d.bottom) out("   " + JSON.stringify(b));
    out("\n-- 顶部可点元素 (y<90) --");
    for (const t of d.top) out("   " + JSON.stringify(t));
    out("\n-- 重叠的可点元素对 (" + d.overlaps.length + ") --");
    for (const o of d.overlaps) out("   " + JSON.stringify(o));
  }
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
