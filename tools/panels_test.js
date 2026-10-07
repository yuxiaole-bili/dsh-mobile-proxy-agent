// 验收 40-panels.js：入口按钮、浮层、探活换地址、iframe 真加载、✕ 与返回键关闭
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9251;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-panels-"));
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=360,780", "about:blank"], { stdio: "ignore" });

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
  let id = 0; const pending = new Map(); const reqs = []; const errs = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Network.requestWillBeSent") reqs.push(m.params.request.url);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 120));
    if (m.method === "Runtime.exceptionThrown") errs.push("EXC " + String((m.params.exceptionDetails.exception || {}).description || "").slice(0, 130));
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

  out("== 0. 补丁装载 ==");
  const boot = await js(`JSON.stringify({p:!!window.__dshPanels, btn:!!document.getElementById("dsh-panels-btn"),
    hotErrs:(window.__dshHotErrors||[]).length, host:(window.__dshPanels?window.__dshPanels.state().host:null),
    cands:(window.__dshPanels?window.__dshPanels.state().candidates:null)})`);
  out("  " + JSON.stringify(boot));
  check("40-panels 已装载", boot.p === true);
  check("右下角入口按钮存在", boot.btn === true);
  check("hotpatch 无错误", boot.hotErrs === 0);

  out("== 1. 点按钮打开浮层 ==");
  reqs.length = 0;
  await ev(`document.getElementById("dsh-panels-btn").click()`);
  await sleep(4200);
  const opened = await js(`JSON.stringify({st:window.__dshPanels.state(),
    disp:document.getElementById("dsh-panels").style.display,
    status:(document.querySelector('#dsh-panels [data-dsh-panels="status"]')||{}).textContent||document.getElementById("dsh-panels").children[2].textContent})`);
  out("  " + JSON.stringify(opened));
  check("浮层已打开（全屏）", opened.disp === "flex" && opened.st.opened === true, "display=" + opened.disp);
  check("默认主机是当前页面主机", opened.st.host === "<PC-LAN-IP>", String(opened.st.host));

  out("== 2. 换地址到服务器 <SRV-LAN-IP> ==");
  reqs.length = 0;
  // 逐个换到 <SRV-LAN-IP>
  for (let i = 0; i < 6; i += 1) {
    const h = await ev(`window.__dshPanels.state().host`);
    if (h === "<SRV-LAN-IP>") break;
    await ev(`document.querySelector('#dsh-panels [data-dsh-panels="addr"]').click()`);
    await sleep(4200);
  }
  const after = await js(`JSON.stringify({st:window.__dshPanels.state(),
    status:(function(){var e=document.getElementById("dsh-panels");return (e.children[2].style.display==="none")?"":e.children[2].textContent;})()})`);
  out("  " + JSON.stringify(after));
  check("地址切到 <SRV-LAN-IP>", after.st.host === "<SRV-LAN-IP>", String(after.st.host));
  check("iframe 指向该面板", String(after.st.frameSrc) === "http://<SRV-LAN-IP>:9090/", String(after.st.frameSrc));
  const frameReq = reqs.filter((u) => u.indexOf("<SRV-LAN-IP>:9090") >= 0);
  check("浏览器真的请求了面板页", frameReq.length > 0, frameReq.slice(0, 2).join(" | ") || "(none)");
  check("可达时不显示报错", after.status === "", JSON.stringify(after.status));

  out("== 3. 切标签页 ==");
  reqs.length = 0;
  await ev(`document.querySelector('#dsh-panels [data-dsh-panels="tab-10110"]').click()`);
  await sleep(4200);
  const tab2 = await js(`JSON.stringify({src:window.__dshPanels.state().frameSrc, tab:window.__dshPanels.state().tab})`);
  out("  " + JSON.stringify(tab2));
  check("切到 10110 后 iframe 跟随", String(tab2.src) === "http://<SRV-LAN-IP>:10110/", String(tab2.src));

  out("== 4. 关闭：✕ 与返回键 ==");
  await ev(`document.querySelector('#dsh-panels [data-dsh-panels="close"]').click()`);
  await sleep(600);
  const closed = await js(`JSON.stringify({disp:document.getElementById("dsh-panels").style.display, opened:window.__dshPanels.state().opened})`);
  check("✕ 关闭生效", closed.disp === "none" && closed.opened === false, JSON.stringify(closed));

  await ev(`document.getElementById("dsh-panels-btn").click()`);
  await sleep(4200);
  const backHandled = await ev(`(function(){var opened=window.__dshPanels.state().opened;
    var r=window.__dshNativeBack?window.__dshNativeBack():null;
    return JSON.stringify({openedBefore:opened, returned:r, openedAfter:window.__dshPanels.state().opened});})()`);
  out("  " + backHandled);
  let bh = null; try { bh = JSON.parse(backHandled); } catch (e) {}
  check("返回键关闭浮层（返回 true 表示已消费）", bh && bh.returned === true && bh.openedAfter === false, String(backHandled));

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
