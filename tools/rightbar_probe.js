// 在 360×780 视口点"markdown 文件 chip"，看 DSH 的右侧栏文档预览发生了什么：
// 右栏是否展开、面板实际尺寸多少、有没有被塞进 0 宽的面板。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9247;
const BASE = process.argv[2];
const OUT = process.argv[3];
const NEEDLE = process.argv[4] || "t80_v14_cmp";
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-rb-"));
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

const SNAP = `JSON.stringify({
  frame:(function(){var f=document.querySelector('[class*="frame"]');
    if(!f)return null;var cs=getComputedStyle(f);
    return {cols:cs.gridTemplateColumns,collapsed:f.getAttribute('data-rightbar-collapsed'),
            sidebarCollapsed:f.getAttribute('data-sidebar-collapsed'),w:f.getBoundingClientRect().width};})(),
  rightbar:(function(){
    var f=document.querySelector('[class*="frame"]'); if(!f)return null;
    var kids=[].slice.call(f.children);
    return kids.map(function(k){var r=k.getBoundingClientRect();
      return {cls:String(k.className||'').slice(0,26),w:Math.round(r.width),h:Math.round(r.height),
              x:Math.round(r.left),vis:getComputedStyle(k).display};});})(),
  previewish:(function(){var o=[];
    var all=document.querySelectorAll('[class*="document"],[class*="preview"],[class*="Preview"],[class*="right"]');
    for(var i=0;i<all.length&&o.length<8;i++){var e=all[i];var r=e.getBoundingClientRect();
      if(r.width<1&&r.height<1)continue;
      o.push({cls:String(e.className||'').slice(0,34),w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.left)});}
    return o;})(),
  imgs:(function(){var o=[];var im=document.querySelectorAll('img');
    for(var i=0;i<im.length&&o.length<6;i++){var r=im[i].getBoundingClientRect();
      o.push({src:String(im[i].getAttribute('src')||'').slice(0,42),w:Math.round(r.width),h:Math.round(r.height)});}
    return o;})(),
  tabs:(function(){var o=[];var t=document.querySelectorAll('[role="tab"],[class*="tab"]');
    for(var i=0;i<t.length&&o.length<6;i++){o.push({t:(t[i].textContent||'').trim().slice(0,14),x:Math.round(t[i].getBoundingClientRect().left)});}
    return o;})()
})`;

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
      if (u.indexOf("/favicon") < 0 && u.indexOf("alert-chime") < 0) reqs.push(m.params.request.method + " " + u.slice(0, 90));
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

  // 找到含有目标文件名的会话
  let ok = false;
  for (const idx of [0, 1, 2, 3]) {
    await ev(`(()=>{try{window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(600);
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${idx}]){r[${idx}].click();return true;}return false;})()`);
    await sleep(8500);
    if (await ev(`(document.body.innerText||'').indexOf(${JSON.stringify(NEEDLE)})>=0`)) { ok = true; out("会话 #" + idx + " 命中目标文件名"); break; }
  }
  if (!ok) out("!! 未命中，结果仅供参考");

  out("== 点击前 ==");
  out("  " + JSON.stringify(await js(SNAP)));

  reqs.length = 0;
  const clicked = await ev(`(()=>{
    var b=document.querySelector('button[class*="_fileMention"]');
    if(!b) return null;
    var info={cls:String(b.className).slice(0,60),title:b.getAttribute('title'),text:(b.textContent||'').trim().slice(0,30)};
    b.click(); return info;
  })()`);
  out("== 点了 chip ==");
  out("  " + JSON.stringify(clicked));
  await sleep(3000);
  out("  请求: " + JSON.stringify(reqs.slice(0, 8)));
  out("== 点击后 ==");
  out("  " + JSON.stringify(await js(SNAP)));

  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => {
  out("ERR " + (e && e.stack || e));
  if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} }
  try { edge.kill(); } catch (_) {}
  process.exit(1);
});
