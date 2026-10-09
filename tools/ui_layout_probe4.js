// 挖底部状态条 + 顶部头部的真实结构（类名/尺寸/溢出样式），用于精确写 CSS
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9264;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-uip4-"));
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

const DUMP_BOTTOM = `(()=>{
  function info(e){
    var r=e.getBoundingClientRect();var cs=getComputedStyle(e);
    return {tag:e.tagName,cls:String(e.className||'').slice(0,40),
      x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
      txt:(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30),
      ovf:cs.overflow,to:cs.textOverflow,ws:cs.whiteSpace,disp:cs.display,flex:cs.flexWrap,
      minW:cs.minWidth,maxW:cs.maxWidth,gap:cs.gap,fs:cs.fontSize,
      trunc:e.scrollWidth>e.clientWidth+1,sw:e.scrollWidth,cw:e.clientWidth,kids:e.childElementCount};
  }
  /* 找底部那条：包含 % 且在底部 80px 内、且是某个容器 */
  var best=null,all=document.querySelectorAll('*');
  for(var i=0;i<all.length;i++){var e=all[i];
    var r=e.getBoundingClientRect();
    if(r.width<100||r.height<10)continue;
    if(r.top<innerHeight-90)continue;
    var t=(e.textContent||'');
    if(!/%/.test(t))continue;
    if(t.length>120)continue;
    if(!best||r.width*r.height>best.r.width*best.r.height)best={e:e,r:r};}
  if(!best)return JSON.stringify({none:true});
  var chain=[],p=best.e,h=0;
  while(p&&h<4){chain.push(info(p));p=p.parentElement;h++;}
  var kids=[];var k=best.e.querySelectorAll('*');
  for(var j=0;j<k.length&&kids.length<28;j++){var q=k[j];var rr=q.getBoundingClientRect();
    if(rr.width<4)continue;kids.push(info(q));}
  return JSON.stringify({container:info(best.e),chain:chain,kids:kids,html:best.e.outerHTML.slice(0,900)});
})()`;

const DUMP_TOP = `(()=>{
  function info(e){
    var r=e.getBoundingClientRect();var cs=getComputedStyle(e);
    return {cls:String(e.className||'').slice(0,34),x:Math.round(r.left),y:Math.round(r.top),
      w:Math.round(r.width),h:Math.round(r.height),
      txt:(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,22),
      ovf:cs.overflow,to:cs.textOverflow,ws:cs.whiteSpace,flex:cs.flexWrap,
      minW:cs.minWidth,flexGrow:cs.flexGrow,flexShrink:cs.flexShrink,pos:cs.position};
  }
  /* 头部：y<45 且高度>20 的容器 */
  var out=[],all=document.querySelectorAll('*');
  for(var i=0;i<all.length;i++){var e=all[i];var r=e.getBoundingClientRect();
    if(r.top<0||r.top>45||r.height<18||r.width<30)continue;
    out.push(info(e));}
  /* 去重（同一 rect 只留最外层） */
  var seen={},uniq=[];
  for(var j=0;j<out.length;j++){var k=out[j].x+','+out[j].y+','+out[j].w;
    if(seen[k])continue;seen[k]=1;uniq.push(out[j]);}
  return JSON.stringify(uniq.slice(0,24));
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
  await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
  await sleep(1200);
  await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[1]){r[1].click();return true;}return false;})()`);
  await sleep(10000);
  out("== 底部状态条 ==");
  out(String(await ev(DUMP_BOTTOM)));
  out("\n== 头部一行 ==");
  out(String(await ev(DUMP_TOP)));
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
