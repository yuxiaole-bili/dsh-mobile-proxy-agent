// 手机视口下的真实流程回归：加载 App → 点开一个已存在的会话（只跟随，不新建、不发消息）
// → 抽屉应被 60-autocollapse 自动收起 → 会话正文应渲染出来 → 0 控制台错误 → 截图。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9234;
const BASE = process.argv[2];
const SHOT = process.argv[3];
const OUT = process.argv[4];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-flow-"));
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
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 160));
    if (m.method === "Runtime.exceptionThrown") errs.push("EXC: " + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || "").slice(0, 200));
  };
  await new Promise((r) => { ws.onopen = r; });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setUserAgentOverride", { userAgent: UA });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "try{Object.defineProperty(Promise,'withResolvers',{value:undefined,writable:true,configurable:true});}catch(e){}\n" +
            "try{delete Array.prototype.findLast;}catch(e){}",
  });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
    return r && r.result ? r.result.value : null;
  };
  const js = async (expr) => { const v = await ev(expr); try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return { __raw: v }; } };

  await send("Page.navigate", { url: BASE });
  await sleep(15000);

  out("== 1. 注入层都在 ==");
  const layers = await js(`JSON.stringify({
    hot:!!window.__dshHot, keeper:!!window.__dshKeeper, pager:!!window.__dshPager,
    gestures:!!window.__dshGestures, fileview:!!window.__dshFileView, autocollapse:!!window.__dshAutoCollapse,
    mobile:!!(window.__dshHot&&window.__dshHot.mobile), native:!!(window.__dshNative&&window.__dshNative.call)
  })`);
  out("  " + JSON.stringify(layers));
  for (const k of ["hot", "keeper", "pager", "gestures", "fileview", "autocollapse", "mobile"]) {
    check("layer present: " + k, layers[k] === true);
  }

  out("== 2. 打开抽屉并点开另一个会话（只跟随） ==");
  const before = await ev(`(()=>{var e=document.querySelector("[data-conversation-session]");return e?String(e.getAttribute("data-conversation-session")):"none";})()`);
  await ev(`window.__dshGestures.open()`);
  await sleep(800);
  const picked = await js(`(()=>{
    var rows=document.querySelectorAll('[class*="sessionRow"]');
    var pick=null;
    for(var i=0;i<rows.length;i++){ if(!/selected/.test(String(rows[i].className))){ pick=rows[i]; break; } }
    if(!pick) return JSON.stringify({none:true,total:rows.length});
    var t=(pick.innerText||"").replace(/\\s+/g," ").slice(0,30);
    pick.click();
    return JSON.stringify({none:false,total:rows.length,text:t});
  })()`);
  out("  clicked row: " + JSON.stringify(picked) + "   active before=" + before);
  check("found a non-active session row to open", picked && picked.none === false, JSON.stringify(picked));

  await sleep(12000);
  const after = await js(`JSON.stringify({
    sid:(function(){var e=document.querySelector("[data-conversation-session]");return e?String(e.getAttribute("data-conversation-session")):"none";})(),
    drawer:(window.__dshGestures?window.__dshGestures.drawerState():null),
    flow:(function(){var f=document.querySelector("[data-chat-flow]");return f?{kids:f.childElementCount,text:(f.innerText||"").length}:null;})(),
    auto:(window.__dshAutoCollapse?window.__dshAutoCollapse.state():null),
    hotErrs:(window.__dshHotErrors||[]).length,
    body:(document.body.innerText||"").replace(/\\s+/g," ").slice(0,70)
  })`);
  out("  after: " + JSON.stringify(after));

  check("active session changed to the clicked one", after.sid !== before && after.sid !== "none",
        before + " -> " + after.sid);
  check("drawer auto-closed after opening (60-autocollapse)", after.drawer === "closed", "drawer=" + after.drawer);
  check("conversation rendered (chat flow has content)",
        !!(after.flow && (after.flow.kids > 0 || after.flow.text > 0)), JSON.stringify(after.flow));
  check("no hotpatch errors", after.hotErrs === 0, "hotErrs=" + after.hotErrs);
  check("console errors = 0", errs.length === 0, errs.slice(0, 3).join(" | ") || "(none)");

  if (SHOT) {
    const s = await send("Page.captureScreenshot", { format: "png" });
    if (s && s.data) { fs.writeFileSync(SHOT, Buffer.from(s.data, "base64")); out("  screenshot: " + SHOT + " (" + fs.statSync(SHOT).size + " B)"); }
  }

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
