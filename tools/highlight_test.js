// 验收"代码上色"：合成 chip 打开不同语言，检查真的产出着色 span
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9259;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-hl-"));
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

  out("== 0. 装载 ==");
  out("  " + JSON.stringify(await js(`JSON.stringify({cv:!!window.__dshChipView,fv:!!(window.__dshFileView&&window.__dshFileView.open),hotErrs:(window.__dshHotErrors||[]).length})`)));
  check("45-chipview 已装载", (await ev(`!!window.__dshChipView`)) === true);

  const mkChip = (name) => `(()=>{
    var old=document.getElementById("synth-chip"); if(old&&old.parentNode)old.parentNode.removeChild(old);
    var b=document.createElement("button");
    b.type="button"; b.id="synth-chip";
    b.className="_fileMention_1ypvv_85 _fileLink_1ypvv_59";
    b.textContent=${JSON.stringify(name)};
    b.style.cssText="position:fixed;left:8px;top:120px;z-index:2147483644;padding:6px 10px;background:#243;color:#fff;border:1px solid #456;border-radius:6px";
    document.body.appendChild(b); return b.textContent;})()`;

  const openChip = async (name) => {
    await ev(`(()=>{var e=document.getElementById("dsh-fv");if(e)e.style.display="none";var p=document.querySelector("#dsh-fv pre");if(p)p.innerHTML="";return true;})()`);
    await ev(mkChip(name));
    await ev(`document.getElementById("synth-chip").click()`);
    await sleep(4000);
    return js(`JSON.stringify({
      disp:(function(){var e=document.getElementById("dsh-fv");return e?e.style.display:null;})(),
      title:(function(){var t=document.querySelector("#dsh-fv [data-dsh-fv=\\"title\\"]")||document.querySelector("#dsh-fv div");return t?String(t.textContent||"").slice(0,60):null;})(),
      pre:(function(){var p=document.querySelector("#dsh-fv pre");if(!p)return null;
        var spans=p.querySelectorAll('span[class^="dsh-hl-"]');
        var counts={};for(var i=0;i<spans.length;i++){var c=spans[i].className;counts[c]=(counts[c]||0)+1;}
        return {spans:spans.length,counts:counts,chars:(p.textContent||"").length,
                ws:getComputedStyle(p).whiteSpace, first:spans.length?String(spans[0].textContent).slice(0,24):null};})(),
      hasWrap:!!document.querySelector('#dsh-fv [data-dsh-fv="wrap"]')
    })`);
  };

  out("== A. Python 文件（section.py，裸文件名）==");
  const a = await openChip("section.py");
  out("  " + JSON.stringify(a));
  check("A: 打开的是浮层", a.disp === "flex", "display=" + a.disp);
  check("A: 用了 <pre> 文本层（不是 iframe）", !!a.pre, JSON.stringify(a.pre && { spans: a.pre.spans }));
  check("A: 有明显数量的着色 span", a.pre && a.pre.spans >= 20, a.pre ? ("spans=" + a.pre.spans + " counts=" + JSON.stringify(a.pre.counts)) : "");
  check("A: 有关键字着色", a.pre && a.pre.counts && a.pre.counts["dsh-hl-kw"] > 0, JSON.stringify(a.pre && a.pre.counts));
  check("A: 有字符串或注释着色", a.pre && a.pre.counts && ((a.pre.counts["dsh-hl-str"] || 0) + (a.pre.counts["dsh-hl-com"] || 0)) > 0, JSON.stringify(a.pre && a.pre.counts));
  check("A: 标题显示语言", String(a.title || "").indexOf("Python") >= 0, String(a.title));
  check("A: 有换行按钮", a.hasWrap === true);

  out("== B. 换行按钮 ==");
  const wrapBefore = (a.pre || {}).ws;
  await ev(`document.querySelector('#dsh-fv [data-dsh-fv="wrap"]').click()`);
  await sleep(500);
  const wrapAfter = await ev(`(function(){var p=document.querySelector("#dsh-fv pre");return getComputedStyle(p).whiteSpace;})()`);
  out("  white-space: " + wrapBefore + " -> " + wrapAfter);
  check("B: 换行开关生效", wrapBefore === "pre" && wrapAfter === "pre-wrap", wrapBefore + " -> " + wrapAfter);
  await ev(`document.querySelector('#dsh-fv [data-dsh-fv="wrap"]').click()`);
  await sleep(300);

  out("== C. Markdown 文件（LESSONS.md）==");
  const c = await openChip("LESSONS.md");
  out("  " + JSON.stringify(c));
  check("C: 打开的是浮层", c.disp === "flex", "display=" + c.disp);
  check("C: 标题显示 Markdown", String(c.title || "").indexOf("Markdown") >= 0, String(c.title));
  check("C: 有 Markdown 专用着色（标题/代码）", c.pre && c.pre.counts && ((c.pre.counts["dsh-hl-h"] || 0) + (c.pre.counts["dsh-hl-str"] || 0) + (c.pre.counts["dsh-hl-b"] || 0)) > 0, JSON.stringify(c.pre && c.pre.counts));

  out("== D. 图片仍走 <img>（回归）==");
  await ev(`(()=>{var e=document.getElementById("dsh-fv");if(e)e.style.display="none";return true;})()`);
  await ev(mkChip("t54_ortho3b.png"));
  await ev(`document.getElementById("synth-chip").click()`);
  await sleep(3500);
  const d = await js(`JSON.stringify({
    disp:(function(){var e=document.getElementById("dsh-fv");return e?e.style.display:null;})(),
    img:(function(){var e=document.querySelector("#dsh-fv img");if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left),w:Math.round(r.width)};})(),
    pre:(function(){var p=document.querySelector("#dsh-fv pre");return p?getComputedStyle(p).display:null;})()
  })`);
  out("  " + JSON.stringify(d));
  check("D: 图片仍然正常显示", d.disp === "flex" && !!d.img && d.img.w > 100, JSON.stringify(d.img));
  check("D: 图片模式下文本层已隐藏", d.pre === "none", "pre display=" + d.pre);

  out("== E. 先看图、再点代码（真机截图里的顺序）==");
  await ev(`(()=>{var e=document.getElementById("dsh-fv");if(e)e.style.display="none";return true;})()`);
  await ev(mkChip("t54_ortho3b.png"));
  await ev(`document.getElementById("synth-chip").click()`);
  await sleep(3500);
  const e1 = await js(`JSON.stringify({img:(function(){var e=document.querySelector("#dsh-fv img");if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left),w:Math.round(r.width)};})()})`);
  out("  先看图: " + JSON.stringify(e1));
  check("E: 图片先正常显示", !!e1.img && e1.img.w > 100, JSON.stringify(e1.img));

  await ev(mkChip("tool/game/mesh_check.py"));
  await ev(`document.getElementById("synth-chip").click()`);
  await sleep(4500);
  const e2 = await js(`JSON.stringify({
    disp:(function(){var e=document.getElementById("dsh-fv");return e?e.style.display:null;})(),
    pre:(function(){var p=document.querySelector("#dsh-fv pre");if(!p)return null;
      return {shown:getComputedStyle(p).display, spans:p.querySelectorAll('span[class^="dsh-hl-"]').length,
              chars:(p.textContent||"").length, head:String(p.textContent||"").slice(0,40)};})(),
    imgShown:(function(){var e=document.querySelector("#dsh-fv img");return e?getComputedStyle(e).display:null;})(),
    status:(function(){var e=document.querySelector("#dsh-fv [data-dsh-fv=\\"status\\"]")||document.querySelectorAll("#dsh-fv > div")[1];
      return e?{disp:getComputedStyle(e).display,txt:String(e.textContent||"").slice(0,60)}:null;})()
  })`);
  out("  " + JSON.stringify(e2));
  check("E: 代码文本层显示出来了", !!e2.pre && e2.pre.shown !== "none" && e2.pre.spans > 20, JSON.stringify(e2.pre && { shown: e2.pre.shown, spans: e2.pre.spans }));
  check("E: 残留的 <img> 已隐藏", e2.imgShown === "none", "img display=" + e2.imgShown);
  check("E: 没有出现『打不开这个图片』错误", !e2.status || e2.status.disp === "none" || String(e2.status.txt || "").indexOf("打不开") < 0, JSON.stringify(e2.status));

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
