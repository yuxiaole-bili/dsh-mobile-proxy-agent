// 回归测试：30-rboverlay 的"有内容"判据必须足够严格
//   A 全新加载、没开预览 -> 标记必须为空（= 界面不会被盖住）
//   B 右栏里塞一个"只有报错文案"的预览框 -> 标记仍须为空（真机事故场景）
//   C 真打开文件预览 -> 标记置 1 且图片可见
//   D 关闭 -> 标记撤销
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9255;
const BASE = process.argv[2];
const OUT = process.argv[3];
const NEEDLE = process.argv[4] || "t54_ortho3b";
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-rbreg-"));
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

const SNAP = `JSON.stringify({
  flag:document.documentElement.getAttribute("data-dsh-rb"),
  on:(window.__dshRbOverlay?window.__dshRbOverlay.state().on:null),
  cols:(function(){var f=document.querySelector('[class*="frame"]');if(!f)return null;
    var k=[].slice.call(f.children),o=[];
    for(var i=0;i<k.length;i++){var r=k[i].getBoundingClientRect();o.push(String(k[i].className||'').slice(0,18)+':'+Math.round(r.width)+'@'+Math.round(r.left));}
    return o;})(),
  visibleCenter:(function(){var c=document.querySelector('[class*="centerCol"]');if(!c)return null;
    var r=c.getBoundingClientRect();return r.width>100&&r.left>=0;})()
})`;

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
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 110));
  };
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

  out("== A. 全新加载、未开预览 ==");
  await sleep(6000);
  const a = await js(SNAP);
  out("  " + JSON.stringify(a));
  check("A: 标记为空（界面不会被盖住）", a.flag === null && a.on === false, "flag=" + a.flag);
  check("A: 会话正文可见", a.visibleCenter === true, String(a.visibleCenter));
  check("A: 右栏仍是 0 宽（未展开）", String(a.cols.join("|")).indexOf("rightbarCol:0@") >= 0, JSON.stringify(a.cols));

  out("== B. 右栏里只有报错文案（真机事故场景）==");
  const injected = await ev(`(()=>{
    var f=document.querySelector('[class*="frame"]'),rb=null,k=f?f.children:[];
    for(var i=0;i<k.length;i++){if(String(k[i].className).indexOf('rightbarCol')>=0)rb=k[i];}
    if(!rb) return "no-rightbar";
    var box=document.createElement('div');
    box.className='TdjKvG_preview';
    box.style.cssText='width:320px;height:420px;display:flex;align-items:center;justify-content:center';
    box.textContent='文件资源服务不可用';
    rb.appendChild(box);
    return "injected";})()`);
  out("  注入: " + JSON.stringify(injected));
  await sleep(3000);
  const b = await js(SNAP);
  out("  " + JSON.stringify(b));
  check("B: 只有报错文案时仍不打标记", b.flag === null && b.on === false, "flag=" + b.flag);
  check("B: 界面依然可见", b.visibleCenter === true, String(b.visibleCenter));

  // 清掉注入的假面板
  await ev(`(()=>{var e=document.querySelector('.TdjKvG_preview');if(e&&e.parentNode)e.parentNode.removeChild(e);return true;})()`);
  await sleep(1200);

  out("== C. 真打开文件预览 ==");
  // 逐个会话找含目标文件的
  let ok = false;
  for (const idx of [0, 1, 2, 3, 4, 5, 6, 7]) {
    await ev(`(()=>{try{window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(600);
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${idx}]){r[${idx}].click();return true;}return false;})()`);
    await sleep(8500);
    if (await ev(`(document.body.innerText||'').indexOf(${JSON.stringify(NEEDLE)})>=0`)) { ok = true; break; }
  }
  check("C: 进入含目标文件的会话", ok);
  await ev(`(()=>{var b=document.querySelector('button[class*="_fileMention"]');if(b)b.click();return !!b;})()`);
  await sleep(3500);
  const c = await js(SNAP);
  const cImg = await js(`(function(){var e=document.querySelector('img[src^="blob:"]');if(!e)return null;var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left),w:Math.round(r.width)});})()`);
  out("  " + JSON.stringify(c) + "  img=" + JSON.stringify(cImg));
  check("C: 真预览时打标记", c.flag === "1", "flag=" + c.flag);
  let img = null; try { img = typeof cImg === "string" ? JSON.parse(cImg) : cImg; } catch (e) {}
  check("C: 图片在屏幕内可见", !!img && img.x >= -1 && img.x < 360 && img.w > 100, JSON.stringify(img));

  out("== D. 关闭 ==");
  await ev(`(()=>{var rb=document.querySelector('[class*="rightbarCol"]');if(rb){while(rb.firstChild)rb.removeChild(rb.firstChild);}return true;})()`);
  await sleep(2500);
  const d = await js(SNAP);
  out("  " + JSON.stringify(d));
  check("D: 标记撤销、界面回来", d.flag === null && d.visibleCenter === true, "flag=" + d.flag + " center=" + d.visibleCenter);

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
