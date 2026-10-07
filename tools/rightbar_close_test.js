// 全屏预览必须有出口：列出右栏里的按钮，点"关闭"类按钮，确认覆盖层撤销、正文回来。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9250;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-rbc-"));
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
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); } };
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

  let ok = false;
  for (const idx of [0, 1, 2, 3]) {
    await ev(`(()=>{try{window.__dshGestures.open();}catch(e){}return true;})()`);
    await sleep(600);
    await ev(`(()=>{var r=document.querySelectorAll('[class*="sessionRow"]');if(r[${idx}]){r[${idx}].click();return true;}return false;})()`);
    await sleep(8500);
    if (await ev(`(document.body.innerText||'').indexOf('t80_')>=0`)) { ok = true; break; }
  }
  check("进入会话", ok);
  await ev(`(()=>{var b=document.querySelector('button[class*="_fileMention"]');if(b)b.click();return !!b;})()`);
  await sleep(2600);
  const opened = await js(`JSON.stringify({flag:document.documentElement.getAttribute('data-dsh-rb')})`);
  check("预览已全屏打开", opened.flag === "1", JSON.stringify(opened));

  const btns = await js(`(()=>{
    var rb=document.querySelector('[class*="rightbarCol"]'); if(!rb) return JSON.stringify({none:true});
    var b=rb.querySelectorAll('button,[role="button"],a[href]'),o=[];
    for(var i=0;i<b.length&&o.length<14;i++){
      var e=b[i],r=e.getBoundingClientRect();
      if(r.width<8||r.height<8)continue;
      o.push({tag:e.tagName,txt:(e.textContent||'').trim().slice(0,12),
              aria:String(e.getAttribute('aria-label')||'').slice(0,14),
              title:String(e.getAttribute('title')||'').slice(0,14),
              cls:String(e.className||'').slice(0,22),x:Math.round(r.left),y:Math.round(r.top)});}
    return JSON.stringify(o);})()`);
  out("== 右栏里的可点元素 ==");
  out("  " + JSON.stringify(btns));

  // 点最像"关闭"的那个
  const closed = await ev(`(()=>{
    var rb=document.querySelector('[class*="rightbarCol"]'); if(!rb) return null;
    var b=rb.querySelectorAll('button,[role="button"],a[href]'),pick=null;
    for(var i=0;i<b.length;i++){var e=b[i];
      var s=((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+(e.textContent||'')+' '+String(e.className||'')).toLowerCase();
      if(/close|关闭|收起|✕|×|dismiss/.test(s)){pick=e;break;}}
    if(!pick && b.length) pick=b[0];
    if(!pick) return null;
    var info=(pick.getAttribute('aria-label')||pick.getAttribute('title')||(pick.textContent||'').trim()).slice(0,20);
    pick.click(); return info;})()`);
  out("  clicked close-ish: " + JSON.stringify(closed));
  await sleep(2600);
  const after = await js(`JSON.stringify({
    flag:document.documentElement.getAttribute('data-dsh-rb'),
    chat:(function(){var f=document.querySelector('[class*="frame"]');if(!f)return null;var k=[].slice.call(f.children),o=[];
      for(var i=0;i<k.length;i++){var r=k[i].getBoundingClientRect();o.push(String(k[i].className||'').slice(0,18)+':'+Math.round(r.width));}return o;})()})`);
  out("  " + JSON.stringify(after));
  check("点关闭后覆盖层撤销", after.flag === null, "flag=" + after.flag);

  // 兜底：Android 返回键（原生 back）也应该能退出 —— 这里用 history.back 近似
  const backOk = await js(`JSON.stringify({hasBack:!!(window.__dshHot&&window.__dshHot.call)})`);
  out("  原生桥可用（返回键路径）: " + JSON.stringify(backOk));

  const pass = results.filter((r) => r[1]).length;
  out("\n== SUMMARY: " + pass + "/" + results.length + " PASS ==");
  const failed = results.filter((r) => !r[1]).map((r) => r[0]);
  if (failed.length) out("FAILED: " + failed.join(" | "));
  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => {
  out("ERR " + (e && e.stack || e));
  if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} }
  try { edge.kill(); } catch (_) {}
  process.exit(1);
});
