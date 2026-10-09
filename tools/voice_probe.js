// 决定性实验：手机 UA 下加载 App，抓 /api/remote.mux 上 speech/follow 的双向帧。
// 只读：不点麦克风、不改任何数据。
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9235;
const BASE = process.argv[2];
const OUT = process.argv[3];
const UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/Pixel 6; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 移动浏览器.0.5735.196 Mobile Safari/537.36";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-voice-"));
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
    window.__wsLog=[];window.__wsStat={sockets:0,frames:0};
    var OW=window.WebSocket;
    function push(dir,data,url){
      try{
        var s=typeof data==="string"?data:("[binary "+(data&&data.byteLength||0)+"B]");
        window.__wsStat.frames++;
        if(/speech|providerId|preparation|transcri/i.test(s)){
          window.__wsLog.push({dir:dir,url:String(url||"").slice(-24),d:(/providers/.test(s)?s.slice(0,4000):s.slice(0,420)),t:Date.now()});
          if(window.__wsLog.length>120){window.__wsLog.shift();}
        }
      }catch(e){}
    }
    window.WebSocket=new Proxy(OW,{construct:function(t,args){
      var s=new t(args[0],args[1]);
      window.__wsStat.sockets++;
      try{
        var send=s.send.bind(s);
        s.send=function(d){push("OUT",d,args[0]);return send(d);};
        s.addEventListener("message",function(ev){push("IN",ev.data,args[0]);});
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
  let id = 0; const pending = new Map(); const errs = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push((m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 170));
    if (m.method === "Runtime.exceptionThrown") errs.push("EXC: " + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text || "").slice(0, 200));
  };
  await new Promise((r) => { ws.onopen = r; });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setUserAgentOverride", { userAgent: UA });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: SPY });
  await send("Page.navigate", { url: BASE });
  await sleep(20000);

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
    return r && r.result ? r.result.value : null;
  };

  out("== 环境 ==");
  out("  " + (await ev(`JSON.stringify({hot:!!window.__dshHot,keeper:!!window.__dshKeeper,pager:!!window.__dshPager,gest:!!window.__dshGestures,fileview:!!window.__dshFileView,auto:!!window.__dshAutoCollapse,mediaDevices:!!(navigator.mediaDevices),MR:typeof MediaRecorder,nativeBridge:!!window.__DSHVoice,spyErr:window.__wsSpyErr||null})`)));

  out("== 流里的 catalog（关键：preparation.phase）==");
  out("  " + (await ev(`(()=>{
    for(var i=0;i<(window.__wsLog||[]).length;i++){
      var f=window.__wsLog[i];
      if(f.dir==="IN"&&/"providers"/.test(f.d)){
        try{var j=JSON.parse(f.d);
          return JSON.stringify({prov:(j.value.providers||[]).map(function(p){return {id:p.id,phase:(p.preparation||{}).phase,steps:((p.preparation||{}).steps||[]).map(function(s){return s.kind+":"+s.status;})};}),sel:j.value.selection,maxAudioBytes:j.value.maxAudioBytes,maxDurationSeconds:j.value.maxDurationSeconds});
        }catch(e){return "parse-fail "+e+" :: "+f.d.slice(0,300);}
      }
    }
    return "(没抓到 catalog 帧)";
  })()`)));

  out("== WS 统计 ==");
  out("  " + (await ev(`JSON.stringify(window.__wsStat)`)));

  out("== 含 speech/目录 的帧（双向）==");
  const log = await ev(`JSON.stringify(window.__wsLog||[])`);
  let arr = [];
  try { arr = JSON.parse(log); } catch (e) { out("  parse fail: " + log); }
  if (!arr.length) out("  (没有任何相关帧)");
  for (const f of arr.slice(0, 40)) {
    out("  " + f.dir + "  " + f.d);
  }
  out("  帧总数(相关) = " + arr.length);
  const outs = arr.filter((x) => x.dir === "OUT").length, ins = arr.filter((x) => x.dir === "IN").length;
  out("  OUT=" + outs + "  IN=" + ins);
  out("== 控制台错误 ==");
  out("  " + (errs.slice(0, 5).join(" | ") || "(none)"));

  if (OUT) fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  edge.kill();
  process.exit(0);
})().catch((e) => {
  out("ERR " + (e && e.stack || e));
  if (OUT) { try { fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8"); } catch (_) {} }
  try { edge.kill(); } catch (_) {}
  process.exit(1);
});
