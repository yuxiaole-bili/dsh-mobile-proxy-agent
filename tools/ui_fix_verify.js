// 复验 UI 修复：插件页按钮不再换行；顺带确认没把别的面板推歪。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9242;
const BASE = process.argv[2];
const DIR = process.argv[3] || "<REPO>\\evidence";
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-ui4-"));
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

const lines = [];
const results = [];
const out = (s) => { console.log(s); lines.push(s); };
const check = (n, ok, d) => { results.push([n, !!ok]); out((ok ? "PASS  " : "FAIL  ") + n + (d ? "  | " + d : "")); };
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
  let id = 0; const pending = new Map(); const errs = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 140));
    if (m.method === "Runtime.exceptionThrown") errs.push("EXC: " + String((m.params.exceptionDetails.exception || {}).description || "").slice(0, 160));
  };
  await new Promise((r) => { ws.onopen = r; });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
  await send("Emulation.setUserAgentOverride", { userAgent: UA });
  await send("Page.navigate", { url: BASE });
  await sleep(14000);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
    return r && r.result ? r.result.value : null;
  };
  const js = async (expr) => { const v = await ev(expr); try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return { __raw: v }; } };
  const shot = async (name) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    if (s && s.data) { const p = path.join(DIR, name); fs.writeFileSync(p, Buffer.from(s.data, "base64")); out("  shot: " + p); }
  };

  await ev(`(()=>{var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++){if((bs[i].innerText||'').trim()==='继续'){bs[i].click();return true;}}return false;})()`);
  await sleep(1200);

  out("== A. 全宽浮层面板是否被让出 56px 栏杆 ==");
  const panels = await js(`(()=>{var o=[];var all=document.querySelectorAll('[class$="_panel"]');
    for(var i=0;i<all.length&&o.length<6;i++){var r=all[i].getBoundingClientRect();
      o.push({cls:String(all[i].className||'').slice(0,36),x:Math.round(r.left),w:Math.round(r.width),pos:getComputedStyle(all[i]).position});}
    return JSON.stringify({n:all.length,items:o});})()`);
  out("  " + JSON.stringify(panels));
  if (panels.items && panels.items.length) {
    const okLeft = panels.items.every((p) => p.x >= 55);
    check("以 _panel 结尾的面板都让出了栏杆（x>=55）", okLeft, JSON.stringify(panels.items.map((p) => p.x)));
  } else {
    check("当前页没有 _panel 面板可测（跳过）", true, "n=0");
  }

  out("== B. 插件页：添加插件按钮 ==");
  await ev(`(()=>{var r=document.querySelector('[class*="sidebarCol"]');var b=r.querySelectorAll('button');
    for(var i=0;i<b.length;i++){if((b[i].getAttribute('aria-label')||'')==='插件'){b[i].click();return true;}}return false;})()`);
  await sleep(3000);
  await shot("ui_plugins_fixed.png");
  const btn = await js(`(()=>{try{
    var all=document.querySelectorAll('button'),best=null;
    for(var i=0;i<all.length;i++){var t=(all[i].innerText||'').replace(/\\s+/g,' ').trim();
      if(t.indexOf('添加插件')>=0){best=all[i];break;}}
    if(!best) return JSON.stringify({none:true});
    var r=best.getBoundingClientRect();
    var cs=getComputedStyle(best);
    var parts=best.querySelectorAll('span,div');
    var inner=parts.length?parts[parts.length-1]:best;
    var ir=inner.getBoundingClientRect();
    return JSON.stringify({cls:String(best.className||'').slice(0,44),x:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height),
      ws:cs.whiteSpace,txt:best.innerText.replace(/\\s+/g,' ').trim(),
      innerW:Math.round(ir.width),innerH:Math.round(ir.height),
      twoLines:(ir.height>22),
      rightEdge:Math.round(r.right),viewport:innerWidth});
  }catch(e){return JSON.stringify({err:String(e)});}})()`);
  out("  " + JSON.stringify(btn));
  check("找到添加插件按钮", btn.none !== true, JSON.stringify(btn).slice(0, 120));
  if (btn.none !== true) {
    check("按钮文字单行（内层高 <= 22px）", btn.innerH <= 22, "innerH=" + btn.innerH);
    check("white-space:nowrap 生效", String(btn.ws).indexOf("nowrap") >= 0, btn.ws);
    check("按钮在视口内（右边缘 <= 视口宽）", btn.rightEdge <= btn.viewport, btn.rightEdge + " <= " + btn.viewport);
  }

  out("== C. 回归：聊天页布局没被推歪 ==");
  await ev(`(window.__dshGestures && window.__dshGestures.open())`);
  await sleep(900);
  await ev(`(()=>{var rows=document.querySelectorAll('[class*="sessionRow"]');var p=null;
    for(var i=0;i<rows.length;i++){if(!/selected/.test(String(rows[i].className))){p=rows[i];break;}}
    if(!p&&rows.length)p=rows[0];if(p){p.click();return true;}return false;})()`);
  await sleep(9000);
  await shot("ui_chat_after.png");
  const chat = await js(`(()=>{try{
    var c=document.querySelector('[class*="centerCol"]');var card=document.querySelector('[class*="card"]');
    var f=document.querySelector('[data-chat-flow]');
    var cr=c?c.getBoundingClientRect():null, kr=card?card.getBoundingClientRect():null;
    return JSON.stringify({center:cr?{x:Math.round(cr.left),w:Math.round(cr.width)}:null,
      card:kr?{x:Math.round(kr.left),w:Math.round(kr.width)}:null,
      flow:f?{kids:f.childElementCount,txt:(f.innerText||'').length}:null,
      hotErrs:(window.__dshHotErrors||[]).length});
  }catch(e){return JSON.stringify({err:String(e)});}})()`);
  out("  " + JSON.stringify(chat));
  check("正文列仍是 56 起、304 宽", chat.center && chat.center.x === 56 && chat.center.w === 304, JSON.stringify(chat.center));
  check("会话正文有内容", chat.flow && (chat.flow.kids > 0 || chat.flow.txt > 0), JSON.stringify(chat.flow));
  check("no hotpatch errors", chat.hotErrs === 0, "hotErrs=" + chat.hotErrs);
  check("console errors = 0", errs.length === 0, errs.slice(0, 3).join(" | ") || "(none)");

  const ok = results.filter((r) => r[1]).length;
  out("\n== SUMMARY: " + ok + "/" + results.length + " PASS ==");
  const failed = results.filter((r) => !r[1]).map((r) => r[0]);
  if (failed.length) out("FAILED: " + failed.join(" | "));
  fs.writeFileSync(path.join(DIR, "ui_fix_verify.txt"), lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  out("ERR " + (e && e.stack || e));
  try { fs.writeFileSync(path.join(DIR, "ui_fix_verify.txt"), lines.join("\n") + "\n", "utf8"); } catch (_) {}
  try { edge.kill(); } catch (_) {}
  process.exit(1);
});
