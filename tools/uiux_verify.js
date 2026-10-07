// 验收 90-uiux + CSS：
//   A 顶部 chip 与图标按钮不再重叠、且都在视口内
//   B 底部用量条文字不再被省略号截断
//   C 折叠按钮存在且能切换（html[data-dsh-uix-min]）
//   D 长按用量条 -> 展开态
//   E 上滑用量条 -> 展开态；下滑 -> 折叠态
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9265;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-uix-"));
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

const HEADER = `(()=>{
  function vis(e){var r=e.getBoundingClientRect();var cs=getComputedStyle(e);
    return r.width>2&&r.height>2&&cs.display!=='none'&&cs.visibility!=='hidden';}
  var chips=[],btns=[];
  var cs1=document.querySelectorAll('[class*="oXE0lW_root"],[class*="foD-wG_root"]');
  for(var i=0;i<cs1.length;i++){var e=cs1[i];if(!vis(e))continue;var r=e.getBoundingClientRect();
    if(r.top>60)continue;chips.push({cls:String(e.className).slice(0,22),r:[Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)]});}
  var cs2=document.querySelectorAll('button,[role="button"],a[href]');
  for(var j=0;j<cs2.length;j++){var q=cs2[j];if(!vis(q))continue;var rr=q.getBoundingClientRect();
    if(rr.top>60||rr.width<8||rr.height<8)continue;
    btns.push({txt:(q.getAttribute('aria-label')||q.textContent||'').trim().slice(0,14),
      r:[Math.round(rr.left),Math.round(rr.top),Math.round(rr.right),Math.round(rr.bottom)]});}
  var ov=[];
  for(var a=0;a<chips.length;a++)for(var b=0;b<btns.length;b++){
    var A=chips[a].r,B=btns[b].r;
    var ox=Math.min(A[2],B[2])-Math.max(A[0],B[0]);
    var oy=Math.min(A[3],B[3])-Math.max(A[1],B[1]);
    if(ox>1&&oy>1)ov.push({chip:chips[a].cls,btn:btns[b].txt,ox:ox,oy:oy});}
  var outside=btns.filter(function(b){return b.r[2]>innerWidth+1||b.r[0]<-1;});
  var chipOut=chips.filter(function(c){return c.r[2]>innerWidth+1;});
  return JSON.stringify({chips:chips,btns:btns.length,overlaps:ov,outside:outside.slice(0,6),chipOut:chipOut.slice(0,4)});
})()`;

