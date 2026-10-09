// 判定：覆盖层打开时，图标栏位置的顶层元素是谁（rail 还是 overlay）？
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9274;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-rail-"));
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

const PROBE = `(()=>{
  function hit(x,y){var e=document.elementFromPoint(x,y);if(!e)return null;
    var chain=[],p=e,h=0;
    while(p&&h<4){chain.push(String(p.className||p.tagName).slice(0,26));p=p.parentElement;h++;}
    return {top:String(e.className||e.tagName).slice(0,30),chain:chain};}
  var ov=document.querySelector('[class*="overlayLayer"]');
  var rail=document.querySelector('[class*="sidebarCol"]')||document.querySelector('[class*="_2H3hWW_root"]');
  function z(e){return e?getComputedStyle(e).zIndex:null;}
  return JSON.stringify({
    overlayExists:!!ov, overlayZ:z(ov), railZ:z(rail),
    atRailTop:hit(28,60), atRailMid:hit(28,300), atRailBottom:hit(28,700),
    atContent:hit(200,300)
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
  out("== 覆盖层打开前 ==");
  out("  " + JSON.stringify(await js(PROBE)));

  // 打开覆盖层（点侧栏"上下文洞察"）
  const opened = await ev(`(()=>{var b=document.querySelectorAll('button,[role="button"],a');
    for(var i=0;i<b.length;i++){var l=((b[i].getAttribute('aria-label')||'')+(b[i].getAttribute('title')||'')+(b[i].textContent||''));
      if(l.indexOf('上下文洞察')>=0){var r=b[i].getBoundingClientRect();if(r.height>8){b[i].click();return l.slice(0,16);}}}
    return null;})()`);
  out("\n== 点了: " + JSON.stringify(opened) + " ==");
  await sleep(4500);
  const after = await js(PROBE);
  out("  " + JSON.stringify(after));
  check("覆盖层已打开", after && after.overlayExists === true, JSON.stringify(after && { oz: after.overlayZ, rz: after.railZ }));
  const topAtRail = after && after.atRailMid ? String(after.atRailMid.top) : "";
  const railReachable = /sidebar|_2H3hWW|rail/i.test(topAtRail) || /sidebar|_2H3hWW|rail/i.test(String(after && after.atRailMid && after.atRailMid.chain));
  check("图标栏在覆盖层之上（点得到）", railReachable, "顶层=" + topAtRail);
  const st = await js(`JSON.stringify(window.__dshUix ? window.__dshUix.state() : null)`);
  out("  uix.state: " + JSON.stringify(st));

  // 点图标栏中部 -> 应关闭覆盖层
  const clicked = await ev(`(()=>{var e=document.elementFromPoint(28,300);
    if(!e)return 'no-el';
    var b=e.closest('button,[role="button"],a')||e;
    b.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    return String(b.className||b.tagName).slice(0,26);})()`);
  out("\n== 点图标栏(28,300): " + JSON.stringify(clicked) + " ==");
  await sleep(3000);
  const st2 = await js(`JSON.stringify(window.__dshUix ? window.__dshUix.state() : null)`);
  out("  uix.state: " + JSON.stringify(st2));
  check("点图标栏后覆盖层关闭", st2 && st2.ctxOpen === false && st2.ctxClosed >= 1,
        "ctxOpen=" + (st2 && st2.ctxOpen) + " ctxClosed=" + (st2 && st2.ctxClosed));

  const pass = results.filter((r) => r[1]).length;
  out("\n== SUMMARY: " + pass + "/" + results.length + " PASS ==");
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
