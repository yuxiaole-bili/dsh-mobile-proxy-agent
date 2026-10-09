// 假设验证：mux 断线重连之后，客户端还会不会再开 speech/follow？
// 若不再开，readiness.connected 会永久停在 false —— 手机上就一直"语音识别尚未就绪"。
// 只读：不点麦克风、不改数据。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9236;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-vrec-"));
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

const lines = [];
const out = (s) => { console.log(s); lines.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
    let d = ""; r.on("data", (c) => d += c);
    r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

const SPY = `
(function(){
  try{
    window.__wsLog=[];window.__wsSocks=[];
    var OW=window.WebSocket;
    function push(dir,data){
      try{
        var s=typeof data==="string"?data:("[binary]");
        if(/speech\\/follow|"providers"/.test(s)){
          window.__wsLog.push({dir:dir,d:s.slice(0,260),t:Date.now(),closed:false});
        }
      }catch(e){}
    }
    window.WebSocket=new Proxy(OW,{construct:function(t,args){
      var s=new t(args[0],args[1]);
      window.__wsSocks.push(s);
      try{
        var send=s.send.bind(s);
        s.send=function(d){push("OUT",d);return send(d);};
        s.addEventListener("message",function(ev){push("IN",ev.data);});
        s.addEventListener("close",function(){window.__wsLog.push({dir:"CLOSE",d:"socket closed",t:Date.now()});});
      }catch(e){}
      return s;
    }});
  }catch(e){window.__wsSpyErr=String(e);}
})();
`;

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
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setUserAgentOverride", { userAgent: UA });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: SPY });
  await send("Page.navigate", { url: BASE });
  await sleep(15000);

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
    return r && r.result ? r.result.value : null;
  };

  out("== 阶段 1：初次加载（未断线）==");
  out("  " + (await ev(`JSON.stringify({socks:window.__wsSocks.length, frames:window.__wsLog.length, speechOpen:window.__wsLog.filter(function(f){return f.dir==="OUT";}).length, catalogIn:window.__wsLog.filter(function(f){return f.dir==="IN"&&/"providers"/.test(f.d);}).length})`)));

  out("== 阶段 2：强制关闭 mux，等 20 秒看是否重开 ==");
  const closed = await ev(`(function(){var n=0;window.__wsSocks.forEach(function(s){try{if(s.readyState===1||s.readyState===0){s.close();n++;}}catch(e){}});return n;})()`);
  out("  关闭的 socket 数: " + closed);
  await sleep(20000);
  out("  " + (await ev(`JSON.stringify({socks:window.__wsSocks.length, speechOut:window.__wsLog.filter(function(f){return f.dir==="OUT";}).length, catalogIn:window.__wsLog.filter(function(f){return f.dir==="IN"&&/"providers"/.test(f.d);}).length, closes:window.__wsLog.filter(function(f){return f.dir==="CLOSE";}).length})`)));

  out("== 全量帧时间线（speech/follow 相关）==");
  const log = await ev(`JSON.stringify(window.__wsLog||[])`);
  let arr = [];
  try { arr = JSON.parse(log); } catch (e) { out("  parse fail"); }
  const t0 = arr.length ? arr[0].t : 0;
  for (const f of arr) out("  +" + String(f.t - t0).padStart(6) + "ms  " + f.dir + "  " + f.d);

  out("== 结论判据 ==");
  const outs = arr.filter((x) => x.dir === "OUT").length;
  const inCatalog = arr.filter((x) => x.dir === "IN" && /"providers"/.test(x.d)).length;
  out("  speech/follow 开帧次数 = " + outs + "，catalog 回帧次数 = " + inCatalog);
  out((outs >= 2 && inCatalog >= 2) ? "  → 断线后会重开这条流（假设不成立）" : "  → 断线后没有再开（假设成立：connected 会永久停在 false）");

  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => {
  out("ERR " + (e && e.stack || e));
  if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} }
  try { edge.kill(); } catch (_) {}
  process.exit(1);
});
