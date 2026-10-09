// 找到把预览面板推到屏幕外的那个祖先，并试几种 CSS 把它拉回视口。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9248;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-rb2-"));
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

const CANDIDATES = [
  ["A 右栏改全屏覆盖", `@media (max-width:820px){[class*="rightbarCol"]{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;z-index:95!important;background:#16161a!important;overflow:auto!important}}`],
  ["B A+预览面板归位", `@media (max-width:820px){[class*="rightbarCol"]{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;z-index:95!important;background:#16161a!important;overflow:auto!important}[class*="rightbarCol"] [class*="preview"]{position:static!important;left:auto!important;right:auto!important;width:100%!important;max-width:100%!important}}`],
  ["C 只改 frame 栅格", `@media (max-width:820px){[class*="frame"]{grid-template-columns:0px 0px 100vw!important}}`],
  ["D B+栅格", `@media (max-width:820px){[class*="frame"]{grid-template-columns:0px 0px 100vw!important}[class*="rightbarCol"]{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;z-index:95!important;background:#16161a!important;overflow:auto!important}[class*="rightbarCol"] [class*="preview"]{position:static!important;left:auto!important;width:100%!important}}`],
];

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
  const js = async (expr) => { const v = await ev(expr); try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return { __raw: v }; } };

  let ok = false;
  for (const idx of [0, 1, 2, 3]) {
    await ev(`(()=>{try{window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(600);
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${idx}]){r[${idx}].click();return true;}return false;})()`);
    await sleep(8500);
    if (await ev(`(document.body.innerText||'').indexOf('t80_')>=0`)) { ok = true; break; }
  }
  out("会话准备: " + ok);

  // 打开预览
  await ev(`(()=>{var b=document.querySelector('button[class*="_fileMention"]');if(b)b.click();return !!b;})()`);
  await sleep(2500);

  out("== 预览面板的祖先链（谁把它推到屏幕外）==");
  out("  " + JSON.stringify(await js(`(()=>{
    var el=document.querySelector('img[src^="blob:"]'); if(!el) return JSON.stringify({none:true});
    var o=[],p=el,h=0;
    while(p&&h<8){var r=p.getBoundingClientRect();var cs=getComputedStyle(p);
      o.push({cls:String(p.className||'').slice(0,26),x:Math.round(r.left),w:Math.round(r.width),
              pos:cs.position,left:cs.left,tr:cs.transform.slice(0,24)});p=p.parentElement;h++;}
    return JSON.stringify(o);})()`)));

  out("== 试各种 CSS ==");
  for (const [name, css] of CANDIDATES) {
    await ev(`(()=>{var s=document.getElementById('dsh-rb-try');if(s)s.remove();
      s=document.createElement('style');s.id='dsh-rb-try';s.textContent=${JSON.stringify(css)};
      document.head.appendChild(s);return true;})()`);
    await sleep(700);
    const m = await js(`(()=>{
      var el=document.querySelector('img[src^="blob:"]');
      var rb=document.querySelector('[class*="rightbarCol"]');
      var f=document.querySelector('[class*="frame"]');
      function rect(e){if(!e)return null;var r=e.getBoundingClientRect();
        return {x:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height)};}
      var panel=el; for(var i=0;i<3&&panel&&panel.parentElement;i++){panel=panel.parentElement;}
      return JSON.stringify({img:rect(el),panel3:rect(panel),
        panelCls:panel?String(panel.className||'').slice(0,24):null,
        rightbar:rect(rb),frame:rect(f),
        inView:(function(){if(!el)return null;var r=el.getBoundingClientRect();
          return r.left>=-1&&r.left<360&&r.width>100;})()});})()`);
    out("  " + name + " -> " + JSON.stringify(m));
  }

  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => {
  out("ERR " + (e && e.stack || e));
  if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} }
  try { edge.kill(); } catch (_) {}
  process.exit(1);
});