const USAGE = `(()=>{
  var bar=document.querySelector('[class*="_2WTFBq_trigger"]')||document.querySelector('[class*="_2WTFBq_"]');
  if(!bar)return JSON.stringify({none:true});
  function vis(e){var r=e.getBoundingClientRect();var cs=getComputedStyle(e);
    return r.width>2&&r.height>2&&cs.display!=='none'&&cs.visibility!=='hidden';}
  var nodes=[],all=bar.querySelectorAll('*');
  for(var i=0;i<all.length;i++){var e=all[i];
    if(!vis(e))continue;
    var t=(e.textContent||'').replace(/\\s+/g,' ').trim();
    if(!t||t.length>40||e.childElementCount>0)continue;
    var cs=getComputedStyle(e);
    nodes.push({txt:t.slice(0,26),trunc:e.scrollWidth>e.clientWidth+1,
      sw:e.scrollWidth,cw:e.clientWidth,to:cs.textOverflow,ovf:cs.overflow});}
  var r=bar.getBoundingClientRect();
  return JSON.stringify({barCls:String(bar.className).slice(0,24),
    barRect:[Math.round(r.left),Math.round(r.top),Math.round(r.right),Math.round(r.bottom)],
    nodes:nodes,truncCount:nodes.filter(function(n){return n.trunc;}).length,
    ellipsis:nodes.filter(function(n){return n.to==='ellipsis';}).length});
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

  out("== 装载 ==");
  out("  " + JSON.stringify(await js(`JSON.stringify({uix:!!window.__dshUix, st:(window.__dshUix?window.__dshUix.state():null), hotErrs:(window.__dshHotErrors||[]).length})`)));
  check("90-uiux 已装载", (await ev(`!!window.__dshUix`)) === true);

  // 进会话
  await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
  await sleep(1500);
  let opened = false;
  for (let i = 0; i < 6 && !opened; i += 1) {
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${i}]){r[${i}].click();return true;}return false;})()`);
    await sleep(9000);
    if (await ev(`(document.body.innerText||'').length>900`)) opened = true;
    await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(900);
  }
  check("进入会话", opened);

  out("== A. 顶部重叠 ==");
  const h = await js(HEADER);
  out("  " + JSON.stringify(h));
  check("A: chip 与图标按钮无重叠", (h.overlaps || []).length === 0, JSON.stringify((h.overlaps || []).slice(0, 3)));
  check("A: 顶部按键都在视口内", (h.outside || []).length === 0, JSON.stringify(h.outside));
  check("A: chip 不越出视口", (h.chipOut || []).length === 0, JSON.stringify(h.chipOut));

  out("== B. 底部用量完整性 ==");
  const u = await js(USAGE);
  out("  " + JSON.stringify(u));
  check("B: 找到用量条", u && u.barCls, String(u && u.barCls));
  check("B: 没有元素被省略号截断", u && u.truncCount === 0, "trunc=" + (u && u.truncCount) + " ellipsis=" + (u && u.ellipsis));
  check("B: text-overflow 不再是 ellipsis", u && u.ellipsis === 0, "ellipsis=" + (u && u.ellipsis));

  out("== C. 折叠按钮 ==");
  const hasBtn = await ev(`!!document.querySelector('[data-dsh-uix="usage-toggle"]')`);
  check("C: 折叠按钮存在", hasBtn === true);
  await ev(`document.querySelector('[data-dsh-uix="usage-toggle"]').click()`);
  await sleep(400);
  const minOn = await ev(`document.documentElement.getAttribute("data-dsh-uix-min")`);
  check("C: 点击后进入折叠态", minOn === "1", "min=" + minOn);
  await ev(`document.querySelector('[data-dsh-uix="usage-toggle"]').click()`);
  await sleep(400);
  const minOff = await ev(`document.documentElement.getAttribute("data-dsh-uix-min")`);
  check("C: 再点回到展开态", minOff === null, "min=" + minOff);

  out("== D. 长按 ==");
  await ev(`(()=>{var b=document.querySelector('[class*="_2WTFBq_trigger"]')||document.querySelector('[class*="_2WTFBq_"]');
    if(!b)return false;
    b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch'}));
    return true;})()`);
  await sleep(800);
  const lp = await ev(`document.documentElement.getAttribute("data-dsh-uix-expand")`);
  await ev(`document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`);
  check("D: 长按进入展开态", lp === "1", "expand=" + lp);
  await ev(`window.__dshUix && document.documentElement.removeAttribute("data-dsh-uix-expand")`);

  out("== E. 手势 ==");
  const swipe = await ev(`(()=>{var b=document.querySelector('[class*="_2WTFBq_trigger"]')||document.querySelector('[class*="_2WTFBq_"]');
    if(!b)return "no-bar";
    function tev(type,y){var e=new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperty(e,'touches',{value:type==='touchend'?[]:[{clientY:y}]});
      Object.defineProperty(e,'changedTouches',{value:[{clientY:y}]});return e;}
    b.dispatchEvent(tev('touchstart',700)); b.dispatchEvent(tev('touchend',640));
    return document.documentElement.getAttribute("data-dsh-uix-expand");})()`);
  check("E: 上滑 -> 展开态", swipe === "1", "expand=" + swipe);
  const swipe2 = await ev(`(()=>{var b=document.querySelector('[class*="_2WTFBq_trigger"]')||document.querySelector('[class*="_2WTFBq_"]');
    document.documentElement.removeAttribute("data-dsh-uix-expand");
    function tev(type,y){var e=new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperty(e,'touches',{value:type==='touchend'?[]:[{clientY:640}]});
      Object.defineProperty(e,'changedTouches',{value:[{clientY:y}]});return e;}
    b.dispatchEvent(tev('touchstart',640)); b.dispatchEvent(tev('touchend',700));
    return document.documentElement.getAttribute("data-dsh-uix-min");})()`);
  check("E: 下滑 -> 折叠态", swipe2 === "1", "min=" + swipe2);
  await ev(`document.documentElement.removeAttribute("data-dsh-uix-min"); try{localStorage.setItem('dsh-uix-usage-min','0')}catch(e){}`);

  const st = await js(`JSON.stringify(window.__dshUix.state())`);
  out("  最终状态: " + JSON.stringify(st));
  check("无内部错误", st && Array.isArray(st.errors) && st.errors.length === 0, JSON.stringify(st && st.errors));
  check("console 无报错", errs.length === 0, errs.slice(0, 3).join(" | ") || "(none)");

  const pass = results.filter((r) => r[1]).length;
  out("\n== SUMMARY: " + pass + "/" + results.length + " PASS ==");
  const failed = results.filter((r) => !r[1]).map((r) => r[0]);
  if (failed.length) out("FAILED: " + failed.join(" | "));
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
