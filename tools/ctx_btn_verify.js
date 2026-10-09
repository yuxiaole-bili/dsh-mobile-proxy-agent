// 终验：开覆盖层 -> 点我自己的 ✕ -> 覆盖层应消失（容忍路由切换）
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9275;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-ctxbtn-"));
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

  // 进会话
  await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
  await sleep(1400);
  for (let i = 0; i < 6; i += 1) {
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${i}]){r[${i}].click();return true;}return false;})()`);
    await sleep(8000);
    if (await ev(`(document.body.innerText||'').length>900`)) break;
    await ev(`(()=>{try{window.__dshGestures&&window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(900);
  }

  // 开覆盖层
  await ev(`(()=>{var b=document.querySelectorAll('button,[role="button"],a');
    for(var i=0;i<b.length;i++){var l=((b[i].getAttribute('aria-label')||'')+(b[i].getAttribute('title')||'')+(b[i].textContent||''));
      if(l.indexOf('上下文洞察')>=0){var r=b[i].getBoundingClientRect();if(r.height>8){b[i].click();return true;}}}
    return false;})()`);
  await sleep(5000);
  const before = await ev(`(()=>{var t=document.querySelector('h1.lc-ov-pagetitle');
    return JSON.stringify({title:!!t, btn:!!document.querySelector('[data-dsh-uix="ctx-close"]'),
      st:(window.__dshUix?window.__dshUix.state():null)});})()`);
  out("开覆盖层后: " + String(before));
  let b = null; try { b = JSON.parse(before); } catch (e) {}
  check("覆盖层已打开（有 lc-ov 标题）", b && b.title === true, String(before));
  check("自建 ✕ 按钮已出现", b && b.btn === true, String(b && b.btn));

  // 点 ✕
  await ev(`(()=>{var e=document.querySelector('[data-dsh-uix="ctx-close"]');if(e){e.click();return true;}return false;})()`);
  let closed = false, detail = "";
  for (let i = 0; i < 10; i += 1) {
    await sleep(1200);
    const r = await ev(`(()=>{try{
      var t=document.querySelector('h1.lc-ov-pagetitle');
      var st=window.__dshUix?window.__dshUix.state():null;
      return JSON.stringify({title:!!t, ctxOpen:(st?st.ctxOpen:null), via:(st?st.ctxVia:null), closed:(st?st.ctxClosed:null)});}catch(e){return 'ERR';}})()`);
    detail = String(r);
    try { const o = JSON.parse(detail); if (o.title === false || o.ctxOpen === false) { closed = true; break; } } catch (e) {}
  }
  out("点 ✕ 之后: " + detail);
  check("点 ✕ 后覆盖层消失", closed === true, detail);

  const pass = results.filter((r) => r[1]).length;
  out("\n== SUMMARY: " + pass + "/" + results.length + " PASS ==");
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
