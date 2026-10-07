// 验收 30-rboverlay.js + 00-base.css：
//   1) 未打开预览时绝不能有全屏覆盖（标记必须是空的、会话正文可见）
//   2) 点文件 chip 后：标记=1、预览面板进屏幕内（blob 图 x<360 且宽>100）
//   3) 预览内容消失后：标记撤销、正文恢复
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9249;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-rbv-"));
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
  let id = 0; const pending = new Map(); const errs = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 120));
    if (m.method === "Runtime.exceptionThrown") errs.push("EXC " + String((m.params.exceptionDetails.exception || {}).description || "").slice(0, 130));
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

  const SNAP = `JSON.stringify({
    rb:(window.__dshRbOverlay?window.__dshRbOverlay.state():null),
    flag:document.documentElement.getAttribute('data-dsh-rb'),
    blob:(function(){var e=document.querySelector('img[src^="blob:"]');if(!e)return null;
      var r=e.getBoundingClientRect();return {x:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height)};})(),
    chat:(function(){var f=document.querySelector('[class*="frame"]');if(!f)return null;
      var k=[].slice.call(f.children),o=[];
      for(var i=0;i<k.length;i++){var r=k[i].getBoundingClientRect();
        o.push(String(k[i].className||'').slice(0,20)+':'+Math.round(r.width)+'@'+Math.round(r.left));}
      return o;})(),
    cookie:(window.__dshMobileKit?1:0)
  })`;

  out("== 0. 补丁装载 ==");
  const loaded = await js(`JSON.stringify({rb:!!window.__dshRbOverlay,hotErrs:(window.__dshHotErrors||[]).length})`);
  out("  " + JSON.stringify(loaded));
  check("30-rboverlay 已装载", loaded.rb === true);
  check("hotpatch 无错误", loaded.hotErrs === 0);

  // 找含目标文件名的会话
  let ok = false;
  for (const idx of [0, 1, 2, 3]) {
    await ev(`(()=>{try{window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(600);
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${idx}]){r[${idx}].click();return true;}return false;})()`);
    await sleep(8500);
    if (await ev(`(document.body.innerText||'').indexOf('t80_')>=0`)) { ok = true; break; }
  }
  check("进入含目标文件的会话", ok);

  out("== 1. 未打开预览时（不能有全屏覆盖）==");
  const before = await js(SNAP);
  out("  " + JSON.stringify(before));
  check("标记为空（不会挡住界面）", before.flag === null && before.rb && before.rb.on === false, "flag=" + before.flag);
  check("会话正文列可见", String(before.chat && before.chat.join("|")).indexOf("centerCol") >= 0, JSON.stringify(before.chat));

  out("== 2. 点文件 chip ==");
  const clicked = await ev(`(()=>{var b=document.querySelector('button[class*="_fileMention"]');
    if(!b)return null;var t=(b.textContent||'').trim().slice(0,24);b.click();return t;})()`);
  out("  clicked: " + JSON.stringify(clicked));
  await sleep(2600);
  const after = await js(SNAP);
  out("  " + JSON.stringify(after));
  check("标记置 1（右栏有内容）", after.flag === "1" && after.rb.on === true, "flag=" + after.flag);
  check("预览图片进入屏幕内", !!after.blob && after.blob.x >= -1 && after.blob.x < 360 && after.blob.w > 100,
        JSON.stringify(after.blob));
  // 覆盖层判定：起点 <=0 且 右缘 >=360（层被刻意左移 57px，所以 x 为负是正常的）
  const m = String(after.chat && after.chat.join("|")).match(/rightbarCol:(\d+)@(-?\d+)/);
  const covers = !!m && Number(m[2]) <= 0 && Number(m[2]) + Number(m[1]) >= 360;
  check("右栏覆盖整个视口", covers, m ? ("w=" + m[1] + " x=" + m[2] + " -> " + (Number(m[2]) + Number(m[1]))) : JSON.stringify(after.chat));

  out("== 3. 预览内容消失后（标记要撤销）==");
  await ev(`(()=>{var f=document.querySelector('[class*="frame"]');
    var rb=null,k=f?f.children:[];for(var i=0;i<k.length;i++){if(String(k[i].className).indexOf('rightbarCol')>=0)rb=k[i];}
    if(rb){while(rb.firstChild)rb.removeChild(rb.firstChild);}return true;})()`);
  await sleep(2000);
  const cleared = await js(SNAP);
  out("  " + JSON.stringify(cleared));
  check("标记撤销（不再覆盖界面）", cleared.flag === null && cleared.rb.on === false, "flag=" + cleared.flag);

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
