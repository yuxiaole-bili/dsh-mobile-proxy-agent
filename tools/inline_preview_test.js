// 验证 50-fileview.js 的类型分流：
//   图片/文本 -> 页面内预览（不调用原生 openwith）
//   pdf 等    -> 交给手机上的第三方 App（调用 openwith）
// 另检查预览层底部新增的"用手机应用打开"按钮。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9245;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const IMG = "D:\\code\\yuagent\\local_sd\\bra_assets\\bra_A.png";
const PDF = "D:\\code\\yuagent\\docs\\REPORT_20261004_summary.pdf";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-inline-"));
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

const FAKE = `
(function(){
  window.__calls=[];window.__seq=0;
  window.__DSHNative={call:function(method,argsJson){
    var id="t"+(++window.__seq);
    window.__calls.push({m:String(method),args:String(argsJson)});
    setTimeout(function(){try{window.__DSHNativeResult(id,JSON.stringify({ok:1,bytes:1,name:"x"}));}catch(e){}},15);
    return id;
  }};
})();
`;

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
  await send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE });
  await send("Page.navigate", { url: BASE });
  await sleep(15000);
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
    return r && r.result ? r.result.value : null;
  };
  const js = async (expr) => { const v = await ev(expr); try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return { __raw: v }; } };
  const rpcOpen = (p) => ev(`fetch("/api/session/openWorkspacePath",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({type:"client-request",rpcId:"r1",method:"session/openWorkspacePath",
      payload:{args:{_request:{path:${JSON.stringify(p)}}}}})}).then(function(r){return r.text();}).catch(function(e){return "ERR "+e;})`);

  out("== 0. 补丁装载 ==");
  out("  " + (await ev(`JSON.stringify({fileview:!!window.__dshFileView,hotErrs:(window.__dshHotErrors||[]).length})`)));
  check("50-fileview 已装载", (await ev(`!!window.__dshFileView`)) === true);

  out("== A. 图片 -> 页面内预览，且不调用 openwith ==");
  const r1 = await rpcOpen(IMG);
  await sleep(1200);
  out("  RPC 应答: " + String(r1).slice(0, 90));
  const a = await js(`JSON.stringify({
    calls:(window.__calls||[]).map(function(c){return c.m;}),
    overlay:(function(){var e=document.getElementById("dsh-fv");return e?e.style.display:null;})(),
    img:(function(){var e=document.querySelector("#dsh-fv img");return e?(e.getAttribute("src")||"").slice(0,60):null;})(),
    extBtn:(function(){var e=document.querySelector('#dsh-fv [data-dsh-fv="ext"]');return e?e.textContent:null;})()
  })`);
  out("  " + JSON.stringify(a));
  check("图片走页内预览（overlay 打开）", a.overlay === "flex", "display=" + a.overlay);
  check("预览层用 <img> 显示图片", !!a.img && a.img.indexOf("/f?path=") >= 0, String(a.img));
  check("图片没有调原生 openwith", Array.isArray(a.calls) && a.calls.indexOf("openwith") < 0, JSON.stringify(a.calls));
  check("预览层有『用手机应用打开』按钮", a.extBtn === "用手机应用打开", String(a.extBtn));

  out("== B. pdf -> 交给手机上的第三方 App ==");
  await ev(`(()=>{var e=document.getElementById("dsh-fv");if(e)e.style.display="none";return true;})()`);
  await sleep(300);
  const r2 = await rpcOpen(PDF);
  await sleep(1500);
  out("  RPC 应答: " + String(r2).slice(0, 90));
  const b = await js(`JSON.stringify({
    calls:(window.__calls||[]).map(function(c){return c.m;}),
    last:(window.__calls&&window.__calls.length)?window.__calls[window.__calls.length-1].args:null,
    overlay:(function(){var e=document.getElementById("dsh-fv");return e?e.style.display:null;})()
  })`);
  out("  " + JSON.stringify(b));
  check("pdf 调用了原生 openwith", Array.isArray(b.calls) && b.calls.indexOf("openwith") >= 0, JSON.stringify(b.calls));
  check("openwith 参数指向 /dl", String(b.last || "").indexOf("/dl?path=") > 0, String(b.last).slice(0, 120));
  check("pdf 没有被当成图片预览", b.overlay !== "flex", "display=" + b.overlay);

  const hotErrs = await js(`JSON.stringify(window.__dshHotErrors||[])`);
  check("no hotpatch errors", Array.isArray(hotErrs) && hotErrs.length === 0, JSON.stringify(hotErrs).slice(0, 160));
  check("console errors = 0", errs.length === 0, errs.slice(0, 3).join(" | ") || "(none)");

  const ok = results.filter((r) => r[1]).length;
  out("\n== SUMMARY: " + ok + "/" + results.length + " PASS ==");
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
