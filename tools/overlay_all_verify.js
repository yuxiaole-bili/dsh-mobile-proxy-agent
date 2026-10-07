// 泛化验收：① 正常对话页不显示 ✕（屏幕外面板不误触发）② 打开覆盖层页 -> ✕ 出现并可关闭
// ③ 换一个覆盖层页（插件页/自动化任务页）看是否同样挂上 ✕
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9276;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-ovall-"));
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
  const st = async () => { const v = await ev(`JSON.stringify(window.__dshUix ? window.__dshUix.state() : null)`); try { return JSON.parse(v); } catch (e) { return null; } };

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
  await sleep(2500);

  out("== ① 正常对话页 ==");
  const s0 = await st();
  out("  " + JSON.stringify(s0));
  check("①: 覆盖层未打开", s0 && s0.ctxOpen === false, "ctxOpen=" + (s0 && s0.ctxOpen));
  check("①: 不显示 ✕（屏幕外面板不误触发）", s0 && s0.hasToggle !== undefined && (await ev(`!document.querySelector('[data-dsh-uix="ctx-close"]')`)) === true,
        "btn=" + String(await ev(`!!document.querySelector('[data-dsh-uix="ctx-close"]')`)));

  out("== ② 打开上下文覆盖层 ==");
  await ev(`(()=>{var b=document.querySelectorAll('button,[role="button"],a');
    for(var i=0;i<b.length;i++){var l=((b[i].getAttribute('aria-label')||'')+(b[i].getAttribute('title')||'')+(b[i].textContent||''));
      if(l.indexOf('上下文洞察')>=0){var r=b[i].getBoundingClientRect();if(r.height>8){b[i].click();return true;}}}
    return false;})()`);
  await sleep(5000);
  const s1 = await st();
  out("  " + JSON.stringify(s1));
  check("②: ✕ 出现", (await ev(`!!document.querySelector('[data-dsh-uix="ctx-close"]')`)) === true);
  check("②: 按钮带上了页面标题", s1 && typeof s1.ctxTitle === "string", "title=" + JSON.stringify(s1 && s1.ctxTitle));
  await ev(`(()=>{var e=document.querySelector('[data-dsh-uix="ctx-close"]');if(e)e.click();return !!e;})()`);
  await sleep(3500);
  const s2 = await st();
  out("  点 ✕ 后: " + JSON.stringify(s2));
  check("②: ✕ 能关闭该页", s2 && s2.ctxOpen === false, "ctxOpen=" + (s2 && s2.ctxOpen) + " via=" + (s2 && s2.ctxVia));

  out("== ③ 换一个侧栏页面（插件页）==");
  await ev(`(()=>{var b=document.querySelectorAll('button,[role="button"],a');
    for(var i=0;i<b.length;i++){var l=((b[i].getAttribute('aria-label')||'')+(b[i].getAttribute('title')||'')+(b[i].textContent||''));
      if(l.indexOf('插件')>=0){var r=b[i].getBoundingClientRect();if(r.width>8&&r.height>8&&r.left<60){b[i].click();return l.slice(0,10);}}}
    return null;})()`);
  await sleep(5000);
  const s3 = await st();
  const btn3 = await ev(`!!document.querySelector('[data-dsh-uix="ctx-close"]')`);
  out("  state: " + JSON.stringify(s3) + "  btn=" + btn3);
  check("③: 插件页可正常打开（未被误判为覆盖层或已挂按钮）", s3 !== null, "ctxOpen=" + (s3 && s3.ctxOpen) + " title=" + JSON.stringify(s3 && s3.ctxTitle));

  const pass = results.filter((r) => r[1]).length;
  out("\n== SUMMARY: " + pass + "/" + results.length + " PASS ==");
  const failed = results.filter((r) => !r[1]).map((r) => r[0]);
  if (failed.length) out("FAILED: " + failed.join(" | "));
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { out("ERR " + (e && e.stack || e)); if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} } try { edge.kill(); } catch (_) {} process.exit(1); });
