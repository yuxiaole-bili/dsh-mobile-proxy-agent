// 验证 dsh-mobile-kit 插件两半边：
//  A) host 半边：Node 动态 import + 假 ctx，检查 export 形状、路由注册、handler 真跑
//  B) client 半边：无头浏览器里模拟 Chrome 114（先删 withResolvers/findLast）+ 假 __ModuleLoader__
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PLUGIN = path.join(__dirname, "..", "plugin");
const HOST = path.join(PLUGIN, "lib", "host.js");
const CLIENT = path.join(PLUGIN, "lib", "client.js");
const results = [];
const check = (n, ok, d) => { results.push([n, !!ok]); console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  | " + d : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function verifyHost() {
  console.log("== A. host 半边 ==");
  let mod;
  try {
    mod = await import("file:///" + HOST.replace(/\\/g, "/"));
  } catch (e) {
    check("host.js 可被 import", false, String(e));
    return;
  }
  check("host.js 可被 import", true);
  check("导出 apply/inject/name", typeof mod.apply === "function" && Array.isArray(mod.inject) && typeof mod.name === "string",
        "name=" + mod.name + " inject=" + JSON.stringify(mod.inject));
  check("inject 声明 webServer", mod.inject.indexOf("webServer") >= 0, JSON.stringify(mod.inject));

  const routes = [];
  const effects = [];
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    get() { return undefined; },
    effect(fn) { effects.push(1); const d = fn(); return typeof d === "function" ? d : () => {}; },
  };
  try {
    mod.apply(ctx);
  } catch (e) {
    check("apply() 不抛异常", false, String(e));
    return;
  }
  check("apply() 不抛异常", true);
  check("注册了两条路由", routes.length === 2, JSON.stringify(routes.map((r) => r.kind + " " + r.path)));
  check("路由在 /mobile-kit 下", routes.every((r) => r.path.indexOf("/mobile-kit/") === 0));

  const res = () => ({ status: 0, headers: null, body: "", writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } });
  const health = routes.find((r) => r.path.endsWith("/health"));
  const r1 = res();
  await health.handler({ url: "/mobile-kit/health" }, r1);
  check("GET /mobile-kit/health 返回 200 JSON", r1.status === 200 && r1.body.indexOf('"ok":true') >= 0, r1.body.slice(0, 80));

  const info = routes.find((r) => r.path.endsWith("/info"));
  const r2 = res();
  await info.handler({ url: "/mobile-kit/info" }, r2);
  let parsed = null;
  try { parsed = JSON.parse(r2.body); } catch (e) {}
  check("GET /mobile-kit/info 返回本机 IPv4 列表", r2.status === 200 && parsed && Array.isArray(parsed.addresses) && parsed.addresses.length > 0,
        parsed ? ("addresses=" + JSON.stringify(parsed.addresses.slice(0, 4))) : r2.body.slice(0, 120));
}

async function verifyClient() {
  console.log("== B. client 半边（无头模拟 Chrome 114）==");
  const src = fs.readFileSync(CLIENT, "utf8");
  const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const PORT = 9243;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-plug-"));
  const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const getJson = (p) => new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej);
  });
  try {
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
    await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36" });
    await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 3, mobile: true });
    const ev = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r && r.exceptionDetails) return { __error: String(r.exceptionDetails.text || "") };
      return r && r.result ? r.result.value : null;
    };
    // 模拟 Chrome 114：删掉两个新 API，并装上假 ModuleLoader
    await ev(`(()=>{try{Object.defineProperty(Promise,'withResolvers',{value:undefined,writable:true,configurable:true});}catch(e){}
      try{delete Array.prototype.findLast;}catch(e){}
      window.__loaded=null;
      window.__ModuleLoader__={load:function(cfg){window.__loaded=cfg;}};
      return true;})()`);
    const before = await ev(`JSON.stringify({wr:typeof Promise.withResolvers, fl:typeof Array.prototype.findLast})`);
    check("注入前 withResolvers/findLast 确实缺失", before.indexOf('"wr":"undefined"') > 0 && before.indexOf('"fl":"undefined"') > 0, before);

    const injected = await ev(src + "\n;!!window.__loaded");
    check("client.js 注册到 __ModuleLoader__", injected === true, JSON.stringify(injected).slice(0, 120));
    const idOk = await ev(`window.__loaded && window.__loaded.id`);
    check("模块 id 与包名一致（dsh-mobile-kit）", idOk === "dsh-mobile-kit", String(idOk));

    const applied = await ev(`(()=>{try{var m=window.__loaded.factory(function(){});window.__m=m;m.apply();
      return JSON.stringify({name:m.name,inject:m.inject,state:window.__dshMobileKit.state()});}catch(e){return 'ERR '+e;}})()`);
    check("factory + apply() 不抛异常", String(applied).indexOf("ERR ") !== 0, String(applied).slice(0, 160));
    let st = null;
    try { st = JSON.parse(applied).state; } catch (e) {}
    check("polyfill 生效：withResolvers 回来了", st && st.withResolvers === "function", st ? String(st.withResolvers) : applied);
    check("polyfill 生效：AbortSignal.any 回来了", st && st.abortAny === "function", st ? String(st.abortAny) : "");
    check("移动端 CSS 已注入", st && st.css === true, st ? String(st.css) : "");
    check("console 无报错", errs.length === 0, errs.slice(0, 2).join(" | ") || "(none)");
    edge.kill();
  } catch (e) {
    check("client 半边验证流程", false, String(e && e.stack || e));
    try { edge.kill(); } catch (_) {}
  }
}

(async () => {
  console.log("插件目录: " + PLUGIN);
  console.log("package.json: " + JSON.stringify(JSON.parse(fs.readFileSync(path.join(PLUGIN, "package.json"), "utf8")).name));
  await verifyHost();
  await verifyClient();
  const ok = results.filter((r) => r[1]).length;
  console.log("\n== SUMMARY: " + ok + "/" + results.length + " PASS ==");
  const failed = results.filter((r) => !r[1]).map((r) => r[0]);
  if (failed.length) console.log("FAILED: " + failed.join(" | "));
  process.exit(failed.length ? 1 : 0);
})();
