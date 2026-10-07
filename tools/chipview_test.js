// 验收 45-chipview.js：点文件 chip 走自己的预览层
//   由于首屏只渲染最近 10 条消息，老的图片 chip 常不在 DOM 里，这里注入一个
//   与真实 chip **同类名**的合成按钮，专测"title 为空、只有文件名"这条路径。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9258;
const BASE = process.argv[2];
const OUT = process.argv[3];
const IMG = process.argv[4] || "t54_ortho3b.png";
const TXT = process.argv[5] || "LESSONS.md";
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-chipv2-"));
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
    if (m.method === "Network.requestWillBeSent") {
      const u = m.params.request.url;
      if (u.indexOf("/favicon") < 0 && u.indexOf("alert-chime") < 0 && u.indexOf("/__health") < 0) reqs.push(m.params.request.method + " " + u.replace(/k=[^&]*/, "k=***").slice(0, 110));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 120));
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
  const boot = await js(`JSON.stringify({cv:!!window.__dshChipView, fv:!!(window.__dshFileView&&window.__dshFileView.open),
    hotErrs:(window.__dshHotErrors||[]).length})`);
  out("  " + JSON.stringify(boot));
  check("45-chipview 已装载", boot.cv === true);
  check("预览层可用", boot.fv === true);
  check("hotpatch 无错误", boot.hotErrs === 0);

  const mkChip = (name) => `(()=>{
    var old=document.getElementById("synth-chip"); if(old&&old.parentNode)old.parentNode.removeChild(old);
    var b=document.createElement("button");
    b.type="button"; b.id="synth-chip";
    b.className="_fileMention_1ypvv_85 _fileLink_1ypvv_59";
    b.textContent=${JSON.stringify(name)};
    b.style.cssText="position:fixed;left:8px;top:120px;z-index:2147483644;padding:6px 10px;background:#243;color:#fff;border:1px solid #456;border-radius:6px";
    document.body.appendChild(b);
    return b.textContent;})()`;

  out("== A. 图片 chip（title 为空，只有文件名）==");
  out("  注入: " + JSON.stringify(await ev(mkChip(IMG))));
  reqs.length = 0;
  await ev(`document.getElementById("synth-chip").click()`);
  await sleep(4000);
  const a = await js(`JSON.stringify({
    overlay:(function(){var e=document.getElementById("dsh-fv");return e?e.style.display:null;})(),
    img:(function(){var e=document.querySelector("#dsh-fv img");if(!e)return null;var r=e.getBoundingClientRect();
      return {src:String(e.getAttribute("src")||"").slice(0,64),x:Math.round(r.left),w:Math.round(r.width)};})(),
    cv:(window.__dshChipView?window.__dshChipView.state():null),
    rb:(function(){var f=document.querySelector('[class*="frame"]');if(!f)return null;var k=[].slice.call(f.children),o=[];
      for(var i=0;i<k.length;i++){var r=k[i].getBoundingClientRect();o.push(String(k[i].className||'').slice(0,16)+':'+Math.round(r.width));}return o;})()
  })`);
  out("  " + JSON.stringify(a));
  check("A: 我的浮层打开了", a.overlay === "flex", "display=" + a.overlay);
  check("A: 图片在屏幕内可见", !!a.img && a.img.x >= -1 && a.img.x < 360 && a.img.w > 100, JSON.stringify(a.img));
  check("A: 接管计数 +1", a.cv && a.cv.taken === 1, JSON.stringify(a.cv && { taken: a.cv.taken, last: a.cv.last }));
  check("A: DSH 自带右栏预览未被打开", (a.rb || []).some((s) => /rightbar/i.test(String(s)) && Number(String(s).split(":")[1]) === 0), JSON.stringify(a.rb));
  const fReq = reqs.filter((u) => u.indexOf("/f?path=") >= 0);
  check("A: 向 /f 取了文件", fReq.length > 0, fReq.slice(0, 2).join(" | ") || "(none)");
  check("A: 取的就是这张图（裸文件名）", fReq.some((u) => decodeURIComponent(u).indexOf(IMG) >= 0), JSON.stringify(fReq.slice(0, 2)));

  out("== B. 文本 chip ==");
  await ev(`(()=>{var e=document.getElementById("dsh-fv");if(e)e.style.display="none";return true;})()`);
  await sleep(400);
  reqs.length = 0;
  out("  注入: " + JSON.stringify(await ev(mkChip(TXT))));
  await ev(`document.getElementById("synth-chip").click()`);
  await sleep(4000);
  const b = await js(`JSON.stringify({
    overlay:(function(){var e=document.getElementById("dsh-fv");return e?e.style.display:null;})(),
    text:(function(){var e=document.querySelector("#dsh-fv pre,#dsh-fv textarea,#dsh-fv div");return e?String(e.textContent||"").slice(0,60):null;})(),
    cv:(window.__dshChipView?window.__dshChipView.state():null)})`);
  out("  " + JSON.stringify(b));
  check("B: 文本 chip 也走我的浮层", b.overlay === "flex", "display=" + b.overlay);
  check("B: 接管计数 2", b.cv && b.cv.taken === 2, JSON.stringify(b.cv && { taken: b.cv.taken, last: b.cv.last }));

  out("== C. 非 chip 点击必须放行 ==");
  const passed = await ev(`(()=>{var hit=false;
    var d=document.createElement("button");d.id="plain-btn";d.textContent="plain";
    d.addEventListener("click",function(){hit=true;});
    document.body.appendChild(d);d.click();
    var r=document.getElementById("plain-btn");if(r&&r.parentNode)r.parentNode.removeChild(r);
    return hit;})()`);
  check("C: 普通按钮点击不被吞", passed === true, String(passed));

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
