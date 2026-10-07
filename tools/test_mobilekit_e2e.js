// 端到端：dsh-mobile-kit 的 client 半边在页面里是否真的执行了
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9260;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-mk-"));
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
  let id = 0; const pending = new Map(); const errs = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 130));
  };
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

  out("== dsh-mobile-kit client 半边在页面里的状态 ==");
  const st = await ev(`(window.__dshMobileKit ? JSON.stringify(window.__dshMobileKit.state()) : null)`);
  out("  " + String(st));
  let s = null;
  try { s = JSON.parse(st); } catch (e) {}
  check("window.__dshMobileKit 存在（client 半边执行了）", !!s, String(st));
  check("版本 = 0.1.0", s && s.version === "0.1.0", s ? s.version : "");
  check("移动端 UA 判定为 true", s && s.mobile === true, s ? String(s.mobile) : "");
  check("polyfill 生效：withResolvers", s && s.withResolvers === "function", s ? String(s.withResolvers) : "");
  check("polyfill 生效：AbortSignal.any", s && s.abortAny === "function", s ? String(s.abortAny) : "");
  check("移动端 CSS 已注入", s && s.css === true, s ? String(s.css) : "");

  const cssTag = await ev(`!!document.getElementById("dsh-mobile-kit-css")`);
  check("样式标签存在于 DOM", cssTag === true);

  const rules = await ev(`(function(){try{
    var t=document.getElementById("dsh-mobile-kit-css");
    return t && t.textContent ? t.textContent.indexOf("_panel")>=0 : false;}catch(e){return false;}})()`);
  check("CSS 内容确为本插件（含 _panel 规则）", rules === true);

  // 与其它插件共存：老补丁仍在
  const coexist = await ev(`JSON.stringify({chipview:!!window.__dshChipView, fileview:!!(window.__dshFileView&&window.__dshFileView.open)})`);
  out("  共存检查: " + coexists(coexist));
  function coexists(x) { return String(x); }
  check("与手机热补丁共存（chipview/fileview 仍在）", String(coexist).indexOf('"chipview":true') > 0 && String(coexist).indexOf('"fileview":true') > 0, String(coexist));

  check("console 无报错", errs.length === 0, errs.slice(0, 3).join(" | ") || "(none)");

  const pass = results.filter((r) => r[1]).length;
  out("\n== SUMMARY: " + pass + "/" + results.length + " PASS ==");
  const failed = results.filter((r) => !r[1]).map((r) => r[0]);
  if (failed.length) out("FAILED: " + failed.join(" | "));
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  out("ERR " + (e && e.stack || e));
  if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} }
  try { edge.kill(); } catch (_) {}
  process.exit(1);
});
