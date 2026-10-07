"""DSH GUI reverse proxy: capability gate + per-authority signed session cookie injection.

Cookie algorithm (from app.asar):
  name  = "dsh-auth-" + base64url(sha256(authority))          # authority = Host header
  value = "v1." + base64url(json{version,authority,issuedAt,expiresAt}) + "." + base64url(HMAC-SHA256(secret, body))
secret = 32 random bytes in ~/.dsh/.credentials.yaml (client-connection/browser-session record).

Authority is taken from each request's Host header, so the same proxy works for the tailnet
IPv4 address, the tailnet IPv6 address, or any other address the client happens to use.
"""
import asyncio
import base64
import datetime
import mimetypes
import urllib.parse
import gzip
import hashlib
import hmac
import json
import os
import re
import secrets
import time

try:
    import brotli  # optional: better ratio than gzip for the huge plugin bundles
except Exception:
    brotli = None

D = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(D, "proxy.log")
KEY_FILE = os.path.join(D, "cap.key")
# 监听地址：默认绑所有网卡，让手机无论走"局域网直连"还是"VPN/服务器转发"都能到。
# 只想绑某个地址时用环境变量覆盖，例如 DSH_LISTEN_HOST=<PC-LAN-IP>。
# （鉴权不受影响：除 /__health 外所有路由都要访问密钥。）
LISTEN = (os.environ.get("DSH_LISTEN_HOST", "0.0.0.0"),
          int(os.environ.get("DSH_LISTEN_PORT", "19390")))
TARGET = ("127.0.0.1", 19387)

# --- ES2019 degraded plugin bundles -------------------------------------------------
# The /plugins/?? combo bundles are several MB of modern JS. The Huawei P40 WebView
# (Chrome 114) reports "bundle script <url> failed to load" for them, so the phone keeps
# re-downloading ~5 MB forever. DSH_ES2019_DIR holds esbuild --target=es2019 copies of
# exactly the same files that are preinstalled in the APK (appassets/index.json), so the
# APK and the proxy serve byte-identical bodies. Set DSH_ES2019=0 to disable.
ES2019_DIR = os.path.join(D, "plugins_es2019")
ES2019_ON = os.environ.get("DSH_ES2019", "1") != "0"
ES2019_IDX = {}
ES2019_REV = re.compile(r"[?&]rev=[^&]*")
ES2019_CACHE = {}
CREDS = os.path.join(os.environ["USERPROFILE"], ".dsh", ".credentials.yaml")
DAYS = 30
RENEW_AFTER = 20 * 86400000
CAP_COOKIE = "dshcap"
HEALTH_PATH = "/__health"
MOBILE_PATH = "/m"
# Browser-issued requests that can never carry the access key: the Web-App-Manifest
# and the implicit /favicon.ico probe are fetched by the browser without ?k= or the
# dshcap cookie, so gating them only produced guaranteed-403 noise in the log.
# EXACT matches only - every other path still requires the key, and these two are
# still proxied upstream (never served from here).
GATE_EXEMPT_PATHS = ("/manifest.webmanifest", "/favicon.ico")
# 最近一次见到的 alert-chime 事件序号（用于防止重连时 since=0 重放历史闹钟）
CHIME_STATE = {"seq": None}
MOBILE_FILE = os.path.join(D, "mobile.html")


# --- 手机端"连接守夜人" --------------------------------------------------------------
# 注入到页面最前面（与 polyfill 同一个 <head> 顺序），把 WS 重连的退避上限压小，
# 并暴露 window.__dshKeeper.poke()：APK onResume 时一次轻量调用就能把连接唤起来，
# 不需要整页 reload。纯前端、幂等、失败无害。
MOBILE_KEEPER = """<script id="dsh-keeper">(function(){
  var W=window;
  try{
    var rc=W.__DSH_CONNECTION_RECOVERY__;
    if(rc===void 0||rc===null||typeof rc!=="object"){rc={};}
    if(rc.backoffBaseMs===void 0){rc.backoffBaseMs=300;}
    if(rc.backoffFactor===void 0){rc.backoffFactor=1.6;}
    if(rc.backoffMaxMs===void 0){rc.backoffMaxMs=2500;}
    rc.backoffBaseMs=300;rc.backoffFactor=1.6;rc.backoffMaxMs=2500;
    W.__DSH_CONNECTION_RECOVERY__=rc;
    var RC={base:300,factor:1.6,max:2500};
    var rcWrites=0;
    var cur=rc;
    function fix(v){
      if(v===void 0||v===null||typeof v!=="object"){v={};}
      if(typeof v.backoffBaseMs!=="number"||v.backoffBaseMs>RC.base){v.backoffBaseMs=RC.base;}
      if(typeof v.backoffFactor!=="number"||v.backoffFactor>RC.factor){v.backoffFactor=RC.factor;}
      if(typeof v.backoffMaxMs!=="number"||v.backoffMaxMs>RC.max){v.backoffMaxMs=RC.max;}
      return v;
    }
    Object.defineProperty(W,"__DSH_CONNECTION_RECOVERY__",{
      configurable:true,
      enumerable:true,
      get:function(){return cur;},
      set:function(v){rcWrites++;cur=fix(v);}
    });
    W.__dshRcWrites=function(){return rcWrites;};
  }catch(e){}
  var S={ready:0,lastPoke:0,lastMethod:"none",pokes:0,ws:{opened:0,closed:0,frames:0},dbg:{online:0,vis:0,err:null}};
  W.__dshKeeper=S;
  S.generation=function(){return -1;};
  S.state=function(){return null;};
  function poke(){
    var now=Date.now();
    if(now-S.lastPoke<3000){return "debounced";}
    S.lastPoke=now;S.pokes++;
    S.lastMethod="online";
    try{
      if(W.fetch){
        W.fetch("/__health?_="+now,{cache:"no-store",headers:{"X-DSH-Wake":"1"}}).then(
          function(r){S.dbg.wake=r.status;},
          function(e){S.dbg.wakeErr=String(e);});
      }
    }catch(e){S.dbg.err=String(e);}
    try{W.dispatchEvent(new Event("online"));S.dbg.online++;}catch(e){S.dbg.err=String(e);}
    return "poked";
  }
  S.poke=poke;
  function onVisible(){
    S.dbg.vis++;
    try{if(document.visibilityState==="visible"){setTimeout(poke,150);}}catch(e){}
  }
  try{document.addEventListener("visibilitychange",onVisible);}catch(e){}
  try{W.addEventListener("pageshow",function(){S.dbg.vis++;setTimeout(poke,400);});}catch(e){}
  try{
    var OW=W.WebSocket;
    if(OW&&!OW.__dshCounted&&W.Proxy){
      var NW=new W.Proxy(OW,{construct:function(t,args){
        var s=new t(args[0],args[1]);
        S.ws.opened++;
        try{
          s.addEventListener("close",function(){S.ws.closed++;});
          s.addEventListener("message",function(){S.ws.frames++;});
        }catch(e){}
        return s;
      }});
      try{NW.__dshCounted=1;}catch(e){}
      W.WebSocket=NW;
    }
  }catch(e){}
  S.ready=1;
})();</script>"""

# --- 需求 B：客户端"自动续载"（window.__dshPager） -----------------------------------
# 代理把 session/page 的 maxMessages 默认压到 10，所以打开一个长会话时首屏只有最近 10 条。
# 本脚本挂在 window 上，自己驱动剩下的分页：
#   * 钩 fetch，识别 POST /api/session/page，从请求体里取出 sessionId 并测量这次往返的耗时；
#   * 首屏页成功且耗时 < 10s、且该会话的自动续载次数 < 5 时，点 App 自己渲染的
#     "加载更早 / Load earlier" 按钮（ChatView / TrajectoryView 都有这个入口）；
#     找不到按钮才退化成"把消息容器滚到顶 + 派发 scroll 事件"；
#   * 每次续载都要重新满足"成功 + < 10s + 次数 < 5"，任一条不满足就停止自动续载
#     （只是不再自动；手动滚动/点按钮照旧可以继续加载）。
#   * 次数按 sessionId 累计、写 localStorage（dsh.pager.v1），永久保留，直到 reset()。
# 纯 ASCII、无 bare catch、幂等注入（id="dsh-pager" + __installed 双保险）、失败无害。
MOBILE_PAGER = r"""<script id="dsh-pager">(function(){
var W=window;
if(W.__dshPager&&W.__dshPager.__installed){return;}
var LIMIT=5,SLOW=10000,REQWAIT=12000,RESPWAIT=30000,POLL=200,POLLS=25,GATE=60,MINCLICK=300;
var LKEY="dsh.pager.v1";
var OLDER=["\u52a0\u8f7d\u66f4\u65e9","Load earlier","\u52a0\u8f7d\u66f4\u65e9\u7684\u5386\u53f2","Load earlier history"];
var D={err:null,clicks:0,scrolls:0,starts:0,ends:0,opens:0,snaps:0,wsOpens:0,sendSeen:0,fetchSeen:0,lastUrls:[],notes:[]};
var P={},R={},active=null,timer=null,lastSid=null,domChangeAt=0,autoOn=true;
function note(m){D.notes.push(String(m).slice(0,120));if(D.notes.length>40){D.notes.shift();}}
function pnow(){return (W.performance&&W.performance.now)?W.performance.now():Date.now();}
function load(){try{var s=W.localStorage.getItem(LKEY);if(s){var j=JSON.parse(s);
  if(j&&typeof j==="object"){P=j;}}}catch(err){D.err=String(err);}}
function save(){try{W.localStorage.setItem(LKEY,JSON.stringify(P));}catch(err){D.err=String(err);}}
function rec(sid){var p=P[sid];if(!p||typeof p!=="object"){p={n:0,ms:null,at:null};P[sid]=p;}
  if(typeof p.n!=="number"||p.n<0){p.n=0;}return p;}
function run(sid){var r=R[sid];if(!r){r={chain:false,awaiting:false,awaitingResp:false,tries:0,
  reqs:0,auto:0,lastMs:null,hasMore:null,stop:null,seqs:[],err:null,clickAt:0,reqAt:0,
  wsSentAt:0,openMs:null,snapN:null,snapBytes:null,clickSig:null,lastClickAt:0,
  awaitSnap:false};R[sid]=r;}return r;}
function norm(s){return String(s||"").replace(/\s+/g," ").trim();}
function domSid(){
  try{var e=document.querySelector("[data-conversation-session]");
    if(e){var v=e.getAttribute("data-conversation-session");if(v){return String(v);}}}catch(err){D.err=String(err);}
  return null;
}
function sig(){
  try{
    var f=document.querySelector("[data-chat-flow]");
    if(!f){return null;}
    var t=f.innerText?f.innerText.length:0;
    return f.childElementCount+":"+t;
  }catch(err){D.err=String(err);return null;}
}
function belongs(b,sid){
  var el=b,hop=0,want=null;
  try{
    while(el&&hop<14){
      if(el.getAttribute){
        var v=el.getAttribute("data-conversation-session");
        if(v){want=String(v);break;}
      }
      el=el.parentElement;hop++;
    }
  }catch(err){D.err=String(err);return true;}
  if(want===null){return true;}
  return want===sid;
}
function findButton(sid){
  var list=document.querySelectorAll("button"),i,j,b,t;
  for(i=0;i<list.length;i++){
    b=list[i];
    if(b.disabled||!b.isConnected){continue;}
    t=norm(b.textContent);
    for(j=0;j<OLDER.length;j++){
      if(t===OLDER[j]&&belongs(b,sid)){return b;}
    }
  }
  return null;
}
function findScroller(){
  var all=document.querySelectorAll("[class*=scroll],[class*=Scroll]"),i,e,best=null;
  for(i=0;i<all.length;i++){e=all[i];
    try{if(e.clientHeight>100&&e.scrollHeight-e.clientHeight>40){
      if(!best||e.scrollHeight>best.scrollHeight){best=e;}}}catch(err){D.err=String(err);}}
  return best;
}
function stop(sid,why){
  var r=run(sid);
  r.chain=false;r.awaiting=false;r.awaitingResp=false;r.stop=why;
  if(active===sid){active=null;}
  note("stop:"+why+"@"+String(sid).slice(0,14));
}
function start(sid){
  var r=run(sid),p=rec(sid);
  if(r.chain||p.n>=LIMIT){return;}
  r.chain=true;r.stop=null;r.tries=0;r.clickSig=null;r.lastClickAt=0;
  active=sid;D.starts++;
  note("start@"+String(sid).slice(0,14));
  fire(sid,0);
}
function fire(sid,attempt){
  var r=run(sid),b,sc,s,settled,waited;
  if(!r.chain){return;}
  b=findButton(sid);
  if(b){
    s=sig();
    settled=(r.clickSig===null||s===null||s!==r.clickSig);
    waited=(pnow()-(r.lastClickAt||0))>MINCLICK;
    if(!settled||!waited){
      if(attempt<POLLS+GATE){setTimeout(function(){fire(sid,attempt+1);},POLL);return;}
      stop(sid,"no-settle");
      return;
    }
    r.clickSig=s;r.lastClickAt=pnow();
    r.awaiting=true;r.awaitingResp=false;r.tries++;D.clicks++;r.clickAt=pnow();
    try{b.click();note("click#"+r.tries+"@"+String(sid).slice(0,14));}
    catch(err){r.err=String(err);r.awaiting=false;stop(sid,"click-failed");}
    return;
  }
  if(attempt<POLLS){setTimeout(function(){fire(sid,attempt+1);},POLL);return;}
  sc=findScroller();
  if(sc&&attempt<POLLS+10){
    D.scrolls++;
    try{sc.scrollTop=0;sc.dispatchEvent(new Event("scroll",{bubbles:true}));}
    catch(err){r.err=String(err);}
    setTimeout(function(){fire(sid,attempt+1);},POLL);
    return;
  }
  stop(sid,"no-entry");
}
function maybeStart(sid,ms,hasMore){
  var r=run(sid),p=rec(sid);
  if(r.chain){return;}
  if(!autoOn){r.stop="auto-off";return;}
  if(p.n>=LIMIT){r.stop="limit";return;}
  if(!(typeof ms==="number"&&ms<SLOW)){r.stop="slow-first";return;}
  if(!hasMore){r.stop="no-more";return;}
  start(sid);
}
function sidOf(body){
  if(typeof body!=="string"||!body){return null;}
  var j=null,c=[],a,i,ad;
  try{j=JSON.parse(body);}catch(err){return null;}
  try{
    if(j&&j.payload&&j.payload.args){a=j.payload.args;
      if(a.request){c.push(a.request);}c.push(a);}
    if(j&&j.args){a=j.args;if(a.request){c.push(a.request);}c.push(a);}
    if(j&&j.request){c.push(j.request);}
  }catch(err){D.err=String(err);}
  for(i=0;i<c.length;i++){if(!c[i]){continue;}
    if(c[i].sessionId){return String(c[i].sessionId);}
    ad=c[i].address;if(ad&&ad.sessionId){return String(ad.sessionId);}}
  return null;
}
function infoOf(j){
  try{
    var res=j&&j.result;
    if(!res||typeof res!=="object"){return null;}
    var v=res.value;
    if(!v||!v.records||typeof v.records.length!=="number"){return {ok:!!res.ok,n:0,hasMore:false,seqs:[]};}
    var i,s,seqs=[];
    for(i=0;i<v.records.length;i++){var rr=v.records[i];s=rr&&rr.event?rr.event.seq:null;
      if(typeof s==="number"){seqs.push(s);}}
    return {ok:!!res.ok,n:v.records.length,hasMore:!!v.hasMore,seqs:seqs};
  }catch(err){D.err=String(err);return null;}
}
function onStart(sid,t0){
  var r=run(sid);
  r.reqs++;D.starts++;
  if(r.awaiting){r.awaiting=false;r.awaitingResp=true;r.reqAt=t0;}
}
function onEnd(sid,ms,status,info){
  var r=run(sid),p=rec(sid),i;
  D.ends++;
  r.lastMs=ms;r.lastAt=Date.now();
  if(info&&info.seqs){for(i=0;i<info.seqs.length;i++){r.seqs.push(info.seqs[i]);}
    while(r.seqs.length>900){r.seqs.shift();}}
  if(info){r.hasMore=!!info.hasMore;}
  p.ms=ms;p.at=Date.now();save();
  if(r.awaitingResp){
    r.awaitingResp=false;
    r.auto++;p.n=p.n+1;save();
    if(status!==200||!info||!info.ok){stop(sid,"bad-response");return;}
    if(ms>=SLOW){stop(sid,"slow");return;}
    if(p.n>=LIMIT){stop(sid,"limit");return;}
    if(!info.hasMore){stop(sid,"no-more");return;}
    if(r.chain){fire(sid,0);}
    return;
  }
  if(r.chain){return;}
  if(status!==200||!info||!info.ok){r.stop="bad-first";return;}
  if(info.n<=0){r.stop="empty-first";return;}
  r.openMs=ms;
  maybeStart(sid,ms,!!info.hasMore);
}
function followSid(data){
  if(typeof data!=="string"||data.indexOf("session/follow")<0){return null;}
  var j=null,p,a,req,ad;
  try{j=JSON.parse(data);}catch(err){return null;}
  p=j&&j.payload;a=p&&p.args;req=a&&a.request;ad=req&&req.address;
  if(ad&&ad.sessionId){return String(ad.sessionId);}
  if(req&&req.sessionId){return String(req.sessionId);}
  return null;
}
function snapshotOf(d){
  if(typeof d!=="string"||d.length<40||d.indexOf('"snapshot"')<0){return null;}
  var j=null;
  try{j=JSON.parse(d);}catch(err){return null;}
  var v=j&&j.value;
  if(!v||v.type!=="snapshot"){return null;}
  var sid=(v.header&&v.header.id)?String(v.header.id):null;
  var recs=v.records||[],seqs=[],i,s;
  for(i=0;i<recs.length;i++){s=recs[i]&&recs[i].event?recs[i].event.seq:null;
    if(typeof s==="number"){seqs.push(s);}}
  return {sid:sid,n:recs.length,hasMore:!!v.hasMore,seqs:seqs};
}
function onWsSend(data){
  D.sendSeen++;
  var sid=followSid(data);
  if(!sid){return;}
  var r=run(sid);
  if(!r.awaitSnap){r.wsSentAt=pnow();r.openMs=null;r.snapN=null;r.snapBytes=null;}
  r.awaitSnap=true;
  if(!r.chain){r.stop=null;r.tries=0;}
  D.wsOpens++;
  note("follow@"+sid.slice(0,14));
}
function onWsSnap(info,bytes){
  if(!info||!info.sid){return;}
  var sid=info.sid,r=run(sid),i,base,ms;
  D.snaps++;
  r.snapN=info.n;r.snapBytes=bytes;r.hasMore=info.hasMore;r.awaitSnap=false;
  for(i=0;i<info.seqs.length;i++){r.seqs.push(info.seqs[i]);}
  while(r.seqs.length>900){r.seqs.shift();}
  base=r.wsSentAt>0?r.wsSentAt:domChangeAt;
  ms=base>0?Math.round(pnow()-base):null;
  if(!(typeof r.openMs==="number")){r.openMs=ms;}
  note("snap"+info.n+"@"+sid.slice(0,14));
  if(r.chain||r.awaitingResp){return;}
  maybeStart(sid,ms,info.hasMore);
}
function onWsMessage(d){
  if(typeof d!=="string"||d.length<40||d.indexOf('"snapshot"')<0){return;}
  var info=snapshotOf(d);
  if(info){onWsSnap(info,d.length);}
}
function tapSocket(s){
  try{
    var os=s.send;
    var wrapper=function(data){
      try{onWsSend(data);}catch(err){D.err=String(err);}
      return os.apply(s,arguments);
    };
    try{s.send=wrapper;}catch(err){D.err=String(err);}
    if(s.send!==wrapper){
      try{Object.defineProperty(s,"send",{value:wrapper,writable:true,configurable:true});}
      catch(err){D.err=String(err);}
    }
    s.addEventListener("message",function(ev){
      try{onWsMessage(ev.data);}catch(err){D.err=String(err);}
    });
  }catch(err){D.err=String(err);}
}
function hookWs(){
  var OW=W.WebSocket;
  if(typeof OW!=="function"||OW.__dshPagerWs){return;}
  try{
    if(W.Proxy){
      var NW=new W.Proxy(OW,{construct:function(t,args){
        var s=new t(args[0],args[1]);
        tapSocket(s);
        return s;
      }});
      try{NW.__dshPagerWs=1;}catch(err){D.err=String(err);}
      W.WebSocket=NW;
      return;
    }
  }catch(err){D.err=String(err);}
  D.err="ws hook unavailable";
}
function hookFetch(){
  var of=W.fetch;
  if(typeof of!=="function"||of.__dshPagerHooked){return;}
  var wrapped=function(input,init){
    var url="",method="POST",sid=null,t0=0,isPage=false;
    try{
      if(typeof input==="string"){url=input;}
      else if(input&&input.url){url=input.url;}
      if(init&&init.method){method=String(init.method).toUpperCase();}
      else if(input&&input.method){method=String(input.method).toUpperCase();}
    }catch(err){D.err=String(err);}
    isPage=(method==="POST"&&url.indexOf("api/session/page")>=0);
    D.fetchSeen++;
    if(isPage){
      t0=pnow();
      try{sid=sidOf(init?init.body:null);}catch(err){D.err=String(err);}
      if(sid){onStart(sid,t0);}
    }
    if(D.lastUrls.length>9){D.lastUrls.shift();}
    D.lastUrls.push(String(method)+" "+String(url).slice(0,46)+" page="+(isPage?1:0)
      +" sid="+(sid?String(sid).slice(0,10):"-"));
    var pr=of.apply(this,arguments);
    if(!isPage||!sid||!pr||typeof pr.then!=="function"){return pr;}
    return pr.then(function(res){
      var ms=Math.round(pnow()-t0),st=res&&res.status,clone=null,info=null,fin;
      try{clone=res.clone();}catch(err){D.err=String(err);}
      fin=clone?clone.json().then(function(j){info=infoOf(j);},function(err){D.err=String(err);})
               :Promise.resolve();
      fin.then(function(){onEnd(sid,ms,st,info);},function(){onEnd(sid,ms,st,info);});
      return res;
    },function(err){
      var r=run(sid);r.awaiting=false;r.awaitingResp=false;stop(sid,"fetch-failed");throw err;});
  };
  try{wrapped.__dshPagerHooked=1;}catch(err){D.err=String(err);}
  W.fetch=wrapped;
}
function tick(){
  var sid=active,cur=domSid(),r;
  if(cur!==lastSid){lastSid=cur;domChangeAt=pnow();}
  if(sid&&cur&&cur!==sid){stop(sid,"switched");sid=null;}
  if(sid){
    r=run(sid);
    if(r.awaiting&&r.clickAt&&(pnow()-r.clickAt)>REQWAIT){r.awaiting=false;stop(sid,"no-request");}
    else if(r.awaitingResp&&r.reqAt&&(pnow()-r.reqAt)>RESPWAIT){r.awaitingResp=false;stop(sid,"no-response");}
  }
  timer=setTimeout(tick,POLL);
}
function state(){
  var out={ts:Date.now(),active:active,limit:LIMIT,slowMs:SLOW,domSid:lastSid,installed:1,
    dbg:{err:D.err,clicks:D.clicks,scrolls:D.scrolls,starts:D.starts,ends:D.ends,opens:D.opens,
      snaps:D.snaps,wsOpens:D.wsOpens,sendSeen:D.sendSeen,fetchSeen:D.fetchSeen,
      lastUrls:D.lastUrls.slice(-6),notes:D.notes.slice(-12)}};
  var s={},k,r;
  for(k in P){if(Object.prototype.hasOwnProperty.call(P,k)){
    s[k]={n:P[k].n||0,ms:(typeof P[k].ms==="number"?P[k].ms:null),at:P[k].at||null};}}
  for(k in R){if(!Object.prototype.hasOwnProperty.call(R,k)){continue;}
    if(!s[k]){s[k]={n:(P[k]&&P[k].n)||0,ms:null,at:null};}
    r=R[k];
    s[k].chain=!!r.chain;s[k].stop=r.stop||null;s[k].auto=r.auto;s[k].reqs=r.reqs;
    s[k].lastMs=(typeof r.lastMs==="number"?r.lastMs:null);
    s[k].openMs=(typeof r.openMs==="number"?r.openMs:null);
    s[k].snapN=(typeof r.snapN==="number"?r.snapN:null);
    s[k].snapBytes=r.snapBytes;
    s[k].hasMore=(r.hasMore===null?null:!!r.hasMore);s[k].seqs=r.seqs.slice(-80);}
  out.sessions=s;
  return out;
}
function reset(sid){
  var k,r;
  if(sid){delete P[sid];r=R[sid];
    if(r){r.chain=false;r.awaiting=false;r.awaitingResp=false;r.stop=null;r.tries=0;r.auto=0;}
    if(active===sid){active=null;}}
  else{P={};R={};active=null;}
  save();
  return state();
}
load();
hookWs();
hookFetch();
tick();
W.__dshPager={__installed:1,version:5,state:state,reset:reset,dbg:D,
  setAuto:function(v){autoOn=!!v;return autoOn;}};
})();</script>"""
APK_FILE = os.path.join(D, "DSH.apk")
HOST_REWRITE = "127.0.0.1:19387"
TRIM_PATHS = ("/api/session/list", "/api/session/page")
TRIM_MAX_ITEMS = 60          # max sessions kept in session/list
TRIM_MAX_RECORDS = 20        # max records kept in session/page
TRIM_TEXT = 6000             # assistant text truncation
TRIM_REASON = 1200           # reasoning truncation
TRIM_ARGS = 700              # tool args truncation
TRIM_RESULT = 700           # tool result truncation

# --- POST /api/session/list 侧栏字段白名单 -------------------------------------------
# session/list 单次响应 761 KB，其中 49% 是 projections.values.turnOutline（372 KB）。
#
# 依据（静态取证，均在客户端产物里可复查）：
#  * 必需/可选字段由客户端 zod 校验决定，白名单必须和它逐字对齐，否则整个响应被判非法：
#      dsh-api-session-controller/lib/typert.remote-client.js
#        _deepseek_ai_dsh_api_session_controller_session_list_result$schema
#      以及 dsh-api-remotes/lib/client.js 里同名 schema（线上真正装配的那一份）。
#    必需：sessionId / updatedAt / running / blank，以及 projections.asOfSeq；
#    可选：parentSessionId / origin("subagent") / cwd / projections，
#    而 projections.values 里每一个投影键都是 .optional()。
#  * 侧栏每一行的标题来自 projection store，而首屏只有本响应能播种它：
#      dsh-api-session-controller/lib/client.js  buildListSnapshot():
#        const title = projectionStore?.get("title")
#      refreshList(): for (const key of Object.keys(values)) store.apply(key, ...)
#    => projections.values.title 必须保留（WS 抖动时否则整列退化成 cwd/会话 id）。
#  * cwd 用于工作区归属与 displayTitleOf 兜底；parentSessionId/origin 用于
#    flattenLineage 的父子分节（side bar 的"子代理/会话"分组）。
#  * 被砍掉的 turnOutline / subagentCatalog / tokenUsage / ... 并不丢信息：Host 的
#    全量控制基线对每个 session 都会下发完整投影快照
#      dsh-api-session-controller/lib/index.js  baseline() -> projectionBaseline():
#        sessionProjections.snapshot(session).values
#    并由此播种同一个 projection store（replaceControlBaseline）。
#  * 客户端对 z.object() 的未知键是 strip 而不是报错，所以 agentAvailable /
#    projections.kind 这类 schema 外的字段本来就被丢弃，无需下发。
#
# 之所以用白名单而不是黑名单：上一轮把轻量页的激进裁剪默认套到完整版，缺字段直接
# 让完整版打不开；白名单是"只发我证明过的东西"。
LIST_TRIM_ON = os.environ.get("DSH_LIST_TRIM", "1") != "0"
# 1 = 保留 projections.values.title（默认，侧栏标题不依赖 WS）；
# 0 = 连 title 也不发（响应 ~14 KB，但标题只能等 WS 控制基线，手机 WS 抖动时退化为占位标题）
LIST_TRIM_PROJ = os.environ.get("DSH_LIST_TRIM_PROJ", "1") != "0"
LIST_TRIM_ITEM_KEYS = ("sessionId", "updatedAt", "running", "blank", "cwd",
                       "parentSessionId", "origin", "agentAvailable")
LIST_TRIM_PROJ_KEYS = ("title",)
# projections.kind is REQUIRED and MEANINGFUL: the client switches on it
# ("sequenced" -> store.apply(key, value, asOfSeq), "cached" -> store.applyCached(values)),
# so it must be forwarded verbatim, never normalised. Any other value -> drop the whole
# projections block rather than send a schema-invalid one.
LIST_TRIM_KINDS = ("cached", "sequenced")
# runtime switches, flipped by GET /__listtrim?v=0|1&p=0|1 (debug/regression, key-guarded)
LIST_TRIM_STATE = [LIST_TRIM_ON]
LIST_TRIM_PROJ_STATE = [LIST_TRIM_PROJ]

# --- POST RPC disk cache: /api/session/list + /api/session/page ----------------------
# The frontend polls these two POST endpoints forever (session/list alone is ~314 KB of
# JSON per poll) and no HTTP layer may cache POST. Both are pure reads, so the
# *transformed* response body is cached on disk and keyed on
#   (path, query, trim-flag, request body with the volatile rpcId uuid stripped)
# which is what makes an APK-side prewarm request and the app's own later request
# collide on the same entry.
#   fresh hit (<= TTL)          -> reply from disk, no upstream connection at all
#   stale hit (<= SWR)          -> reply from disk + background refresh (SWR)
#   session/list with a running session -> only a short TTL, never served stale
# Anything unusual (chunked or oversized request body, non-200, unparsable JSON,
# client asking for no-cache) falls straight through to the network.
API_CACHE_ON = os.environ.get("DSH_APICACHE", "1") != "0"
API_CACHE_COMPRESS = os.environ.get("DSH_APICACHE_COMPRESS", "1") != "0"
API_CACHE_PATHS = ("/api/session/list", "/api/session/page")
API_CACHE_DIR = os.path.join(D, "apicache")
API_CACHE_TTL = 20.0        # fresh window (s), mutable entries (the "latest" page)
API_CACHE_TTL_RUN = 4.0     # fresh window while a session is running (live chat!)
API_CACHE_SWR = 90.0        # serve stale up to this age, refresh in background
API_CACHE_KEEP = 600.0      # 比这个还年轻的条目一定没过期 -> 淘汰时跳过读元数据
API_CACHE_MAXREQ = 262144   # never cache a request body bigger than this
# 大请求体（图片消息等）：超过下限就先把客户端整个 body 收完，再连上游。
# 起因 2026-10-04 16:27:41 —— 手机经 Tailscale 上行 ~3 KB/s，980 KB 的图片消息传了
# 317 秒，中途被**上游 DSH 约 300 秒的请求超时**判 408 并断连（clen=980312 have=945560），
# 客户端表现为"消息被吞"。先收完再转发，慢的那段就不算在上游超时里。
REQ_BUFFER_MIN = int(os.environ.get("DSH_REQ_BUFFER_MIN", "262144"))       # 256 KB
REQ_BUFFER_MAX = int(os.environ.get("DSH_REQ_BUFFER_MAX", str(16 * 1024 * 1024)))
API_CACHE_MAXBODY = 3145728  # do not compress a body bigger than this (event-loop hog)

# --- 需求 A：session/page 历史页的"永久"磁盘缓存 ------------------------------------
# 一次 session/page 只要带上了具体的 throughSeq（非负整数），它的回答就是
#   (sessionId, throughSeq, beforeSeq, maxMessages, turnWindow, 裁剪模式)
# 的纯函数：窗口右端钉死在 throughSeq 上，之后新产生的消息 seq 更大，进不了这个窗口。
# 这类条目按"不可变"处理：
#   * 长 TTL（默认 7 天）+ SWR（再 7 天）：命中直接从磁盘回，完全不碰上游；
#   * 顺带把 br/gzip 压缩体一起落盘（<key>.br / <key>.gz 边车文件），第二次起连压缩都省；
#   * 缓存就是 apicache/ 下的普通文件，没有任何内存索引 -> 进程重启后依然有效。
# 只有 throughSeq 缺失或为负（-1 = "最新一页"，会随新消息变化）才继续用 20s/90s 短 TTL。
PAGE_IMM_ON = os.environ.get("DSH_PAGE_IMMCACHE", "1") != "0"
PAGE_IMM_TTL = float(os.environ.get("DSH_PAGE_IMM_TTL", str(7 * 86400.0)))
PAGE_IMM_SWR = float(os.environ.get("DSH_PAGE_IMM_SWR", str(7 * 86400.0)))
# 淘汰策略：① 条目自身 TTL+SWR+GRACE 过期即删；② 目录总字节超过 MAXBYTES 就按 mtime
# （命中即 touch，即 LRU）从最旧开始删到 LOW 水位。上限默认 512 MB。
API_CACHE_MAXBYTES = int(os.environ.get("DSH_APICACHE_MAXBYTES", str(512 * 1024 * 1024)))
API_CACHE_LOW = float(os.environ.get("DSH_APICACHE_LOW", "0.90"))
API_CACHE_GRACE = 300.0
API_CACHE_SWEEP = 25        # 每 N 次写入跑一次淘汰（外加 /__apicache?sweep=1 手动触发）
API_STATS = {"hit": 0, "stale": 0, "miss": 0, "store": 0, "imm_store": 0,
             "evict": 0, "expired": 0, "touched": 0, "ridfix": 0}
CACHE_AGE_HDR = "X-DSH-Cache-Age"

# --- POST /api/session/page 单次分页体积上限 -----------------------------------------
# 手机中继 RTT 300-450ms，且完整历史一屏就要 300+ 条记录（实测 807 KB JSON）。把请求体里的
# maxMessages 压到 <= PAGE_MSG_LIMIT，并同步把 turnWindow.minMessages 压到不超过 maxMessages
# （服务端硬校验："turnWindow.minMessages must be a positive safe integer no greater than
# maxMessages"，只改 maxMessages 会直接 gateway/bad-request），客户端照旧用返回记录里最小的
# seq-1 当 throughSeq 继续向前翻页，所以交互不变、单页体积小一个数量级。
#
# 需求 B：默认从 30 收到 10 —— 打开会话只先拿最近 10 条，剩下交给
# window.__dshPager（见 MOBILE_PAGER）在 <10s 的前提下自动续载，最多 5 次。
# 运行时对照/回滚仍然可用：GET /__pagecap?n=30&k=<key> 或环境变量
# DSH_PAGE_MAX_MESSAGES=30。turnWindow.minMessages 由 cap_page_messages 一并压到 <=10。
PAGE_MAX_MESSAGES = 10
PAGE_MSG_LIMIT = int(os.environ.get("DSH_PAGE_MAX_MESSAGES", str(PAGE_MAX_MESSAGES)) or "10")
PAGE_CAP_APPLIED = [0]        # how many session/page POST bodies were actually rewritten
WS_CAP_APPLIED = [0]          # how many /api/remote.mux frames were actually rewritten
PAGE_MSG_ON = os.environ.get("DSH_PAGE_CAP", "1") != "0"
API_CACHE_VOLATILE = ("rpcId",)   # per-request uuid: must not take part in the key
API_INFLIGHT = set()
API_STORES = [0]


def _dechunk(b):
    """Upstream often replies chunked; unpack before touching JSON."""
    out = b""
    while True:
        i = b.find(b"\r\n")
        if i < 0:
            break
        try:
            size = int(b[:i].split(b";")[0].strip() or b"0", 16)
        except Exception:
            break
        b = b[i + 2:]
        if size == 0:
            break
        out += b[:size]
        b = b[size + 2:]
    return out


def load_es2019_index():
    """Map '/plugins/??...' (rev-insensitive) -> degraded file name."""
    global ES2019_IDX
    m = {}
    try:
        with open(os.path.join(ES2019_DIR, "index.json"), "r", encoding="utf-8") as f:
            for k, v in json.load(f).items():
                m[k] = v
                m[ES2019_REV.sub("", k)] = v
    except Exception as e:
        log("es2019 index load failed: %r" % (e,))
    ES2019_IDX = m
    if m:
        log("es2019 degraded plugin bundles: %d keys from %s" % (len(m), ES2019_DIR))
    return m


def es2019_bundle_file(target):
    """Return the degraded file name for this /plugins/?? target, else None.

    Mirrors MainActivity.shouldInterceptRequest: match on the literal path+query
    first, then retry with the content-hash rev stripped, so a frontend rebuild
    that only changes rev still hits the preinstalled/degraded copy.
    """
    if not ES2019_ON or not target.startswith("/plugins/??"):
        return None
    if not ES2019_IDX:
        load_es2019_index()
    name = ES2019_IDX.get(target) or ES2019_IDX.get(ES2019_REV.sub("", target))
    if name is None:
        return None
    path = os.path.join(ES2019_DIR, name)
    return path if os.path.isfile(path) else None


def es2019_body(path):
    """Cache degraded bundles (the big one is ~10 MB, read once)."""
    b = ES2019_CACHE.get(path)
    if b is None:
        with open(path, "rb") as f:
            b = f.read()
        ES2019_CACHE[path] = b
    return b


MOBILE_ADAPT_CSS = """<style id="dsh-mobile-adapt">
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;width:100%;overflow-x:hidden}
body{overscroll-behavior-y:none;width:100%;overflow-x:hidden}
*{-webkit-tap-highlight-color:transparent}
button,[role="button"],a{touch-action:manipulation}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:3px}
[class*="frame"]{padding-bottom:env(safe-area-inset-bottom,0px)}
@media (max-width:820px){
  /* Keep the app grid: the sidebar column track is 0 and the sidebar itself is a fixed
     overlay drawer, so the body column always keeps the full viewport minus the 56px rail. */

  [class*="frame"]{
    grid-template-columns:0px minmax(0,1fr) 0px !important;
    grid-template-rows:100dvh !important;     /* row height must be explicit once the sidebar leaves flow */
    padding-left:56px !important;      /* reserve the fixed icon rail (outer frame only) */
    padding-right:0 !important;
    box-sizing:border-box !important;
  }
  /* sidebar is fixed: pin the grid columns explicitly or auto-placement puts main col on the 0px track */
  [class*="frame"] [class*="sidebarCol"]{grid-column:1 !important}
  [class*="frame"] [class*="centerCol"]{grid-column:2 !important;min-width:0 !important}

  /* Every sidebar column, at ANY nesting level (the outer app frame AND the inner chat
     frame, whose class is also *sidebarCol*), is a fixed overlay drawer and never occupies
     its grid column. */
  [class*="frame"] [class*="sidebarCol"]{
    position:fixed !important;
    left:0 !important;
    top:0 !important;
    bottom:0 !important;
    right:auto !important;
    height:100dvh !important;
    max-height:100dvh !important;
    margin:0 !important;
    box-sizing:border-box !important;
    z-index:60 !important;
    background:#151517 !important;      /* opaque: no message text bleeding through the drawer */
    box-shadow:0 0 24px rgba(0,0,0,.55) !important;
    padding-top:env(safe-area-inset-top,0px) !important;
    overscroll-behavior:contain !important;
  }

  /* Cap the drawer at a readable-but-not-full width. This needs an explicit width, not just
     max-width: the app persists the last desktop drag width as an INLINE px width on the
     drawer's inner element (observed: style="width:280px"), so with max-width alone the used
     width stays at that inline value (280px) and the drawer eats 72% of a 390px viewport,
     hiding the whole message column behind it. The rule is scoped to the OPEN state
     (data-sidebar-collapsed absent/"false", which the app sets on the frame): applying it
     unconditionally would also stretch the collapsed 56px icon rail to a full drawer. */
  [class*="frame"]:not([data-sidebar-collapsed="true"]) [class*="sidebarCol"]{
    width:min(78vw,320px) !important;
    max-width:min(78vw,320px) !important;
  }
  /* The drawer's inner wrappers must not re-impose the persisted inline px width. */
  [class*="sidebarCol"]>*,[class*="sidebarCol"]>*>*{
    min-width:0 !important;
    max-width:100% !important;
  }

  /* FIX 2026-10: every element whose class contains "frame" inherited the 56px rail
     gutter above. The chat-list frame is a DESCENDANT of the app frame (its class is
     also *frame*), so the gutter landed twice: 56px on the app frame + 56px on the chat
     frame. On a 390px viewport that squeezed the message column to 207px and the
     assistant text to 136px (44% and 35% of the viewport). Only the outer frame keeps
     the gutter; nested frames must not add a second one. */
  [class*="frame"] [class*="frame"]{padding-left:0 !important;padding-right:0 !important}
  /* Reclaim the 2px scrollbar gutter the conversation column reserves on the right. */
  [class*="scrollBody"]{margin-right:0 !important}
  /* Chat list: the app pads it 16px + --dsh-composer-side-clearance (32px) per side for
     desktop. Trim it so the message column fills the column; 6px leaves a hairline
     inset on both sides and stays clear of the 56px icon rail. */
  [class*="scroll"]{padding-left:6px !important;padding-right:6px !important}

  /* Composer: never wider than the column it sits in. */
  [class*="composer"]{max-width:100% !important}
  textarea,input{font-size:16px !important}            /* stop focus zoom */
}
</style>"""
MOBILE_GESTURES = r"""<script id="dsh-gestures">(function(){
var W=window,D=document;
if(W.__dshGestures&&W.__dshGestures.__installed){return;}
var V="1.0";
var EDGE_PX=24,EDGE_SWIPE_PX=60,DRAWER_SWIPE_PX=60,TAB_SWIPE_PX=60,VERT_TOL=40;
var LONG_MS=800,TOAST_MS=1500,DBL_MS=300,DBL_SLOP=30,TOP_PX=88,BACK_GUARD_MS=1500;
var SCROLL_QUIET_MS=250;
var lastScrollAt=0;
var S={version:V,installed:0,registrations:[],errors:[],
  lastGesture:null,lastAt:0,lastCopied:null,lastBack:null,
  drawer:{state:"unknown",width:-1,toggle:null,by:null,gen:0},
  counters:{start:0,end:0,scroll:0,edge:0,drawerSwipe:0,tabSwipe:0,dbl:0,long:0,copied:0,maskTap:0,back:0,backHandled:0},
  flags:{maskShown:0}};
function err(where,e){
  try{
    if(S.errors.length>24){S.errors.shift();}
    S.errors.push({at:Date.now(),where:String(where).slice(0,60),
      msg:String(e&&e.message?e.message:e).slice(0,140)});
  }catch(e2){}
}
function mark(name,extra){
  try{
    S.lastGesture={name:name,at:Date.now()};
    S.lastAt=S.lastGesture.at;
    if(extra){for(var k in extra){if(Object.prototype.hasOwnProperty.call(extra,k)){S.lastGesture[k]=extra[k];}}}
  }catch(e){err("mark",e);}
}
function closest(el,sel){
  try{return (el&&el.closest)?el.closest(sel):null;}catch(e){err("closest",e);return null;}
}
function tagOf(el){try{return el&&el.tagName?el.tagName.toUpperCase():"";}catch(e){return "";}}
function editable(el){
  try{
    if(!el)return false;
    var t=tagOf(el);
    if(t==="INPUT"||t==="TEXTAREA"||t==="SELECT")return true;
    if(el.isContentEditable)return true;
    return !!closest(el,"[contenteditable='true'],[contenteditable='']");
  }catch(e){err("editable",e);return false;}
}
function interactive(el){
  try{
    if(!el)return false;
    if(closest(el,"a,button,[role='button'],[role='link'],[role='tab'],input,textarea,select,summary,label"))return true;
    return editable(el);
  }catch(e){err("interactive",e);return true;}
}
function inputFocused(){
  try{return editable(D.activeElement);}catch(e){err("inputFocused",e);return false;}
}
function isMask(el){try{return !!(el&&el.id==="dsh-gesture-mask");}catch(e){return false;}}
function scrollingNow(){return (Date.now()-lastScrollAt)<SCROLL_QUIET_MS;}
function onScroll(){
  try{lastScrollAt=Date.now();S.counters.scroll++;}catch(e){err("onScroll",e);}
}
/* ---------- drawer ------------------------------------------------------- */
function sidebarEls(){
  try{return D.querySelectorAll('[class*="sidebarCol"]');}catch(e){err("sidebarEls",e);return [];}
}
function drawerEl(){
  try{
    // Anchor on the toggle button: whatever container the app's own sidebar toggle
    // lives in IS the drawer. A stylesheet may keep the container wide even while the
    // app considers the drawer collapsed (observed with a fixed 78vw overlay rule), so
    // "widest sidebarCol" alone cannot be trusted.
    var t=toggleEl();
    if(t){
      var own=closest(t,'[class*="sidebarCol"]');
      if(own)return own;
    }
    var all=sidebarEls(),i,r,best=null,bw=-1,h=W.innerHeight||800;
    for(i=0;i<all.length;i++){
      r=all[i].getBoundingClientRect();
      if(r.height>=h*0.5&&r.width>bw){bw=r.width;best=all[i];}
    }
    return best||(all.length?all[0]:null);
  }catch(e){err("drawerEl",e);return null;}
}
function labelState(){
  try{
    var t=toggleEl();
    if(!t)return null;
    var al=(t.getAttribute("aria-label")||"")+" "+(t.getAttribute("title")||"");
    if(/\u6536\u8d77|collapse|close/i.test(al))return "open";
    if(/\u6253\u5f00|expand|open/i.test(al))return "closed";
    var ae=t.getAttribute("aria-expanded");
    if(ae==="true")return "open";
    if(ae==="false")return "closed";
  }catch(e){err("labelState",e);}
  return null;
}
function drawerState(){
  try{
    var d=drawerEl();
    if(d){S.drawer.width=Math.round(d.getBoundingClientRect().width);}
    var ls=labelState();
    if(ls){S.drawer.by="label";return ls;}
    if(d){
      var r=d.getBoundingClientRect(),cs=getComputedStyle(d);
      S.drawer.by="geometry";
      if(cs.display==="none"||cs.visibility==="hidden")return "closed";
      // last resort only: a rail-style drawer stays under ~35% of the viewport
      if(r.left+r.width<=Math.round(W.innerWidth*0.35))return "closed";
      return "open";
    }
  }catch(e){err("drawerState",e);}
  return "unknown";
}
function toggleEl(){
  try{
    var bs=D.querySelectorAll("button,[role='button']"),i,b,al,r,sc,best=null,bestScore=-1;
    for(i=0;i<bs.length;i++){
      b=bs[i];
      al=(b.getAttribute("aria-label")||"")+" "+(b.getAttribute("title")||"")+" "+((typeof b.className==="string")?b.className:"");
      if(!/sidebar|\u4fa7\u8fb9\u680f|\u4fa7\u680f/i.test(al))continue;
      if(/right|rightsidebar|\u53f3\u4fa7/i.test(al))continue;
      r=b.getBoundingClientRect();
      if(r.width<8||r.height<8)continue;
      sc=(/toggle/i.test(al)?2:0)+(r.left<70?1:0);
      if(sc>bestScore){bestScore=sc;best=b;}
    }
    return best;
  }catch(e){err("toggleEl",e);return null;}
}
function toggleDrawer(name){
  try{
    var d0=drawerState();
    if(d0==="unknown"){err("toggleDrawer","state unknown");return false;}
    var t=toggleEl();
    if(!t){err("toggleDrawer","no toggle button");return false;}
    S.drawer.toggle=String(t.className).slice(0,48);
    S.drawer.gen=(S.drawer.gen||0)+1;
    var gen=S.drawer.gen;
    t.click();
    mark(name,{from:d0,gen:gen});
    setTimeout(function(){
      try{
        // Another toggle overtook us: never "correct" someone else's click, that is how
        // a retry turns into a ping-pong (open->close->open) under fast input.
        if(S.drawer.gen!==gen)return;
        var d1=drawerState();
        S.drawer.state=d1;
        if(d1===d0){
          S.drawer.gen=gen+1;
          t.click();
        }
        setTimeout(function(){try{S.drawer.state=drawerState();syncMask();}catch(e){err("postToggle",e);}},330);
      }catch(e){err("verifyToggle",e);}
    },340);
    return true;
  }catch(e){err("toggleDrawer",e);return false;}
}
function doOpen(name){try{return drawerState()==="closed"?toggleDrawer(name):false;}catch(e){err("doOpen",e);return false;}}
function doClose(name){try{return drawerState()==="open"?toggleDrawer(name):false;}catch(e){err("doClose",e);return false;}}
function onMaskClick(ev){
  try{
    S.counters.maskTap++;
    if(ev&&ev.stopPropagation)ev.stopPropagation();
    if(drawerState()==="open"){mark("maskTap",{});doClose("maskClose");}
  }catch(e){err("onMaskClick",e);}
}
function syncMask(){
  try{
    var st=drawerState();
    S.drawer.state=st;
    var m=D.getElementById("dsh-gesture-mask"),d=drawerEl(),w=-1;
    if(st==="open"&&d){w=Math.round(d.getBoundingClientRect().width);}
    if(st!=="open"||w<=0||w>=W.innerWidth-4){
      if(m&&m.style.display!=="none"){m.style.display="none";S.flags.maskShown=0;}
      return;
    }
    if(!m){
      m=D.createElement("div");
      m.id="dsh-gesture-mask";
      m.setAttribute("data-dsh-gesture","1");
      m.style.cssText="position:fixed;top:0;bottom:0;right:0;background:rgba(0,0,0,.22);"+
        "z-index:59;border:0;padding:0;margin:0;touch-action:pan-y;";
      m.addEventListener("click",onMaskClick,true);
      (D.body||D.documentElement).appendChild(m);
      S.registrations.push("click@dsh-gesture-mask/cancelable");
    }
    m.style.left=w+"px";
    m.style.display="block";
    S.flags.maskShown=1;
  }catch(e){err("syncMask",e);}
}
/* ---------- tabs --------------------------------------------------------- */
function tabList(){
  var out=[],seen={};
  try{
    var i,e,t,list=D.querySelectorAll('[role="tab"],[class*="tab"]');
    for(i=0;i<list.length;i++){
      e=list[i];
      t=(e.textContent||"").replace(/\s+/g,"").trim();
      if(t!=="\u5bf9\u8bdd"&&t!=="\u8f68\u8ff9")continue;
      var k=t+"|"+String(e.className);
      if(seen[k])continue;
      seen[k]=1;
      out.push({el:e,t:t,sel:e.getAttribute("aria-selected"),active:/Active|_active/.test(String(e.className))});
    }
  }catch(e){err("tabList",e);}
  return out;
}
function switchTab(dir){
  try{
    var ts=tabList(),i,idx=-1;
    if(ts.length<2)return false;
    for(i=0;i<ts.length;i++){if(ts[i].sel==="true"||ts[i].active){idx=i;}}
    if(idx<0)idx=0;
    var nx=idx+dir;
    if(nx<0)nx=0;
    if(nx>ts.length-1)nx=ts.length-1;
    if(nx===idx)return false;
    ts[nx].el.click();
    mark("tabSwipe",{from:ts[idx].t,to:ts[nx].t});
    return true;
  }catch(e){err("switchTab",e);return false;}
}
function conversationVisible(){
  try{
    if(tabList().length>=2)return true;
    return !!D.querySelector('[class*="flowItem"]');
  }catch(e){err("conversationVisible",e);return false;}
}
/* ---------- message text + copy ------------------------------------------ */
function readText(el){
  try{
    var t=(el.innerText||el.textContent||"");
    t=t.replace(/\u00a0/g," ").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
    return t;
  }catch(e){err("readText",e);return "";}
}
function msgEl(el){
  try{
    var a=el,i=0,c,fallback=null;
    while(a&&a!==D.body&&i<40){
      c=(typeof a.className==="string")?a.className:"";
      if(/flowItem/.test(c))return a;
      if(!fallback&&/bubble|message|msg/i.test(c))fallback=a;
      a=a.parentElement;i++;
    }
    return fallback;
  }catch(e){err("msgEl",e);return null;}
}
var toastT=null;
function toast(msg){
  try{
    var el=D.getElementById("dsh-gesture-toast");
    if(!el){
      el=D.createElement("div");
      el.id="dsh-gesture-toast";
      el.setAttribute("data-dsh-gesture","1");
      el.style.cssText="position:fixed;left:50%;bottom:12%;transform:translateX(-50%);max-width:78vw;"+
        "background:rgba(20,20,22,.92);color:#fff;font:14px/1.4 -apple-system,system-ui,sans-serif;"+
        "padding:10px 14px;border-radius:10px;z-index:2147483000;pointer-events:none;opacity:0;"+
        "transition:opacity .18s ease;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.4)";
      (D.body||D.documentElement).appendChild(el);
      S.registrations.push("toast#dsh-gesture-toast");
    }
    el.textContent=String(msg);
    el.style.opacity="1";
    if(toastT){clearTimeout(toastT);}
    toastT=setTimeout(function(){try{el.style.opacity="0";}catch(e){err("toastHide",e);}},TOAST_MS);
  }catch(e){err("toast",e);}
}
function copyDone(txt,how,ok){
  try{
    S.lastCopied={how:how,len:txt.length,head:txt.slice(0,60),ok:!!ok,at:Date.now(),stored:txt.slice(0,8000)};
    S.counters.copied++;
    mark("longPressCopy",{how:how,len:txt.length,ok:!!ok});
    toast(ok?"\u5df2\u590d\u5236\u6d88\u606f":"\u590d\u5236\u5931\u8d25");
    return S.lastCopied;
  }catch(e){err("copyDone",e);return null;}
}
function nativeClipboard(){
  try{
    // navigator.clipboard only exists in a secure context. The polyfill installs a
    // stub there too (it resolves unconditionally), which would hide real failures,
    // so on an insecure origin we always use our own execCommand path and keep its
    // true return value. On https/localhost the native API is used.
    if(W.isSecureContext!==true)return null;
    var nc=(W.navigator&&navigator.clipboard)?navigator.clipboard:null;
    if(nc&&typeof nc.writeText==="function")return nc;
  }catch(e){err("nativeClipboard",e);}
  return null;
}
function copyText(txt,how){
  try{
    if(!txt)return;
    var nc=nativeClipboard();
    if(nc){
      nc.writeText(txt).then(
        function(){copyDone(txt,how+"+clipboardApi",1);},
        function(e){err("clipboard",e);copyFallback(txt,how);});
      return;
    }
  }catch(e){err("clipboardCall",e);}
  copyFallback(txt,how);
}
function copyFallback(txt,how){
  try{
    var ta=D.createElement("textarea");
    ta.value=txt;
    ta.setAttribute("data-dsh-gesture","1");
    ta.style.cssText="position:fixed;left:-9999px;top:0;opacity:0;";
    (D.body||D.documentElement).appendChild(ta);
    ta.focus();
    ta.select();
    var selOk=0;
    try{selOk=(ta.value.length===txt.length&&ta.selectionEnd===txt.length)?1:0;}catch(e){err("selCheck",e);}
    var ok=0;
    try{if(D.execCommand("copy"))ok=1;}catch(e){err("execCommand",e);}
    (D.body||D.documentElement).removeChild(ta);
    var r=copyDone(txt,how+"+execCommand",ok);
    try{S.lastCopied.selected=selOk;}catch(e){err("selStore",e);}
    return r;
  }catch(e){err("copyFallback",e);copyDone(txt,how+"+error",0);}
}
/* ---------- touch state machine ------------------------------------------ */
var T={id:null,x0:0,y0:0,x1:0,y1:0,t0:0,el:null,edge:false,done:false,long:null};
var lastTap={x:0,y:0,t:0};
var lastBackOpenAt=0;
function cancelLong(){try{if(T.long){clearTimeout(T.long);T.long=null;}}catch(e){err("cancelLong",e);}}
function armLong(target,x,y){
  try{
    cancelLong();
    if(interactive(target))return;
    if(!closest(target,'[class*="scrollBody"]'))return;
    T.long=setTimeout(function(){
      T.long=null;
      try{
        if(T.done||scrollingNow()||inputFocused())return;
        var el=msgEl(target)||msgEl(D.elementFromPoint(x,y));
        if(!el)return;
        var txt=readText(el);
        if(!txt)return;
        T.done=true;
        S.counters.long++;
        copyText(txt,"longPress800");
      }catch(e){err("longPress",e);}
    },LONG_MS);
  }catch(e){err("armLong",e);}
}
function onStart(ev){
  try{
    S.counters.start++;
    if(!ev.touches||ev.touches.length!==1){T.id=null;return;}
    var t=ev.touches[0];
    T.id=t.identifier;T.x0=t.clientX;T.y0=t.clientY;T.x1=t.clientX;T.y1=t.clientY;
    T.t0=Date.now();T.el=ev.target;T.done=false;
    T.edge=(t.clientX<=EDGE_PX);
    cancelLong();
    if(inputFocused()||editable(ev.target)||isMask(ev.target)||scrollingNow())return;
    if(drawerState()==="open")return;
    armLong(ev.target,t.clientX,t.clientY);
  }catch(e){err("onStart",e);}
}
function onMove(ev){
  try{
    if(T.id===null)return;
    var t=null,i;
    for(i=0;i<ev.touches.length;i++){if(ev.touches[i].identifier===T.id){t=ev.touches[i];break;}}
    if(!t)return;
    var dx=t.clientX-T.x0,dy=t.clientY-T.y0;
    T.x1=t.clientX;T.y1=t.clientY;
    if(T.long&&(Math.abs(dx)>12||Math.abs(dy)>12))cancelLong();
  }catch(e){err("onMove",e);}
}
function tapLike(adx,ady,dt){return dt<=320&&adx<=10&&ady<=10;}
function handleTapForDouble(x,y){
  try{
    var now=Date.now();
    if(lastTap.t&&(now-lastTap.t)<=DBL_MS&&Math.abs(x-lastTap.x)<=DBL_SLOP&&Math.abs(y-lastTap.y)<=DBL_SLOP){
      lastTap.t=0;
      var ok=toggleDrawer("doubleTapHeader");
      if(ok)S.counters.dbl++;
      return ok;
    }
    lastTap={x:x,y:y,t:now};
    return false;
  }catch(e){err("handleTapForDouble",e);return false;}
}
function onEnd(ev){
  try{
    S.counters.end++;
    if(T.id===null){cancelLong();return;}
    cancelLong();
    var t=(ev.changedTouches&&ev.changedTouches.length)?ev.changedTouches[0]:null;
    var x=t?t.clientX:T.x1,y=t?t.clientY:T.y1;
    var dx=x-T.x0,dy=y-T.y0,dt=Date.now()-T.t0;
    var adx=Math.abs(dx),ady=Math.abs(dy);
    var consumed=T.done;
    if(!consumed&&!inputFocused()&&!editable(T.el)&&!isMask(T.el)){
      if(T.edge&&drawerState()==="closed"&&dx>=EDGE_SWIPE_PX&&ady<=VERT_TOL&&adx>=ady*1.2&&dt<900&&!scrollingNow()){
        consumed=doOpen("edgeSwipeOpen");
        if(consumed)S.counters.edge++;
      }else if(drawerState()==="open"&&dx<=(-DRAWER_SWIPE_PX)&&ady<=VERT_TOL&&adx>=ady*1.2&&dt<900){
        consumed=doClose("drawerSwipeClose");
        if(consumed)S.counters.drawerSwipe++;
      }else if(adx>=TAB_SWIPE_PX&&ady<=VERT_TOL&&adx>=ady*1.5&&dt<900&&drawerState()!=="open"&&!scrollingNow()&&closest(T.el,'[class*="scrollBody"]')){
        consumed=switchTab(dx<0?1:-1);
        if(consumed)S.counters.tabSwipe++;
      }else if(tapLike(adx,ady,dt)&&y<=TOP_PX&&!interactive(T.el)&&drawerState()!=="unknown"){
        consumed=handleTapForDouble(x,y);
      }
    }
    if(consumed&&ev.cancelable){try{ev.preventDefault();}catch(e){err("preventDefault",e);}}
  }catch(e){err("onEnd",e);}
  T.id=null;T.done=false;T.el=null;
}
function onCancel(){
  try{cancelLong();T.id=null;T.done=false;}catch(e){err("onCancel",e);}
}
/* ---------- back key ----------------------------------------------------- */
function back(){
  try{
    S.counters.back++;
    var st=drawerState();
    S.drawer.state=st;
    if(st==="open"){
      var ok=doClose("backCloseDrawer");
      S.lastBack=ok?"closeDrawer":"closeDrawerFailed";
      if(ok)S.counters.backHandled++;
      return ok;
    }
    if(st==="unknown"){S.lastBack="unknownState";return false;}
    var now=Date.now();
    if(conversationVisible()&&(now-lastBackOpenAt)>BACK_GUARD_MS){
      var ok2=doOpen("backToList");
      S.lastBack=ok2?"openDrawerToList":"openDrawerFailed";
      if(ok2){lastBackOpenAt=now;S.counters.backHandled++;return true;}
      return false;
    }
    S.lastBack="passToNative";
    return false;
  }catch(e){err("back",e);S.lastBack="error";return false;}
}
/* The Android shell (MainActivity.askPageBack) asks window.__dshNativeBack() first and
   only runs its default action when that returns strictly true. Chain instead of
   clobbering: another layer may already own the hook. */
function installNativeBack(){
  try{
    var prev=W.__dshNativeBack;
    if(W.__dshNativeBack&&W.__dshNativeBack.__dshGestures){return;}
    var fn=function(){
      var mine=false;
      try{mine=(back()===true);}catch(e){err("nativeBack",e);}
      if(mine)return true;
      try{if(typeof prev==="function"&&prev()===true)return true;}catch(e){err("nativeBackPrev",e);}
      return false;
    };
    fn.__dshGestures=1;
    W.__dshNativeBack=fn;
    S.registrations.push("window#__dshNativeBack");
  }catch(e){err("installNativeBack",e);}
}
/* ---------- public state ------------------------------------------------- */
function state(){
  var st="unknown",tl=[];
  try{st=drawerState();}catch(e){err("state.drawer",e);}
  try{
    var ts=tabList(),i;
    for(i=0;i<ts.length;i++){tl.push({t:ts[i].t,sel:ts[i].sel,active:ts[i].active});}
  }catch(e){err("state.tabs",e);}
  var lc=null;
  try{
    if(S.lastCopied){lc={how:S.lastCopied.how,len:S.lastCopied.len,head:S.lastCopied.head,ok:S.lastCopied.ok,selected:S.lastCopied.selected,stored:S.lastCopied.stored};}
  }catch(e){err("state.copied",e);}
  return {version:V,installed:S.installed,registrations:S.registrations.slice(0),
    lastGesture:S.lastGesture,lastAt:S.lastAt,lastCopied:lc,lastBack:S.lastBack,
    drawer:{state:st,width:S.drawer.width,mask:S.flags.maskShown,toggle:S.drawer.toggle,by:S.drawer.by},
    tabs:tl,conversation:conversationVisible(),
    flags:{scrolling:scrollingNow()?1:0,inputFocused:inputFocused()?1:0},
    counters:S.counters,errors:S.errors.slice(0),
    thresholds:{edge:EDGE_PX,edgeSwipe:EDGE_SWIPE_PX,drawerSwipe:DRAWER_SWIPE_PX,tabSwipe:TAB_SWIPE_PX,
      vertTol:VERT_TOL,longPressMs:LONG_MS,toastMs:TOAST_MS,doubleTapMs:DBL_MS,doubleTapSlop:DBL_SLOP,
      topStripPx:TOP_PX,backGuardMs:BACK_GUARD_MS,scrollQuietMs:SCROLL_QUIET_MS},
    ua:String(navigator.userAgent||"").slice(0,90)};
}
/* ---------- install ------------------------------------------------------ */
function on(el,type,fn,opt){
  try{
    el.addEventListener(type,fn,opt);
    var who=(el===D)?"document":((el===W)?"window":(el.id||tagOf(el)));
    var pas=(opt&&opt.passive===false)?"/cancelable":"/passive";
    S.registrations.push(type+"@"+who+pas);
  }catch(e){err("on:"+type,e);}
}
function install(){
  try{
    if(S.installed)return;
    on(D,"touchstart",onStart,{passive:true,capture:true});
    on(D,"touchmove",onMove,{passive:true,capture:true});
    on(D,"touchend",onEnd,{passive:false,capture:true});
    on(D,"touchcancel",onCancel,{passive:true,capture:true});
    on(D,"scroll",onScroll,{passive:true,capture:true});
    on(W,"scroll",onScroll,{passive:true,capture:true});
    on(W,"resize",function(){try{syncMask();}catch(e){err("onResize",e);}},{passive:true});
    on(D,"focusin",function(){try{syncMask();}catch(e){err("onFocusIn",e);}},{passive:true});
    setInterval(function(){try{syncMask();}catch(e){err("maskTick",e);}},400);
    S.registrations.push("interval400#maskSync");
    S.installed=1;
    installNativeBack();
    syncMask();
    mark("install",{});
  }catch(e){err("install",e);}
}
install();
W.__dshGestures={__installed:1,version:V,state:state,back:back,
  nativeBack:function(){try{return W.__dshNativeBack?W.__dshNativeBack():false;}catch(e){err("nativeBackProbe",e);return false;}},
  open:function(){return doOpen("manualOpen");},
  close:function(){return doClose("manualClose");},
  toggle:function(){return toggleDrawer("manualToggle");},
  drawerState:drawerState,tabs:tabList,switchTab:switchTab,
  copyAt:function(x,y){
    try{
      var el=msgEl(D.elementFromPoint(x,y));
      if(!el)return null;
      var txt=readText(el);
      copyText(txt,"copyAt");
      return txt;
    }catch(e){err("copyAt",e);return null;}
  },
  errors:function(){return S.errors.slice(0);},
  raw:S};
})();</script>"""

MOBILE_VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
_HEAD_OPEN_RE = re.compile(rb"<head[^>]*>", re.I)

# Missing modern APIs in older WebViews. Must run BEFORE any app script.
# Huawei P40 (WebView Chrome/114) threw "Promise.withResolvers is not a function" (Chrome 119+).
MOBILE_POLYFILL = """<script id="dsh-polyfill">(function(){
var P=Promise;
if(typeof P.withResolvers!=="function"){P.withResolvers=function(){var r,j,p=new P(function(a,b){r=a;j=b;});return{promise:p,resolve:r,reject:j};};}
try{if(!(self.crypto&&self.crypto.randomUUID)){var c=self.crypto||(self.crypto={});
if(!c.getRandomValues){c.getRandomValues=function(a){for(var i=0;i<a.length;i++){a[i]=Math.floor(Math.random()*256);}return a;};}
c.randomUUID=function(){var b=new Uint8Array(16);c.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
var h=[],i;for(i=0;i<16;i++){h.push((b[i]+256).toString(16).slice(1));}
return h.slice(0,4).join("")+"-"+h.slice(4,6).join("")+"-"+h.slice(6,8).join("")+"-"+h.slice(8,10).join("")+"-"+h.slice(10,16).join("");};}}catch(e){}
if(typeof Object.groupBy!=="function"){Object.groupBy=function(it,fn){var o=Object.create(null),i=0,k;for(var x of it){k=fn(x,i++);(o[k]||(o[k]=[])).push(x);}return o;};}
if(typeof Map.groupBy!=="function"){Map.groupBy=function(it,fn){var m=new Map(),i=0,k;for(var x of it){k=fn(x,i++);if(!m.has(k)){m.set(k,[]);}m.get(k).push(x);}return m;};}
if(typeof URL.canParse!=="function"){URL.canParse=function(u,b){try{new URL(u,b);return true;}catch(e){return false;}};}
if(typeof Array.fromAsync!=="function"){Array.fromAsync=function(it){return Promise.resolve(it).then(function(x){return Array.from(x);});};}
var A=Array.prototype;
if(!A.findLast){A.findLast=function(f,t){for(var i=this.length-1;i>=0;i--){if(f.call(t,this[i],i,this)){return this[i];}}};}
if(!A.findLastIndex){A.findLastIndex=function(f,t){for(var i=this.length-1;i>=0;i--){if(f.call(t,this[i],i,this)){return i;}}return -1;};}
if(!A.toSorted){A.toSorted=function(c){return this.slice().sort(c);};}
if(!A.toReversed){A.toReversed=function(){return this.slice().reverse();};}
if(!A.toSpliced){A.toSpliced=function(){var a=this.slice();a.splice.apply(a,arguments);return a;};}
if(!A["with"]){A["with"]=function(i,v){var a=this.slice();a[i<0?a.length+i:i]=v;return a;};}
if(!self.structuredClone){self.structuredClone=function(o){return JSON.parse(JSON.stringify(o));};}
if(!self.requestIdleCallback){self.requestIdleCallback=function(cb){return setTimeout(function(){cb({didTimeout:false,timeRemaining:function(){return 50;}});},1);};}
try{if(!(navigator.clipboard&&navigator.clipboard.writeText)){var nc=navigator.clipboard||{};
nc.writeText=function(t){try{var ta=document.createElement("textarea");ta.value=t;ta.style.position="fixed";ta.style.opacity="0";
document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);}catch(e){}return Promise.resolve();};
try{Object.defineProperty(navigator,"clipboard",{value:nc,configurable:true});}catch(e){}}}catch(e){}

if(typeof AbortSignal!=="undefined"&&typeof AbortSignal.any!=="function"){AbortSignal.any=function(list){var c=new AbortController();function onAb(){c.abort(this.reason);}for(var i=0;i<list.length;i++){var sig=list[i];if(sig.aborted){c.abort(sig.reason);break;}sig.addEventListener("abort",onAb,{once:true});}return c.signal;};}
if(typeof AbortSignal!=="undefined"&&typeof AbortSignal.timeout!=="function"){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort(new DOMException("TimeoutError","TimeoutError"));},ms);return c.signal;};}
if(typeof URL.parse!=="function"){URL.parse=function(u,b){try{return new URL(u,b);}catch(e){return null;}};}
if(typeof Promise.try!=="function"){Promise.try=function(fn){try{return Promise.resolve(fn());}catch(e){return Promise.reject(e);}};}
if(typeof Set.prototype.union!=="function"){Set.prototype.union=function(o){var r=new Set(this);o.forEach(function(v){r.add(v);});return r;};}
if(typeof Set.prototype.intersection!=="function"){Set.prototype.intersection=function(o){var r=new Set();this.forEach(function(v){if(o.has(v))r.add(v);});return r;};}
if(typeof Set.prototype.difference!=="function"){Set.prototype.difference=function(o){var r=new Set();this.forEach(function(v){if(!o.has(v))r.add(v);});return r;};}
})();</script>"""


# Mobile voice input: the page is served over plain http on a Tailscale/LAN IP, so
# Chromium never exposes navigator.mediaDevices there and DSH's own voice input dies
# with RecordingError("unavailable").  The APK registers a native bridge
# (window.__DSHVoice: AudioRecord + SpeechRecognizer); this script turns it back into
# the getUserMedia/MediaRecorder pair the frontend already uses, plus a Web Speech
# shim.  No bridge -> no injection (a desktop browser keeps its real APIs).
# Disable with ?no-voice=1.
MOBILE_VOICE = """<script id="dsh-voice">(function(){
if(window.__dshVoiceInstalled){return;}
window.__dshVoiceInstalled=1;
var LOG=[];window.__dshVoiceLog=LOG;
function L(){try{var a=Array.prototype.slice.call(arguments).join(" ");LOG.push(a);
if(LOG.length>60){LOG.shift();}
if(window.console&&console.log){console.log("[dsh-voice] "+a);}}catch(e){}}
if(/(^|[?&])no-voice=1(&|$)/.test(location.search||"")){L("off: ?no-voice=1");return;}
var B=window.__DSHVoice;
if(!B){L("no native bridge: keeping stock browser semantics");return;}
try{L("bridge "+B.version()+" info="+B.info());}catch(e){}
function J(s){try{return JSON.parse(s);}catch(e){return {ok:0,code:"bridge",msg:String(s)};}}
function E(code,msg){
var name=(code==="permission"||code==="not-allowed")?"NotAllowedError":"NotReadableError";
try{return new DOMException(msg||code,name);}catch(e){var x=new Error(msg||code);x.name=name;return x;}}
function FIRE(t,ev){try{if(t){t(ev);}}catch(e){L("handler threw: "+e);}}

/* ---------- A) getUserMedia + MediaRecorder -> native AudioRecord ----------
   The phone loads this page over plain http on a Tailscale/LAN IP, which is not a
   secure context, so Chromium never exposes navigator.mediaDevices.  DSH's voice
   input (dsh-experimental-speech-to-text client plugin) needs exactly that:
   getUserMedia -> MediaRecorder -> WAV -> base64 upload to the Host.  The shim
   below supplies the same two objects on top of the native AudioRecord bridge, so
   the frontend code path is untouched and the audio is real. */
var PATH="/__dshvoice/rec.wav";
var wait=null,live=null,cur=null,SHIM=0;
function mkStream(){
var tr={kind:"audio",label:"dsh-native-mic",readyState:"live",enabled:true,muted:false,__dshNative:true,
stop:function(){if(tr.readyState!=="live"){return;}tr.readyState="ended";
try{B.abortRec();}catch(e){}
if(live&&live.__dshNative){live.active=false;}live=null;},
addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return false;}};
return {id:"dsh-native-stream",active:true,__dshNative:true,__track:tr,
getTracks:function(){return [tr];},getAudioTracks:function(){return [tr];},
getVideoTracks:function(){return [];},getTrackById:function(){return null;},
addTrack:function(){},removeTrack:function(){},clone:function(){return mkStream();},
addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return false;}};}
function settleOk(){var w=wait;wait=null;if(w){live=mkStream();w.resolve(live);}}
function settleErr(code,msg){
var w=wait;wait=null;
if(w){w.reject(E(code,msg));return;}
if(cur){FIRE(cur.onerror,{type:"error",error:code,message:msg});}}
window.__dshVoiceRecReady=function(){L("native recorder ready");settleOk();};
window.__dshVoiceRecError=function(code,msg){L("native recorder error "+code+" "+msg);settleErr(code,msg);};
window.__dshVoicePerm=function(ok){
L("RECORD_AUDIO="+ok);
if(String(ok)==="1"){
var r;try{r=J(B.startRec());}catch(e){r={ok:0,code:"bridge",msg:String(e)};}
if(r.ok===1){settleOk();}else{settleErr(r.code||"audio-capture",r.msg||"");}
}else{settleErr("permission","microphone permission denied");}};
window.__dshVoiceRecEnd=function(ms,bytes){
var c=cur;L("native recorder stopped "+ms+"ms/"+bytes+"B");
if(!c){return;}
var tr=c.stream&&c.stream.__track;
var done=function(){c.state="inactive";FIRE(c.onstop,{type:"stop"});};
if(tr&&tr.readyState!=="live"){return done();}
if(!(Number(bytes)>0)){FIRE(c.onerror,{type:"error"});return done();}
fetch(PATH+"?t="+Date.now(),{cache:"no-store"}).then(function(r){
if(!r.ok){throw new Error("HTTP "+r.status);}return r.arrayBuffer();
}).then(function(buf){
FIRE(c.ondataavailable,{type:"dataavailable",data:new Blob([buf],{type:"audio/wav"})});
done();
}).catch(function(e){L("wav fetch failed: "+e);FIRE(c.onerror,{type:"error"});done();});};
var NativeMR=window.MediaRecorder;
function MR(stream){
if(!(stream&&stream.__dshNative)){
if(!NativeMR){throw new Error("MediaRecorder unavailable");}
return new NativeMR(stream);}
this.stream=stream;this.mimeType="audio/wav";this.state="inactive";
this.ondataavailable=null;this.onstop=null;this.onerror=null;this.onstart=null;
this.__want=false;cur=this;}
MR.isTypeSupported=function(t){
if(NativeMR&&NativeMR.isTypeSupported){try{if(NativeMR.isTypeSupported(t)){return true;}}catch(e){}}
return t==="audio/wav"||/wav|pcm/i.test(String(t||""));};
MR.prototype.start=function(){
if(this.state==="recording"){throw new DOMException("already recording","InvalidStateError");}
this.state="recording";this.__want=true;cur=this;FIRE(this.onstart,{type:"start"});};
MR.prototype.stop=function(){
if(this.state!=="recording"){return;}
this.state="inactive";
var r;try{r=J(B.stopRec());}catch(e){r={ok:0,code:"bridge",msg:String(e)};}
if(r.ok!==1){this.__want=false;FIRE(this.onerror,{type:"error"});window.__dshVoiceRecEnd(0,0);}};
MR.prototype.requestData=function(){};
MR.prototype.pause=function(){};
MR.prototype.resume=function(){};
try{
if(!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)){
var md={getUserMedia:function(c){
return new Promise(function(resolve,reject){
if(wait||live){reject(E("busy","capture already running"));return;}
wait={resolve:resolve,reject:reject};
var r;try{r=J(B.startRec());}catch(e){r={ok:0,code:"bridge",msg:String(e)};}
if(r.ok===1){settleOk();}
else if(r.pending===1){L("waiting for RECORD_AUDIO grant");}
else{settleErr(r.code||"audio-capture",r.msg||"native recorder unavailable");}});},
enumerateDevices:function(){return Promise.resolve([]);},getSupportedConstraints:function(){return {};}};
Object.defineProperty(navigator,"mediaDevices",{value:md,configurable:true,writable:true});
window.MediaRecorder=MR;SHIM=1;
L("installed native getUserMedia/MediaRecorder shim (page origin is not a secure context)");
}else{L("stock getUserMedia present: native shim not needed");}
}catch(e){L("mediaDevices shim failed: "+e);}
function patchCtx(C){
if(!C||!C.prototype||C.prototype.__dshVoicePatched){return;}
var o=C.prototype.createMediaStreamSource;
if(typeof o!=="function"){return;}
C.prototype.createMediaStreamSource=function(s){
if(s&&s.__dshNative){try{return this.createGain();}catch(e){}}
return o.apply(this,arguments);};
C.prototype.__dshVoicePatched=1;}
patchCtx(window.AudioContext);patchCtx(window.webkitAudioContext);

/* ---------- B) Web Speech API -> native SpeechRecognizer ----------
   DSH's own voice entry does NOT use Web Speech (see A).  This half is a real,
   honest compatibility layer for anything that does: it forwards to the native
   SpeechRecognizer and reports service-not-allowed instead of faking results. */
var ASR=null,ERRS=[];window.__dshVoiceErrors=ERRS;
function mkResults(text,final){
var alt={transcript:text,confidence:final?0.9:0};
var res={length:1,isFinal:!!final,item:function(i){return i===0?alt:null;}};res[0]=alt;
var list={length:1,item:function(i){return i===0?res:null;}};list[0]=res;
return list;}
function SR(){
this.continuous=false;this.interimResults=false;
this.lang=(navigator.language||"zh-CN");this.maxAlternatives=1;
this.onstart=null;this.onend=null;this.onerror=null;this.onresult=null;
this.onaudiostart=null;this.onaudioend=null;this.onsoundstart=null;this.onsoundend=null;
this.onspeechstart=null;this.onspeechend=null;this.onnomatch=null;
this.__on=false;}
SR.prototype.start=function(){
if(this.__on){throw new DOMException("already started","InvalidStateError");}
var av="0";try{av=String(B.asrAvailable());}catch(e){}
if(av!=="1"){this.__on=false;ASR=null;ERRS.push("start: service-not-allowed");
var self=this;setTimeout(function(){
FIRE(self.onerror,{type:"error",error:"service-not-allowed",
message:"no on-device speech recognition service"});
FIRE(self.onend,{type:"end"});},0);return;}
this.__on=true;ASR=this;
var r;try{r=J(B.startAsr(String(this.lang||"zh-CN")));}catch(e){r={ok:0,code:"bridge",msg:String(e)};}
if(!r||r.ok!==1){this.__on=false;ASR=null;
var code=(r&&r.code)||"service-not-allowed";
ERRS.push("start: "+code+" "+((r&&r.msg)||""));
var s2=this;setTimeout(function(){
FIRE(s2.onerror,{type:"error",error:code,message:(r&&r.msg)||""});
FIRE(s2.onend,{type:"end"});},0);}};
SR.prototype.stop=function(){if(!this.__on){return;}try{B.stopAsr();}catch(e){}};
SR.prototype.abort=function(){if(!this.__on){return;}try{B.abortAsr();}catch(e){}};
window.__dshVoiceAsrReady=function(){
var r=ASR;if(!r){return;}L("asr ready");
FIRE(r.onstart,{type:"start"});FIRE(r.onaudiostart,{type:"audiostart"});};
window.__dshVoiceResult=function(text,isFinal){
var r=ASR;if(!r){return;}
var fin=(isFinal===true||String(isFinal)==="1"||String(isFinal)==="true");
var t=String(text==null?"":text);
L("asr result final="+fin+" "+t.slice(0,40));
if(!fin&&!r.interimResults){return;}
FIRE(r.onresult,{type:"result",resultIndex:0,results:mkResults(t,fin)});
if(fin){FIRE(r.onspeechend,{type:"speechend"});}};
window.__dshVoiceAsrError=function(code,msg){
var r=ASR;if(!r){return;}
L("asr error "+code+" "+msg);ERRS.push("error: "+code+" "+msg);
FIRE(r.onerror,{type:"error",error:String(code||"unknown"),message:String(msg||"")});};
window.__dshVoiceAsrEnd=function(){
var r=ASR;if(!r){return;}
ASR=null;r.__on=false;L("asr end");
FIRE(r.onend,{type:"end"});};
try{
if(!window.SpeechRecognition){window.SpeechRecognition=SR;}
if(!window.webkitSpeechRecognition){window.webkitSpeechRecognition=SR;}
L("installed SpeechRecognition polyfill (native SpeechRecognizer)");
}catch(e){L("SpeechRecognition polyfill failed: "+e);}
window.__dshSpeechAvailable=function(){try{return String(B.asrAvailable())==="1";}catch(e){return false;}};
window.__dshVoiceDiag=function(){
function q(f){try{return f();}catch(e){return "?";}}
return JSON.stringify({bridge:q(function(){return B.version();}),
info:q(function(){return B.info();}),
secureContext:!!window.isSecureContext,
mediaDevices:typeof navigator.mediaDevices,
getMediaShim:SHIM,
mediaRecorderIsNative:!!(window.MediaRecorder===NativeMR),
speechRecognition:typeof window.webkitSpeechRecognition,
speechIsPolyfill:!!(window.webkitSpeechRecognition===SR),
asrAvailable:q(function(){return String(B.asrAvailable());}),
errors:ERRS.slice(-8),log:LOG.slice(-12)});};
})();</script>"""


def inject_mobile(html_bytes, with_css=True, with_gestures=True, with_voice=True):
    """Inject mobile adaptation: polyfill + keeper + pager (always) + optional CSS.

    The gesture layer (MOBILE_GESTURES) is deliberately independent of the CSS:
    its own <script id="dsh-gestures"> tag, its own ?no-gesture=1 kill switch, so
    it can be toggled without touching the adaptation stylesheet.
    """
    g = with_gestures and (b"dsh-gestures" not in html_bytes)
    if b"dsh-polyfill" in html_bytes:
        # Document already injected once (re-served body / replay): only the
        # independent gesture layer may still be missing.
        return _inject_gestures(html_bytes) if g else html_bytes
    poly = MOBILE_POLYFILL.encode("utf-8")
    if b"dsh-keeper" not in html_bytes:
        poly = poly + MOBILE_KEEPER.encode("utf-8")
    if b"dsh-pager" not in html_bytes:
        poly = poly + MOBILE_PAGER.encode("utf-8")
    if with_voice and b"dsh-voice" not in html_bytes:
        poly = poly + MOBILE_VOICE.encode("utf-8")
    if g:
        poly = poly + MOBILE_GESTURES.encode("utf-8")
    m = _HEAD_OPEN_RE.search(html_bytes)
    if m:
        html_bytes = html_bytes[:m.end()] + poly + html_bytes[m.end():]
    else:
        html_bytes = poly + html_bytes
    if not with_css:
        return html_bytes
    head_close = html_bytes.lower().rfind(b"</head>")
    add = MOBILE_ADAPT_CSS.encode("utf-8")
    if head_close >= 0:
        return html_bytes[:head_close] + add + html_bytes[head_close:]
    return html_bytes + add


def _inject_gestures(html_bytes):
    """Attach the gesture layer to an already-adapted document (idempotent)."""
    if b"dsh-gestures" in html_bytes:
        return html_bytes
    g = MOBILE_GESTURES.encode("utf-8")
    m = _HEAD_OPEN_RE.search(html_bytes)
    if m:
        return html_bytes[:m.end()] + g + html_bytes[m.end():]
    return g + html_bytes


def _short(v, n):
    if not isinstance(v, str):
        return v
    return v if len(v) <= n else v[:n] + "..."


def _trim_msg(msg):
    """Trim the bulkiest parts of a message (source/replayState etc.)."""
    if not isinstance(msg, dict):
        return
    msg.pop("source", None)
    blocks = msg.get("content")
    if isinstance(blocks, list):
        out = []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            t = b.get("type")
            if t == "text":
                out.append({"type": "text", "text": _short(b.get("text"), TRIM_TEXT)})
            elif t == "reasoning":
                out.append({"type": "reasoning", "text": _short(b.get("text"), TRIM_REASON)})
            elif t == "tool-call":
                out.append({"type": "tool-call", "name": b.get("name"),
                            "arguments": _short(b.get("arguments"), TRIM_ARGS)})
        msg["content"] = out


def _json_bytes(obj):
    """Compact JSON bytes, tolerating the lone surrogates the Host emits.

    The Host truncates long text mid-surrogate-pair and ships the escape
    "\\ud83d" as-is; json.loads turns that into a lone surrogate, and
    json.dumps(..., ensure_ascii=False).encode("utf-8") then raises
    UnicodeEncodeError -- which in the caller is caught as "transform failed"
    and silently degrades the whole response to pass-through. "replace" keeps the
    body valid UTF-8 and still valid JSON (the replacement char can never be
    mistaken for a delimiter).
    """
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "replace")


def trim_session_list(data, keep_proj=True):
    """Whitelist the session/list payload down to the fields the sidebar renders.

    Key order is irrelevant (the client reads by name) and the caller re-serialises
    with compact separators. `projections` is emitted only for items that actually
    have a whitelisted value, and only with a numeric asOfSeq: the client schema makes
    projections.asOfSeq a required number, so a null there would invalidate the
    *whole* response rather than just that item.
    """
    if not isinstance(data, dict):
        return data
    val = (data.get("result") or {}).get("value")
    if not isinstance(val, dict) or not isinstance(val.get("items"), list):
        return data
    out = []
    for it in val["items"]:
        if not isinstance(it, dict):
            out.append(it)
            continue
        n = {}
        for k in LIST_TRIM_ITEM_KEYS:
            if k in it:
                n[k] = it[k]
        if keep_proj:
            pr = it.get("projections")
            pv = pr.get("values") if isinstance(pr, dict) else None
            nv = {}
            if isinstance(pv, dict):
                for k in LIST_TRIM_PROJ_KEYS:
                    if k in pv:
                        nv[k] = pv[k]
            as_of = pr.get("asOfSeq") if isinstance(pr, dict) else None
            kind = pr.get("kind") if isinstance(pr, dict) else None
            if (nv and kind in LIST_TRIM_KINDS
                    and isinstance(as_of, (int, float)) and not isinstance(as_of, bool)):
                n["projections"] = {"kind": kind, "asOfSeq": as_of, "values": nv}
        out.append(n)
    val["items"] = out
    return data


def trim_payload(path, data):
    """Mobile slimming: keep render-needed fields, drop big blobs and projections."""
    if not isinstance(data, dict):
        return data
    val = (data.get("result") or {}).get("value")
    if not isinstance(val, dict):
        return data
    if path.endswith("session/list") and isinstance(val.get("items"), list):
        # The lightweight page keeps its own 60-item cap, but the field set now comes from
        # the same whitelist the full version uses (it additionally keeps parentSessionId /
        # origin, which the old inline dict dropped and which the lineage grouping needs).
        items = sorted(val["items"], key=lambda x: -(x.get("updatedAt") or 0))[:TRIM_MAX_ITEMS]
        val["items"] = items
        return trim_session_list(data, True)
    elif path.endswith("session/page") and isinstance(val.get("records"), list):
        recs = val["records"][-TRIM_MAX_RECORDS:]
        for rec in recs:
            ev = (rec or {}).get("event") or {}
            d = ev.get("data")
            if isinstance(d, dict):
                _trim_msg(d.get("message"))
                if ev.get("type") == "tool/call":
                    d["arguments"] = _short(d.get("arguments"), TRIM_ARGS)
                elif ev.get("type") == "tool/result":
                    r = d.get("result")
                    d["result"] = _short(r if isinstance(r, str) else json.dumps(r, ensure_ascii=False), TRIM_RESULT)
        val["records"] = recs
    return data


def _header_value(hdrs, name):
    """Case-insensitive header lookup from the raw request header list."""
    pre = name.lower() + ":"
    for h in hdrs:
        if h.lower().startswith(pre):
            return h.split(":", 1)[1].strip()
    return None


def _set_content_length(out, n):
    """Force the upstream request Content-Length to n (replace or append)."""
    line = ("Content-Length: %d" % n).encode("latin-1")
    head, _, rest = out.partition(b"\r\n\r\n")
    ls = head.split(b"\r\n")
    hit = False
    for i in range(1, len(ls)):
        if ls[i].lower().startswith(b"content-length:"):
            ls[i] = line
            hit = True
    if not hit:
        ls.append(line)
    return b"\r\n".join(ls) + b"\r\n\r\n" + rest


def cap_page_req(req):
    """压一个分页 request：maxMessages <= PAGE_MSG_LIMIT，且 turnWindow.minMessages 一并压。

    服务端硬校验 "turnWindow.minMessages must be a positive safe integer no greater than
    maxMessages"，只改 maxMessages 会直接 gateway/bad-request，所以两者必须一起改。
    -> (old_max, new_max, old_min, new_min) 或 None（没有可压的就别碰）。
    """
    if not PAGE_MSG_ON or not isinstance(req, dict):
        return None
    mm = req.get("maxMessages")
    if not isinstance(mm, int) or isinstance(mm, bool):
        return None                            # 没声明：原样放行
    new_mm = min(mm, PAGE_MSG_LIMIT)
    old_min = new_min = None
    tw = req.get("turnWindow")
    if isinstance(tw, dict):
        mn = tw.get("minMessages")
        if isinstance(mn, int) and not isinstance(mn, bool):
            old_min = mn
            if mn > new_mm:
                tw["minMessages"] = new_min = new_mm
    if new_mm == mm and new_min is None:
        return None                            # 已经够小：逐字节原样透传
    req["maxMessages"] = new_mm
    return (mm, new_mm, old_min, new_min)


def cap_page_messages(body):
    """Rewrite a session/page request body: maxMessages <= PAGE_MSG_LIMIT.

    Only the requested window shrinks; every other client parameter (address, throughSeq,
    turnWindow.minTurns, ...) is preserved verbatim. Returns (new_body, info):
      info = (old_max, new_max, old_min, new_min)
    On any anomaly (not JSON, no maxMessages, unusual shape) the body is returned
    untouched so the request can never be broken.
    """
    if not PAGE_MSG_ON or not body:
        return body, None
    try:
        j = json.loads(body.decode("utf-8"))
    except Exception:
        return body, None
    if not isinstance(j, dict):
        return body, None
    args = ((j.get("payload") or {}).get("args")) if isinstance(j.get("payload"), dict) else None
    if not isinstance(args, dict):
        args = j.get("args") if isinstance(j.get("args"), dict) else None
    if not isinstance(args, dict):
        return body, None
    req = args.get("request") if isinstance(args.get("request"), dict) else args
    info = cap_page_req(req)
    if info is None:
        return body, None
    PAGE_CAP_APPLIED[0] += 1
    return (json.dumps(j, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), info)


def _ws_frame(payload):
    """把一段文本 payload 重新封装成"客户端->服务器"的单帧（FIN + text + 新掩码）。"""
    n = len(payload)
    out = bytearray()
    out.append(0x81)
    if n < 126:
        out.append(0x80 | n)
    elif n < 65536:
        out.append(0x80 | 126)
        out += n.to_bytes(2, "big")
    else:
        out.append(0x80 | 127)
        out += n.to_bytes(8, "big")
    key = os.urandom(4)
    out += key
    body = bytearray(payload)
    for i in range(n):
        body[i] ^= key[i & 3]
    out += body
    return bytes(out)


def ws_cap_frame(f):
    """客户端 -> DSH 的 WebSocket 帧：把会话首屏的 maxMessages 也压到 PAGE_MSG_LIMIT。

    为什么必须在这里做：打开一个会话时，最近一页历史**不是** POST /api/session/page，
    而是 /api/remote.mux 上的一帧文本：
      {"type":"open",...,"endpoint":"session/follow",
       "payload":{"args":{"request":{...,"maxMessages":500,"turnWindow":{...}}}}}
    只压 POST 体的话首屏仍然是服务端默认（实测 maxMessages=500）—— B 的需求就落空了。

    现场取证（_pg_wsprobe.py，带 Sec-WebSocket-Extensions 的原始握手）：DSH 的 101
    响应里**没有** Sec-WebSocket-Extensions —— permessage-deflate 从未协商，所以客户端
    帧永远是明文、无压缩、单帧文本，解掩码/改 JSON/重新掩码是安全的。

    任何不匹配（二进制帧、分片帧、RSV 置位、超大帧、JSON 异常）一律原样返回。
    """
    if not PAGE_MSG_ON or len(f) < 8:
        return f
    try:
        b0 = f[0]
        b1 = f[1]
        if (b0 & 0x0F) != 0x1 or (b0 & 0x80) != 0x80 or (b0 & 0x70) != 0:
            return f                            # 非 FIN 文本帧 / 有 RSV：不碰
        if not (b1 & 0x80):
            return f                            # 客户端帧必须带掩码，异常帧不碰
        ln = b1 & 0x7F
        off = 2
        if ln == 126:
            if len(f) < 4:
                return f
            ln = int.from_bytes(f[2:4], "big")
            off = 4
        elif ln == 127:
            if len(f) < 10:
                return f
            ln = int.from_bytes(f[2:10], "big")
            off = 10
        # session/follow 的 open 帧只有 ~310-400 B；这里刻意只处理小帧，
        # 避免对每条中/大客户端帧做 O(n) 的 Python 解掩码（热路径开销 ~0）
        if ln > 8192 or len(f) < off + 4 + ln:
            return f                            # 超大/残缺：不做 O(n) 的 Python 解掩码
        key = f[off:off + 4]
        pay = bytearray(f[off + 4:off + 4 + ln])
        for i in range(ln):
            pay[i] ^= key[i & 3]
        if b'"endpoint":"session/follow"' not in pay:
            return f
        j = json.loads(bytes(pay).decode("utf-8"))
        req = ((((j or {}).get("payload") or {}).get("args") or {}).get("request"))
        info = cap_page_req(req)
        if info is None:
            return f
        nb = json.dumps(j, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        WS_CAP_APPLIED[0] += 1
        log("ws page cap: maxMessages %s->%s turnWindow.minMessages %s->%s (frame %d B -> %d B)"
            % (info[0], info[1], info[2], info[3], len(f), len(nb) + 8))
        return _ws_frame(nb)
    except Exception as e:
        log("ws page cap skipped: %r" % (e,))
        return f


# --- POST RPC disk cache helpers -----------------------------------------------------


def _page_request_shape(body):
    """只读解析一个 session/page 请求体 -> dict 或 None。

    形状容错：payload.args.request / payload.args / args.request / args / request / 顶层，
    取第一个含 throughSeq|beforeSeq|maxMessages|turnWindow 的 dict。绝不改写请求体。
    """
    try:
        j = json.loads(body.decode("utf-8", "replace"))
    except Exception:
        return None
    if not isinstance(j, dict):
        return None
    cands = []
    pl = j.get("payload")
    if isinstance(pl, dict) and isinstance(pl.get("args"), dict):
        a = pl["args"]
        if isinstance(a.get("request"), dict):
            cands.append(a["request"])
        cands.append(a)
    a2 = j.get("args")
    if isinstance(a2, dict):
        if isinstance(a2.get("request"), dict):
            cands.append(a2["request"])
        cands.append(a2)
    if isinstance(j.get("request"), dict):
        cands.append(j["request"])
    cands.append(j)
    for c in cands:
        if any(k in c for k in ("throughSeq", "beforeSeq", "maxMessages", "turnWindow")):
            ad = c.get("address") if isinstance(c.get("address"), dict) else {}
            tw = c.get("turnWindow") if isinstance(c.get("turnWindow"), dict) else {}
            return {"sessionId": c.get("sessionId") or ad.get("sessionId"),
                    "throughSeq": c.get("throughSeq"),
                    "beforeSeq": c.get("beforeSeq"),
                    "maxMessages": c.get("maxMessages"),
                    "minMessages": tw.get("minMessages")}
    return None


def _page_immutable(shape):
    """不可变判据：throughSeq 是一个非负整数（窗口右端被钉死）。

    throughSeq 缺失 / -1 / 非数字 => "最新一页"，会随后续消息变化 => 短 TTL。
    """
    if not shape:
        return False
    t = shape.get("throughSeq")
    return isinstance(t, int) and not isinstance(t, bool) and t >= 0


def _api_rpc_id(body):
    """请求信封里的 rpcId（客户端拿它校验响应，缓存回放必须原样回显）。"""
    try:
        j = json.loads(body.decode("utf-8", "replace"))
    except Exception:
        return None
    if isinstance(j, dict) and isinstance(j.get("rpcId"), str) and j["rpcId"]:
        return j["rpcId"]
    return None


def _page_key_extra(shape):
    """把分页/裁剪参数显式写进缓存键（键里同时还有整份请求体的哈希，这里是双保险）。"""
    if not shape:
        return ""
    return "s=%s|t=%s|b=%s|m=%s|w=%s" % (shape.get("sessionId"), shape.get("throughSeq"),
                                        shape.get("beforeSeq"), shape.get("maxMessages"),
                                        shape.get("minMessages"))


def _api_body_key(path, target, trim, body, lmode="N", extra=""):
    """Stable cache key for a POST RPC call.

    `lmode` carries the session/list slimming mode so a slimmed entry can never be
    replayed for an untrimmed request (or vice versa):
      N = list trim off, L = list trim on + projections kept, X = list trim on, no projections.

    The wire body carries a fresh rpcId uuid per request, so hashing it raw would make
    every request a miss. The uuid is dropped and the JSON re-serialised canonically,
    which is exactly what lets the APK's prewarm fetch share an entry with the app's
    own later fetch.
    """
    q = target.split("?", 1)[1] if "?" in target else ""
    canon = body
    try:
        j = json.loads(body.decode("utf-8"))
        if isinstance(j, dict):
            for k in API_CACHE_VOLATILE:
                j.pop(k, None)
            canon = json.dumps(j, sort_keys=True, separators=(",", ":"),
                               ensure_ascii=False).encode("utf-8")
    except Exception:
        pass
    h = hashlib.sha256()
    h.update(("%s|%s|%s%s|%s|" % (path, q, "T" if trim else "F", lmode, extra)).encode("utf-8"))
    h.update(hashlib.sha256(canon).digest())
    return h.hexdigest()[:32]


def _api_sessions_running(body):
    """True when this session/list body reports at least one running session."""
    try:
        j = json.loads(body.decode("utf-8", "replace"))
        items = ((j.get("result") or {}).get("value") or {}).get("items")
        if isinstance(items, list):
            return any(isinstance(it, dict) and it.get("running") for it in items)
    except Exception:
        pass
    return False


def _api_is_error(body):
    """True for an RPC error envelope ({"result":{"ok":false,...}}).

    These must never be cached: the app would then read a stale *failure* as if it were
    the session list/page. Observed for real: reading a subagent child session with a
    plain session address answers session/agent-busy -> 268 B of "error" that has no
    business being replayed for the next 90 s.
    """
    head = body[:512]
    return b'"ok":false' in head or b'"ok": false' in head


def _api_cache_sidecars(key, body):
    """把 br/gzip 压缩体一并落盘（<key>.br / <key>.gz），命中时直接回放。

    所有编码参数都是固定的（brotli quality=5 lgwin=24 / gzip level 6），所以边车文件就是
    同一份内容，回放它 == 现场重算，省掉一次 CPU 和一次事件循环占用。
    """
    base = os.path.join(API_CACHE_DIR, key)
    if (not API_CACHE_COMPRESS) or len(body) > API_CACHE_MAXBODY:
        for ext in (".br", ".gz"):
            try:
                os.remove(base + ext)
            except Exception:
                pass
        return
    if brotli is not None:
        try:
            with open(base + ".br.tmp", "wb") as f:
                f.write(brotli.compress(body, quality=5, lgwin=24))
            os.replace(base + ".br.tmp", base + ".br")
        except Exception as e:
            log("api cache br sidecar failed: %r" % (e,))
    try:
        with open(base + ".gz.tmp", "wb") as f:
            f.write(gzip.compress(body, 6))
        os.replace(base + ".gz.tmp", base + ".gz")
    except Exception as e:
        log("api cache gz sidecar failed: %r" % (e,))


def _api_cache_drop(key):
    for ext in (".json", ".br", ".gz"):
        try:
            os.remove(os.path.join(API_CACHE_DIR, key + ext))
        except Exception:
            pass


def _api_cache_touch(path):
    """LRU：命中即刷新 mtime（容量淘汰按 mtime 从最旧开始删）。"""
    try:
        os.utime(path, None)
        API_STATS["touched"] += 1
    except Exception:
        pass


def _api_cache_usage():
    """-> (目录总字节, {key: 主文件 mtime})，只 stat 不读内容。"""
    total = 0
    newest = {}
    try:
        for e in os.scandir(API_CACHE_DIR):
            try:
                if not e.is_file():
                    continue
                st = e.stat()
            except Exception:
                continue
            total += st.st_size
            if e.name.endswith(".json"):
                k = e.name[:-5]
                if st.st_mtime > newest.get(k, 0):
                    newest[k] = st.st_mtime
    except Exception:
        pass
    return total, newest


def _api_cache_store(key, head_b, body, ttl=None, swr=None, imm=False, rid=None):
    """Atomically write one entry: <json meta>\n<raw uncompressed body> (+ br/gz sidecars).

    imm=True 标记"历史页不可变"条目：用 PAGE_IMM_TTL/PAGE_IMM_SWR（默认 7 天 + 7 天）。
    rid 是这条响应里回显的 rpcId：回放时要换成调用方自己的 rpcId，否则客户端
    `rpcId mismatch` 直接抛错（实测就是这个让"加载更早"拿到了数据却不入窗口）。
    RPC 错误信封（result.ok=false）一律不写。
    """
    if _api_is_error(body):
        log("api cache: NOT caching error envelope for key=%s (%d B)" % (key[:8], len(body)))
        return False
    if ttl is None:
        ttl = API_CACHE_TTL
    if swr is None:
        swr = API_CACHE_SWR
    try:
        if not os.path.isdir(API_CACHE_DIR):
            os.makedirs(API_CACHE_DIR)
        keep = []
        for l in head_b.split(b"\r\n")[1:]:
            if not l:
                continue
            if re.match(rb"(?i)^(content-type|cache-control|content-language):", l):
                keep.append(l.decode("latin-1"))
        meta = {"ts": time.time(), "h": keep, "r": _api_sessions_running(body),
                "imm": bool(imm), "ttl": float(ttl), "swr": float(swr), "n": len(body),
                "rid": rid if isinstance(rid, str) else None}
        p = os.path.join(API_CACHE_DIR, key + ".json")
        tmp = p + ".tmp"
        with open(tmp, "wb") as f:
            f.write(json.dumps(meta, separators=(",", ":")).encode("utf-8"))
            f.write(b"\n")
            f.write(body)
        os.replace(tmp, p)
        _api_cache_sidecars(key, body)
        API_STORES[0] += 1
        API_STATS["store"] += 1
        if imm:
            API_STATS["imm_store"] += 1
        if API_STORES[0] % API_CACHE_SWEEP == 0:
            _api_cache_prune()
        return True
    except Exception as e:
        log("api cache store failed: %r" % (e,))
        return False


def _api_cache_get(key):
    """-> dict(ts, hdrs, body, run, imm, ttl, swr, path) or None."""
    p = os.path.join(API_CACHE_DIR, key + ".json")
    try:
        with open(p, "rb") as f:
            raw = f.read()
    except Exception:
        return None
    i = raw.find(b"\n")
    if i <= 0:
        return None
    try:
        meta = json.loads(raw[:i].decode("utf-8"))
        body = raw[i + 1:]
        if _api_is_error(body):
            # 旧版本或异常路径写进来的失败信封：删掉，绝不回放
            _api_cache_drop(key)
            return None
        rid = meta.get("rid")
        if not isinstance(rid, str) or not rid:
            # 旧版本写下的条目没记录 rpcId，无法正确回显 -> 当作未命中，下次请求会重写它
            return None
        return {"ts": float(meta.get("ts") or 0),
                "hdrs": [str(x) for x in (meta.get("h") or [])],
                "body": body,
                "run": bool(meta.get("r")),
                "imm": bool(meta.get("imm")),
                "ttl": float(meta.get("ttl") or API_CACHE_TTL),
                "swr": float(meta.get("swr") or API_CACHE_SWR),
                "rid": rid if isinstance(rid, str) and rid else None,
                "path": p}
    except Exception:
        return None


def _api_cache_prune():
    """① 按条目自身的 TTL+SWR+GRACE 回收过期；② 超出容量上限就按 mtime 做 LRU。"""
    try:
        if not os.path.isdir(API_CACHE_DIR):
            return
        now = time.time()
        # ① 过期回收（只读元数据首行；上限 400 条/次，避免目录很大时拖住事件循环）
        _, ages = _api_cache_usage()
        read = 0
        aged = 0
        for k in list(ages.keys()):
            if read >= 400:
                break
            if now - ages[k] <= API_CACHE_KEEP:
                continue          # 刚写过的条目不可能过期
            p = os.path.join(API_CACHE_DIR, k + ".json")
            try:
                with open(p, "rb") as f:
                    first = f.readline()
                m = json.loads(first.decode("utf-8"))
                read += 1
                ts = float(m.get("ts") or 0)
                life = (float(m.get("ttl") or API_CACHE_TTL)
                        + float(m.get("swr") or API_CACHE_SWR) + API_CACHE_GRACE)
            except Exception:
                _api_cache_drop(k)
                continue
            if now - ts > life:
                _api_cache_drop(k)
                aged += 1
                API_STATS["expired"] += 1
        # ② 容量 LRU
        total, ages = _api_cache_usage()
        if total > API_CACHE_MAXBYTES:
            limit = int(API_CACHE_MAXBYTES * API_CACHE_LOW)
            evicted = 0
            for k, _mt in sorted(ages.items(), key=lambda kv: kv[1]):
                if total <= limit:
                    break
                sz = 0
                for ext in (".json", ".br", ".gz"):
                    try:
                        sz += os.path.getsize(os.path.join(API_CACHE_DIR, k + ext))
                    except Exception:
                        pass
                _api_cache_drop(k)
                total -= sz
                evicted += 1
                API_STATS["evict"] += 1
            log("api cache LRU: %d entries evicted, %d B left (cap %d B)"
                % (evicted, total, API_CACHE_MAXBYTES))
        if aged or read:
            log("api cache prune: expired=%d scanned=%d bytes=%d" % (aged, read, total))
    except Exception as e:
        log("api cache prune failed: %r" % (e,))


def _compress(nb, want_br, want_gz):
    """br when the client allows it, else gzip. Oversized bodies stay identity."""
    if len(nb) > API_CACHE_MAXBODY:
        return nb, None
    if want_br:
        try:
            return brotli.compress(nb, quality=5, lgwin=24), b"br"
        except Exception as e:
            log("brotli failed (%r) -> gzip" % (e,))
    if want_gz:
        return gzip.compress(nb, 6), b"gzip"
    return nb, None


async def _read_req_body(reader, rest, clen):
    """Read exactly clen bytes of request body (rest already holds the first chunk)."""
    buf = bytes(rest[:clen])
    while len(buf) < clen:
        try:
            chunk = await reader.read(min(65536, clen - len(buf)))
        except Exception:
            break
        if not chunk:
            break
        buf += chunk
    return buf


async def _send_api_cached(writer, ent, state, now, client_close, set_cookie, want_br, want_gz,
                      rid=None):
    """Reply from disk.

    The stored body echoes the rpcId of whichever request populated the entry; the caller
    verifies its OWN rpcId, so it is rewritten here. That rewrite invalidates the
    pre-compressed sidecar (it is bound to the stored bytes), so a rewrite recompresses.
    """
    body = ent["body"]
    if rid and ent.get("rid") and rid != ent["rid"]:
        old = ('"rpcId":"%s"' % ent["rid"]).encode("utf-8")
        if old in body:
            body = body.replace(old, ('"rpcId":"%s"' % rid).encode("utf-8"), 1)
            API_STATS["ridfix"] += 1
            ent = dict(ent)
            ent["body"] = body
            ent["path"] = None            # no sidecar: bytes changed
    nb, enc = body, None
    if API_CACHE_COMPRESS:
        side = None
        if ent.get("path") and want_br and brotli is not None:
            side, enc = ent["path"][:-5] + ".br", b"br"
        elif ent.get("path") and want_gz:
            side, enc = ent["path"][:-5] + ".gz", b"gzip"
        if side is not None:
            try:
                with open(side, "rb") as f:
                    nb = f.read()
            except Exception:
                nb, enc = _compress(body, want_br, want_gz)
        else:
            nb, enc = _compress(body, want_br, want_gz)
    age = max(0, int(now - ent["ts"]))
    out = ["HTTP/1.1 200 OK"]
    out.extend(ent["hdrs"])
    out.append("X-DSH-Cache: " + state)
    out.append(CACHE_AGE_HDR + ": %d" % age)
    out.append("Age: %d" % age)
    out.append("Vary: Accept-Encoding")
    if enc:
        out.append("Content-Encoding: " + enc.decode())
    out.append("Content-Length: %d" % len(nb))
    if set_cookie:
        out.append("Set-Cookie: " + set_cookie)
    out.append("Connection: " + ("close" if client_close else "keep-alive"))
    writer.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1") + nb)
    await writer.drain()
    return not client_close


async def _api_refresh(key, target, body, trim, lmode="N", ttl=None, swr=None, imm=False):
    """Background revalidation for a stale entry (stale-while-revalidate)."""
    try:
        name, value = cookie_for(HOST_REWRITE)
        hdrs = ["Host: " + HOST_REWRITE, "Origin: http://" + HOST_REWRITE,
                "Cookie: %s=%s" % (name, value),
                "Content-Type: application/json",
                "Content-Length: %d" % len(body),
                "Connection: close"]
        out = ("POST %s HTTP/1.1\r\n" % target) + "\r\n".join(hdrs) + "\r\n\r\n"
        tr, tw = await asyncio.open_connection(*TARGET)
        tw.write(out.encode("latin-1") + body)
        await tw.drain()
        raw = b""
        while True:
            chunk = await tr.read(65536)
            if not chunk:
                break
            raw += chunk
        try:
            tw.close()
        except Exception:
            pass
        head_b, _, body_b = raw.partition(b"\r\n\r\n")
        if b"chunked" in head_b.lower():
            body_b = _dechunk(body_b)
        if not head_b.startswith(b"HTTP/1.1 200"):
            log("api swr refresh: %s" % head_b.split(b"\r\n")[0][:44])
            return
        nb = body_b
        if trim or lmode != "N":
            data = json.loads(body_b.decode("utf-8", "replace"))
            if trim:
                data = trim_payload(target.split("?")[0], data)
            if lmode != "N":
                data = trim_session_list(data, lmode == "L")
            nb = _json_bytes(data)
        if _api_cache_store(key, head_b, nb, ttl=ttl, swr=swr, imm=imm,
                            rid=_api_rpc_id(body)):
            log("api swr refreshed %s -> %d B imm=%d" % (key[:8], len(nb), 1 if imm else 0))
    except Exception as e:
        log("api swr refresh failed: %r" % (e,))


def _spawn_refresh(key, target, body, trim, lmode="N", ttl=None, swr=None, imm=False):
    """One refresh per key at a time (no stampede when several polls go stale)."""
    if key in API_INFLIGHT:
        return
    API_INFLIGHT.add(key)

    async def run():
        try:
            await _api_refresh(key, target, body, trim, lmode, ttl, swr, imm)
        finally:
            API_INFLIGHT.discard(key)

    asyncio.ensure_future(run())


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (datetime.datetime.now().strftime("%F %T"), msg))
    except Exception:
        pass


def access_key():
    if os.path.isfile(KEY_FILE):
        k = open(KEY_FILE, encoding="utf-8").read().strip()
        if k:
            return k
    k = secrets.token_urlsafe(24)
    with open(KEY_FILE, "w", encoding="utf-8") as f:
        f.write(k)
    return k


def b64url(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def load_secret():
    raw = open(CREDS, encoding="utf-8", errors="replace").read()
    m = re.search(r"^\s*secret:\s*([A-Za-z0-9_-]{43})\s*$", raw, re.M)
    if not m:
        raise RuntimeError("secret not found in credentials file")
    s = m.group(1)
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


KEY = access_key()
SECRET = load_secret()
_cache = {}  # authority -> (name, value, issuedAt)


def authority_from_host(host):
    """Mimic the harness: new URL('http://' + host).host"""
    if not host:
        return None
    try:
        h = host.strip()
        return h.lower()
    except Exception:
        return None


def cookie_for(authority):
    now = int(time.time() * 1000)
    hit = _cache.get(authority)
    if hit and (now - hit[2]) < RENEW_AFTER:
        return hit[0], hit[1]
    payload = {"version": 1, "authority": authority, "issuedAt": now, "expiresAt": now + DAYS * 86400000}
    body = b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = b64url(hmac.new(SECRET, body.encode(), hashlib.sha256).digest())
    name = "dsh-auth-" + b64url(hashlib.sha256(authority.encode()).digest())
    value = "v1." + body + "." + sig
    _cache[authority] = (name, value, now)
    log("minted cookie for authority %s" % authority)
    return name, value


def parse_cookies(header):
    out = {}
    for seg in (header or "").split(";"):
        if "=" in seg:
            k, _, v = seg.partition("=")
            out[k.strip()] = v.strip()
    return out


def send_simple(writer, status, reason, text):
    body = text.encode()
    head = ("HTTP/1.1 %d %s\r\nContent-Type: text/plain; charset=utf-8\r\n"
            "Content-Length: %d\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"
            % (status, reason, len(body)))
    writer.write(head.encode("latin-1") + body)
    return writer.drain()


async def read_head(reader, limit=262144):
    buf = b""
    while b"\r\n\r\n" not in buf:
        try:
            chunk = await reader.read(4096)
        except Exception:
            return None
        if not chunk:
            return None
        buf += chunk
        if len(buf) > limit:
            return None
    head, _, rest = buf.partition(b"\r\n\r\n")
    return head, rest


async def pump(reader, writer, close=True):
    """Copy reader -> writer. close=False keeps the destination open (keep-alive reuse)."""
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        if close:
            try:
                writer.close()
            except Exception:
                pass


# ===================== 手机端只读文件接口（/f /d /dl） =====================
# 目的：手机上点开文件 / "在应用中打开" 时，直接在手机里看，而不是把打开动作
# 委派给电脑上的应用（那条路在手机上没有意义）。
#
#   GET /f?path=<...>&k=<cap.key>    内联预览（Content-Disposition: inline）
#   GET /d?path=<目录>&k=<cap.key>   目录列表页（HTML，可点进子目录/文件）
#   GET /dl?path=<...>&k=<cap.key>   强制下载（attachment）
#
# 安全边界（只读）：
#   1. 路径先 URL 解码再 realpath；含 NUL、含 ".." 段、非绝对路径一律 403；
#   2. realpath 结果必须落在 _FILE_ROOTS 之内（Windows 大小写不敏感），否则 403
#      —— 符号链接逃逸、C:\Windows 等都因此被拒；
#   3. 只允许普通文件/目录；不是就 403/404；没有任何写、删、执行路径；
#   4. 全部响应带 Cache-Control: no-store 与 X-Content-Type-Options: nosniff，
#      HTML 文件按 text/plain 返回（防 XSS）；
#   5. 鉴权与现有一致：?k=<cap.key> 或 dshcap cookie 都行。
#
# 允许的根目录：默认 PROJECT_ROOT（本代理所在的 DSH 会话工作区 <WORKSPACE>）；
# 需要更多根目录时用环境变量 DSH_FILE_ROOTS 追加（os.pathsep / ; / , 分隔）。
_FILE_ROOTS_CFG = [p for p in os.environ.get(
    "DSH_FILE_ROOTS",
    r"<WORKSPACE>").split(os.pathsep) if p.strip()]


def _file_roots():
    """(realpath, realpath-lowercase) 允许根目录白名单，每次请求重算。"""
    roots = []
    for p in _FILE_ROOTS_CFG:
        for piece in re.split(r"[;,]", p):
            piece = piece.strip().strip('"')
            if not piece:
                continue
            try:
                rp = os.path.realpath(os.path.abspath(piece))
            except Exception:
                continue
            roots.append((rp, rp.lower()))
    return roots


_FILE_MIME = {
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".ini": "text/plain; charset=utf-8",
    ".cfg": "text/plain; charset=utf-8",
    ".conf": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
    ".xml": "text/plain; charset=utf-8",
    ".yml": "text/plain; charset=utf-8",
    ".yaml": "text/plain; charset=utf-8",
    ".toml": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
    ".pyw": "text/plain; charset=utf-8",
    ".js": "text/plain; charset=utf-8",
    ".mjs": "text/plain; charset=utf-8",
    ".cjs": "text/plain; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
    ".css": "text/plain; charset=utf-8",
    ".sh": "text/plain; charset=utf-8",
    ".bat": "text/plain; charset=utf-8",
    ".cmd": "text/plain; charset=utf-8",
    ".ps1": "text/plain; charset=utf-8",
    ".vbs": "text/plain; charset=utf-8",
    ".sql": "text/plain; charset=utf-8",
    # HTML 一律按纯文本（绝不当 HTML 渲染，防 XSS）
    ".html": "text/plain; charset=utf-8",
    ".htm": "text/plain; charset=utf-8",
    ".xhtml": "text/plain; charset=utf-8",
    ".svg": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jfif": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
}
_FILE_HTML = ("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
              "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
              "<title>DSH 文件</title><style>"
              "body{background:#0b0f14;color:#e8eef7;font:15px/1.6 -apple-system,"
              "BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',system-ui,sans-serif;margin:0;padding:14px}"
              "a{color:#7fb2ff;text-decoration:none}code{background:#16202c;padding:1px 5px;border-radius:5px}"
              ".row{display:flex;gap:10px;padding:9px 4px;border-bottom:1px solid #1e2836;align-items:center}"
              ".n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
              ".s{color:#8fa0b5;font-size:12px;white-space:nowrap}"
              ".h{color:#8fa0b5;font-size:13px;margin:6px 0 12px;word-break:break-all}</style></head><body>")
_FILE_ERR = ("<!doctype html><html><head><meta charset=\"utf-8\">"
             "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
             "<title>%s</title></head><body style=\"background:#0b0f14;color:#e8eef7;"
             "font:16px/1.6 system-ui,sans-serif;padding:22px\"><h3>%s</h3><p>%s</p></body></html>")


def _file_ct(path):
    """扩展名 -> Content-Type；未知回落到 mimetypes，再回落到 octet-stream。"""
    ext = os.path.splitext(path)[1].lower()
    ct = _FILE_MIME.get(ext)
    if ct:
        return ct
    guess, _enc = mimetypes.guess_type(path)
    if guess:
        if guess.startswith("text/"):
            return guess + "; charset=utf-8"
        return guess
    return "application/octet-stream"


def _file_qs(uri):
    """把 /f?path=...&k=... 解析成 (path, key)，-k 用 %6B / %4B 变体也认。"""
    q = uri.split("?", 1)[1] if "?" in uri else ""
    path = key = None
    key_re = re.compile(r"[?&](?:k|%6[bB]|%4[bB])=([^&\s]*)")
    for part in q.split("&"):
        if not part:
            continue
        if "=" not in part:
            continue
        k0, _, v0 = part.partition("=")
        name = k0.lower()
        if name in ("k", "%6b", "%4b"):
            key = urllib.parse.unquote_plus(v0)
        elif name == "path":
            path = v0
    if key is None:
        m = key_re.search("?" + q)
        if m:
            key = urllib.parse.unquote_plus(m.group(1))
    return path, key


def _file_keyok(uri, cookie_key_ok=False):
    """鉴权：?k=<cap.key> 或外层已用 dshcap cookie 通过都算。"""
    key = _file_qs(uri)[1]
    if key is not None and key == KEY:
        return True
    return bool(cookie_key_ok)


def _file_ok(uri, cookie_key_ok=False):
    """(ok, resolved_path, out_path_or_error)。鉴权 + 路径白名单都过才 ok。"""
    raw, key = _file_qs(uri)
    if not _file_keyok(uri, cookie_key_ok):
        return False, None, "access key required"
    if raw is None or raw == "":
        return False, None, "missing path"
    try:
        p = urllib.parse.unquote(raw)
    except Exception:
        return False, None, "bad path"
    if "\x00" in p:
        return False, None, "bad path"
    for seg in re.split(r"[\\/]+", p):
        if seg == "..":
            return False, None, "path traversal rejected"
    if not re.match(r"^[A-Za-z]:[\\/]", p) and not os.path.isabs(p):
        return False, None, "path must be absolute"
    try:
        rp = os.path.realpath(os.path.abspath(p))
    except Exception:
        return False, None, "bad path"
    low = rp.lower()
    for _r, rl in _file_roots():
        if low == rl or low.startswith(rl + os.sep):
            return True, rp, rp
    return False, None, "path outside the allowed roots"


def _file_hdrs(ct, disp, n, close):
    return ("HTTP/1.1 200 OK\r\nContent-Type: " + ct + "\r\n"
            "Content-Disposition: " + disp + "\r\nContent-Length: " + str(n) + "\r\n"
            "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
            "Accept-Ranges: none\r\nConnection: " + ("close" if close else "keep-alive")
            + "\r\n\r\n")


def _file_fail(writer, status, reason, note):
    """统一的失败响应（HTML，带正确状态码）。"""
    body = (_FILE_ERR % (str(status), str(reason), _file_esc(note))).encode("utf-8")
    head = ("HTTP/1.1 " + str(status) + " " + reason + "\r\n"
            "Content-Type: text/html; charset=utf-8\r\nContent-Length: " + str(len(body))
            + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
            "Connection: close\r\n\r\n")
    writer.write(head.encode("latin-1") + body)
    return writer.drain()


async def _file_stream(writer, f, total):
    sent = 0
    while sent < total:
        chunk = f.read(min(65536, total - sent))
        if not chunk:
            break
        writer.write(chunk)
        sent += len(chunk)
        await writer.drain()
    return sent


def _file_esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))


def _file_size(n):
    try:
        n = float(n)
    except Exception:
        return "-"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%d %s" % (n, unit)) if unit == "B" else ("%.1f %s" % (n, unit))
        n /= 1024.0


async def _file_listing(writer, uri, rp, close):
    """目录列表页：面包屑 + 子目录 + 文件（文件给 /f 内联预览与 /dl 下载两个链接）。"""
    key = _file_qs(uri)[1] or ""
    kq = urllib.parse.quote(key, safe="")
    parent = None
    for _r, rl in _file_roots():
        if rp.lower() == rl:
            parent = rp
            break
    try:
        names = sorted(os.listdir(rp))
    except Exception as e:
        await _file_fail(writer, 500, "Internal Server Error", "listdir failed")
        log("file listdir failed %s: %r" % (rp, e))
        return False
    entries = []
    for n in names:
        full = os.path.join(rp, n)
        try:
            isdir = os.path.isdir(full)
            sz = 0 if isdir else os.path.getsize(full)
        except Exception:
            continue
        entries.append((isdir, n, sz))
    entries.sort(key=lambda t: (not t[0], t[1].lower()))
    rows = []
    if parent is not None:
        rows.append('<div class="row"><a class="n" href="/d?path=%s&k=%s">..</a>'
                    '<span class="s">上级目录</span></div>'
                    % (urllib.parse.quote(os.path.dirname(rp), safe=""), kq))
    for isdir, n, sz in entries:
        full = os.path.join(rp, n)
        q = urllib.parse.quote(full, safe="")
        if isdir:
            rows.append('<div class="row"><a class="n" href="/d?path=%s&k=%s">%s/</a>'
                        '<span class="s">dir</span></div>' % (q, kq, _file_esc(n)))
        else:
            rows.append('<div class="row"><a class="n" href="/f?path=%s&k=%s">%s</a>'
                        '<span class="s">%s</span>'
                        '<a class="s" href="/dl?path=%s&k=%s">下载</a></div>'
                        % (q, kq, _file_esc(n), _file_size(sz), q, kq))
    html = (_FILE_HTML + '<div class="h">目录 <code>' + _file_esc(rp) + "</code><br>"
            + ("<a href=\"/d?path=%s&k=%s\">..</a> &middot; " % (
                urllib.parse.quote(os.path.dirname(rp), safe=""), kq) if parent else "")
            + '共 %d 项</div>' % len(entries) + "".join(rows) + "</body></html>")
    body = html.encode("utf-8")
    head = ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
            "Content-Length: " + str(len(body)) + "\r\nCache-Control: no-store\r\n"
            "X-Content-Type-Options: nosniff\r\nConnection: "
            + ("close" if close else "keep-alive") + "\r\n\r\n")
    writer.write(head.encode("latin-1") + body)
    return writer.drain()


async def _file_serve(writer, uri, cookie_key_ok, peer_ip, client_close):
    """处理 /f /dl /d。返回 True 表示已应答（调用方直接结束本次请求）。"""
    route = uri.split("?", 1)[0]
    ok, rp, info = _file_ok(uri, cookie_key_ok)
    if not ok:
        if "access key" in str(info):
            log("file DENY %s %s from %s" % (route, info, peer_ip))
            await _file_fail(writer, 403, "Forbidden", info)
            return True
        status = 403 if ("outside" in str(info) or "traversal" in str(info)
                         or "absolute" in str(info)) else 400
        log("file DENY %s %s from %s" % (route, info, peer_ip))
        await _file_fail(writer, status, "Forbidden" if status == 403 else "Bad Request", info)
        return True
    if os.path.isdir(rp):
        if route != "/d":
            await _file_fail(writer, 400, "Bad Request", "is a directory; use /d?path=...")
            return True
        if not await _file_listing(writer, uri, rp, client_close):
            return True
        log("file dir %s -> %s" % (rp, peer_ip))
        return True
    if route == "/d":
        await _file_fail(writer, 404, "Not Found", "not a directory")
        return True
    if not os.path.isfile(rp):
        log("file 404 %s from %s" % (rp, peer_ip))
        await _file_fail(writer, 404, "Not Found", "no such file")
        return True
    try:
        total = os.path.getsize(rp)
        f = open(rp, "rb")
    except Exception as e:
        log("file open failed %s: %r" % (rp, e))
        await _file_fail(writer, 500, "Internal Server Error", "open failed")
        return True
    ct = _file_ct(rp)
    name = os.path.basename(rp)
    disp = ("attachment; filename=\"" + _file_esc(name) + "\"" if route == "/dl"
            else "inline; filename=\"" + _file_esc(name) + "\"")
    try:
        writer.write(_file_hdrs(ct, disp, total, client_close).encode("latin-1"))
        sent = await _file_stream(writer, f, total)
    finally:
        try:
            f.close()
        except Exception:
            pass
    log("file %s %s -> %d B %s (%s)" % (route, rp, sent, ct.split(";")[0], peer_ip))
    return True

# ===================== 热补丁通道（hotpatch） =====================
# 目的：让前端小改动不必重装 APK，也不必重启代理。
#
#   hotpatch/ 目录
#     *.css  按文件名排序拼接（原样）
#     *.js   按文件名排序拼接；**每个文件各自包一层 IIFE + try/catch**
#
#   每个 HTML 页面响应都会被注入（手机 UA 与桌面 UA 都注入；补丁内容想只对手机生效
#   由补丁自己判断）：
#     <link rel="stylesheet" id="dsh-hot-css" href="/__hot/patch.css?v=<mtime-hash>">  （</head> 前）
#     <script id="dsh-hot" src="/__hot/patch.js?v=<mtime-hash>"></script>            （页面最后）
#
#   /__hot/patch.css 与 /__hot/patch.js **每次请求都从磁盘重读**（进程内不做任何缓存）
#   —— 这就是"改文件 -> 刷新即生效、无需重启代理"的全部实现方式。
#   ?v= 由 文件名+mtime+size 派生：文件一变 URL 就变，不会被浏览器旧缓存粘住；
#   路由本身再补 Cache-Control: no-store 双保险。
#
#   关闭：?no-hot=1（只影响这一次请求）或环境变量 DSH_HOTPATCH=0（整体）。
#   目录不存在 / 为空：路由返回空内容（HTTP 200，不报错），页面照常加载。
HOT_DIR = os.path.join(D, "hotpatch")
HOT_CSS_ROUTE = "/__hot/patch.css"
HOT_JS_ROUTE = "/__hot/patch.js"
HOT_STATUS_ROUTE = "/__hot/status"
HOT_ON = os.environ.get("DSH_HOTPATCH", "1") != "0"
HOT_SEP = "\n;\n"          # 补丁文件之间的分隔符：杜绝 ASI 拼接问题
HOT_STATE = {"reads": 0, "inject": 0, "css_files": 0, "js_files": 0,
             "last_css": "-", "last_js": "-"}


def _hot_names(ext):
    """hotpatch 目录里按文件名排序的 *.ext。目录不存在/读不了一律返回 []，绝不抛。"""
    try:
        if not os.path.isdir(HOT_DIR):
            return []
        return sorted(n for n in os.listdir(HOT_DIR)
                      if n.lower().endswith(ext)
                      and os.path.isfile(os.path.join(HOT_DIR, n)))
    except Exception as e:
        log("hotpatch list failed: %r" % (e,))
        return []


def hot_bundle(kind):
    """读盘拼接补丁，返回 (text, file_count, version)。每次调用都真的读盘。"""
    ext = ".css" if kind == "css" else ".js"
    chunks, stamps = [], []
    for n in _hot_names(ext):
        p = os.path.join(HOT_DIR, n)
        try:
            with open(p, "r", encoding="utf-8", errors="replace", newline="") as f:
                src = f.read()
        except Exception as e:
            log("hotpatch read failed (%s): %r" % (n, e))
            continue
        if kind == "js":
            # 每个补丁文件独立包 IIFE + try/catch：某个文件抛异常不影响其它文件，
            # 更不影响页面本身；异常进 window.__dshHotErrors，诊断页可读。
            chunks.append(
                ";(function(){try{\n" + src + "\n}catch(e){try{"
                "(window.__dshHotErrors=window.__dshHotErrors||[]).push("
                "{f:" + json.dumps(n) + ",e:String((e&&e.stack)||e),t:Date.now()});"
                "}catch(_){}}})();")
        else:
            chunks.append(src)
        try:
            st = os.stat(p)
            stamps.append("%s:%d:%d" % (n, int(st.st_mtime * 1000), st.st_size))
        except Exception:
            stamps.append(n)
    ver = hashlib.sha1("|".join(stamps).encode("utf-8")).hexdigest()[:10] if stamps else "0"
    return HOT_SEP.join(chunks), len(chunks), ver


def hot_tags(target):
    """产出 (head_link_bytes, tail_script_bytes)。目录为空时也照常产出（v=0、路由回空内容），
    让"有没有通道"和"有没有补丁"解耦：注入永远发生，补丁内容按需出现。"""
    _c, nc, vc = hot_bundle("css")
    _j, nj, vj = hot_bundle("js")
    link = ('<link rel="stylesheet" id="dsh-hot-css" href="%s?v=%s">'
            % (HOT_CSS_ROUTE, vc)).encode("utf-8")
    script = ('<script id="dsh-hot" src="%s?v=%s"></script>'
              % (HOT_JS_ROUTE, vj)).encode("utf-8")
    HOT_STATE["css_files"] = nc
    HOT_STATE["js_files"] = nj
    HOT_STATE["last_css"] = "n=%d v=%s" % (nc, vc)
    HOT_STATE["last_js"] = "n=%d v=%s" % (nj, vj)
    return link, script


def hot_inject(html_bytes, target):
    """把热补丁标签插进 HTML。返回 (html, injected)。

    · 只应由调用方在确认 Content-Type 是 text/html 后调用；
    · 幂等：已经注入过就原样返回（重放/重复渲染安全）；
    · 关闭：DSH_HOTPATCH=0 或 ?no-hot=1；
    · CSS 放 </head> 前（没有 </head> 就放最前），JS 放页面最后（其它注入之后）。
    """
    if not HOT_ON:
        return html_bytes, False
    if "no-hot=1" in (target or ""):
        return html_bytes, False
    if b"__hot/patch.js" in html_bytes and b"__hot/patch.css" in html_bytes:
        return html_bytes, False
    try:
        link, script = hot_tags(target)
        if b"__hot/patch.css" not in html_bytes:
            i = html_bytes.lower().rfind(b"</head>")
            if i >= 0:
                html_bytes = html_bytes[:i] + link + html_bytes[i:]
            else:
                html_bytes = link + html_bytes
        if b"__hot/patch.js" not in html_bytes:
            html_bytes = html_bytes + b"\n" + script
        HOT_STATE["inject"] += 1
        return html_bytes, True
    except Exception as e:
        log("hotpatch inject failed: %r" % (e,))
        return html_bytes, False


def hot_status_text():
    """诊断用：当前 hotpatch 目录内容 + 通道统计（纯文本）。"""
    out = ["hotpatch=%d dir=%s exists=%d" % (1 if HOT_ON else 0, HOT_DIR,
                                             1 if os.path.isdir(HOT_DIR) else 0),
           "inject=%d reads=%d" % (HOT_STATE["inject"], HOT_STATE["reads"]),
           "last_css=%s last_js=%s" % (HOT_STATE["last_css"], HOT_STATE["last_js"])]
    for kind in ("css", "js"):
        for n in _hot_names("." + kind):
            try:
                st = os.stat(os.path.join(HOT_DIR, n))
                out.append("%-4s %-28s %8dB mtime=%.3f" % (kind, n, st.st_size, st.st_mtime))
            except Exception as e:
                out.append("%-4s %-28s (stat failed %r)" % (kind, n, e))
    _c, nc, vc = hot_bundle("css")
    _j, nj, vj = hot_bundle("js")
    out.append("bundled css n=%d v=%s bytes=%d" % (nc, vc, len(_c.encode("utf-8"))))
    out.append("bundled js  n=%d n=%d v=%s bytes=%d" % (nj, nj, vj, len(_j.encode("utf-8"))))
    return "\n".join(out) + "\n"


async def serve_once(reader, writer, peer_ip):
    """Handle one request; return True to keep the client connection alive.
    Phones reach us through a Tailscale DERP relay (300-450ms RTT), so reusing the
    connection avoids 2-3 extra round trips per resource (minutes -> seconds)."""
    if True:
        got = await read_head(reader)
        if not got:
            return False
        head, rest = got
        lines = head.decode("latin-1").split("\r\n")
        reqline = lines[0]
        if not reqline:
            writer.close()
            return False
        parts = reqline.split(" ")
        t_req = time.time()
        target = parts[1] if len(parts) > 1 else "/"
        hdrs_in = [h for h in lines[1:] if h]
        # Does the client want to close? (HTTP/1.1 keeps alive by default)
        client_close = any(h.lower().startswith("connection:") and "close" in h.lower() for h in hdrs_in)
        host = next((h.split(":", 1)[1].strip() for h in hdrs_in if h.lower().startswith("host:")), "")
        cookies = parse_cookies(next((h.split(":", 1)[1] for h in hdrs_in if h.lower().startswith("cookie:")), ""))

        if target.rstrip("/") == HEALTH_PATH:
            log("health from %s (host=%s)" % (peer_ip, host))
            await send_simple(writer, 200, "OK", "proxy-ok\n")
            return False

        # 调试/回归用：运行时读取或设置 session/page 单页上限（GET 且要带正确的 k=）
        if target.split("?")[0] == "/__pagecap":
            _bad = not (cookies.get(CAP_COOKIE) == KEY or re.search(r"[?&]k=([^&\s]+)", target)
                        and re.search(r"[?&]k=([^&\s]+)", target).group(1) == KEY)
            if _bad:
                await send_simple(writer, 403, "Forbidden", "access key required\n")
                return False
            m2 = re.search(r"[?&]n=(-?\d+)", target)
            if m2:
                global PAGE_MSG_LIMIT
                PAGE_MSG_LIMIT = max(1, int(m2.group(1)))
                log("page cap set to %d by %s" % (PAGE_MSG_LIMIT, peer_ip))
            await send_simple(writer, 200, "OK",
                              "pagecap=%d applied=%d wscap=%d\n"
                              % (PAGE_MSG_LIMIT, PAGE_CAP_APPLIED[0], WS_CAP_APPLIED[0]))
            return False

        # 调试/回归用：读 API 磁盘缓存统计（GET，要带正确的 k=）；sweep=1 强制跑一次淘汰
        if target.split("?")[0] == "/__apicache":
            _mk = re.search(r"[?&]k=([^&\s]+)", target)
            if not (cookies.get(CAP_COOKIE) == KEY or (_mk and _mk.group(1) == KEY)):
                await send_simple(writer, 403, "Forbidden", "access key required\n")
                return False
            if "sweep=1" in target:
                _api_cache_prune()
            _tot, _new = _api_cache_usage()
            await send_simple(
                writer, 200, "OK",
                "entries=%d bytes=%d max_bytes=%d low=%.2f hit=%d stale=%d miss=%d store=%d"
                " imm_store=%d evict=%d expired=%d touched=%d pagecap=%d applied=%d"
                " wscap=%d ridfix=%d immttl=%.0f immswr=%.0f\n"
                % (len(_new), _tot, API_CACHE_MAXBYTES, API_CACHE_LOW,
                   API_STATS["hit"], API_STATS["stale"], API_STATS["miss"], API_STATS["store"],
                   API_STATS["imm_store"], API_STATS["evict"], API_STATS["expired"],
                   API_STATS["touched"], PAGE_MSG_LIMIT, PAGE_CAP_APPLIED[0],
                   WS_CAP_APPLIED[0], API_STATS["ridfix"],
                   PAGE_IMM_TTL, PAGE_IMM_SWR))
            return False

        # 调试/回归用：运行时读写 session/list 裁剪开关（GET 且要带正确的 k=）
        if target.split("?")[0] == "/__listtrim":
            _bad = not (cookies.get(CAP_COOKIE) == KEY or re.search(r"[?&]k=([^&\s]+)", target)
                        and re.search(r"[?&]k=([^&\s]+)", target).group(1) == KEY)
            if _bad:
                await send_simple(writer, 403, "Forbidden", "access key required\n")
                return False
            m3 = re.search(r"[?&]v=(0|1)", target)
            if m3:
                LIST_TRIM_STATE[0] = m3.group(1) == "1"
                log("list trim set to %s by %s" % (LIST_TRIM_STATE[0], peer_ip))
            m4 = re.search(r"[?&]p=(0|1)", target)
            if m4:
                LIST_TRIM_PROJ_STATE[0] = m4.group(1) == "1"
                log("list trim proj set to %s by %s" % (LIST_TRIM_PROJ_STATE[0], peer_ip))
            await send_simple(writer, 200, "OK",
                              "listtrim=%d proj=%d\n" % (1 if LIST_TRIM_STATE[0] else 0,
                                                          1 if LIST_TRIM_PROJ_STATE[0] else 0))
            return False

        # --- 手机端只读文件接口 /f /d /dl -----------------------------------------
        # 必须在下面"剥 k="之前处理：那段正则会命中 path 里的 "&k=" 子串
        # （形如 "&k=..." 的查询片段会被当成密钥参数删掉），所以文件路由的鉴权、
        # 路径校验都在这里一次做完（只读，不触碰任何上游）。
        if target.split("?")[0] in ("/f", "/d", "/dl"):
            if await _file_serve(writer, target, cookies.get(CAP_COOKIE) == KEY,
                                 peer_ip, client_close):
                return not client_close

        # DSH fences /api on a loopback Host: any other Host gets 403.
        # So rewrite Host to loopback and sign the cookie for that authority.
        authority = HOST_REWRITE
        if not authority:
            await send_simple(writer, 400, "Bad Request", "missing Host header\n")
            return False

        key_in_query = None
        m = re.search(r"[?&]k=([^&\s]+)", target)
        if m:
            key_in_query = m.group(1)
        authed = cookies.get(CAP_COOKIE) == KEY
        set_cookie = None
        if key_in_query is not None:
            if key_in_query != KEY:
                log("DENY bad-key from %s" % peer_ip)
                await send_simple(writer, 403, "Forbidden", "invalid access key\n")
                return False
            authed = True
            set_cookie = "%s=%s; Path=/; Max-Age=%d; SameSite=Lax" % (CAP_COOKIE, KEY, 365 * 86400)
            target = re.sub(r"([?&])k=[^&\s]*&?", r"\1", target).replace("?&", "?").replace("?&", "?")
            if target[-1:] in ("?", "&"):
                target = target[:-1]
            if not target:
                target = "/"
        # Exact-path exemptions (see GATE_EXEMPT_PATHS). A bad ?k= was already
        # rejected above, so a wrong key still gets 403 here too.
        if target.split("?")[0] in GATE_EXEMPT_PATHS:
            authed = True
        if not authed:
            log("DENY no-cookie from %s (host=%s)" % (peer_ip, host))
            await send_simple(
                writer, 403, "Forbidden",
                "access key required\n\nopen the full link ending with: /?k=<access key>\n"
                "connectivity check (no key): /__health\n",
            )
            return False

        # Mobile page /m/ and APK download /apk are served locally; everything else is the real UI
        _path = target.split("?")[0]


        # --- 热补丁路由：每次都从磁盘重读 -> 改文件后刷新即生效，不用重启代理 ---
        if _path in (HOT_CSS_ROUTE, HOT_JS_ROUTE, HOT_STATUS_ROUTE):
            if _path == HOT_STATUS_ROUTE:
                body = hot_status_text().encode("utf-8")
                _hct = "text/plain; charset=utf-8"
                _hx = ""
            else:
                _hk = "css" if _path == HOT_CSS_ROUTE else "js"
                _htxt, _hn, _hv = hot_bundle(_hk)
                body = _htxt.encode("utf-8")
                _hct = ("text/css; charset=utf-8" if _hk == "css"
                        else "application/javascript; charset=utf-8")
                _hx = "X-DSH-Hotpatch: %s files=%d v=%s\r\n" % (_hk, _hn, _hv)
                HOT_STATE["reads"] += 1
            _hout = ("HTTP/1.1 200 OK\r\n"
                     "Content-Type: %s\r\n"
                     "Content-Length: %d\r\n"
                     "Cache-Control: no-store\r\n"
                     "%s"
                     "Connection: %s\r\n"
                     % (_hct, len(body), _hx, "close" if client_close else "keep-alive"))
            if set_cookie:
                _hout += "Set-Cookie: " + set_cookie + "\r\n"
            writer.write(_hout.encode("latin-1") + b"\r\n" + body)
            await writer.drain()
            log("hotpatch %s -> %d B to %s" % (_path, len(body), peer_ip))
            return not client_close
        _file, _ctype, _disp = None, "text/html; charset=utf-8", None
        if _path in (MOBILE_PATH, MOBILE_PATH + "/"):
            _file = MOBILE_FILE
        elif _path in ("/apk", "/apk/", "/dsh.apk"):
            _file, _ctype = APK_FILE, "application/vnd.android.package-archive"
            _disp = 'attachment; filename="DSH.apk"'
        if _file:
            try:
                body = open(_file, "rb").read()
            except Exception as e:
                log("local file read failed (%s): %r" % (_file, e))
                await send_simple(writer, 500, "Internal Server Error", "local file missing\n")
                return False
            if _ctype.startswith("text/html"):
                # /m/ 轻量页也走同一条热补丁通道（注入顺序与完整版一致：CSS 进 head、JS 放最后）
                try:
                    _hb, _hdone = hot_inject(body, target)
                    if _hdone:
                        body = _hb
                except Exception as e:
                    log("hotpatch inject (/m/) failed: %r" % (e,))
            head = ("HTTP/1.1 200 OK\r\nContent-Type: %s\r\n"
                    "Content-Length: %d\r\nCache-Control: no-store\r\nConnection: %s\r\n"
                    % (_ctype, len(body), "close" if client_close else "keep-alive"))
            if _disp:
                head += "Content-Disposition: " + _disp + "\r\n"
            if set_cookie:
                head += "Set-Cookie: " + set_cookie + "\r\n"
            writer.write(head.encode("latin-1") + b"\r\n" + body)
            await writer.drain()
            log("served %s (%d B) to %s" % (_path, len(body), peer_ip))
            return not client_close      # 本地页面/APK 都是 GET，没有请求体问题

        # ES2019 degraded /plugins/?? bundles: identical files to the APK preinstall, so
        # the phone never has to pull a multi-MB bundle over the relay. Plain (identity)
        # body with an exact Content-Length: no decode step that could fail wholesale.
        _deg = es2019_bundle_file(target)
        if _deg:
            body = es2019_body(_deg)
            out = ("HTTP/1.1 200 OK\r\n"
                   "Content-Type: text/javascript; charset=utf-8\r\n"
                   "Content-Length: %d\r\n"
                   "Cache-Control: public, max-age=31536000, immutable\r\n"
                   "X-DSH-ES2019: 1\r\n"
                   "Connection: %s\r\n"
                   % (len(body), "close" if client_close else "keep-alive"))
            if set_cookie:
                out += "Set-Cookie: " + set_cookie + "\r\n"
            writer.write(out.encode("latin-1") + b"\r\n" + body)
            await writer.drain()
            log("es2019 %s -> %d B to %s" % (target[:44], len(body), peer_ip))
            return not client_close

        name, value = cookie_for(authority)
        is_upgrade = any(re.match(r"(?i)^upgrade:", h) for h in hdrs_in)
        keep_conn = [h for h in hdrs_in if re.match(r"(?i)^connection:", h)] if is_upgrade else []
        hdrs = [h for h in hdrs_in
                if not re.match(r"(?i)^(cookie|connection|proxy-connection|keep-alive|host|origin|referer):", h)]
        hdrs.append("Host: %s" % HOST_REWRITE)
        hdrs.append("Origin: http://%s" % HOST_REWRITE)   # the /api fence also checks Origin
        hdrs.append("Cookie: %s=%s" % (name, value))
        # JSON 瘦身：只对显式带 X-Mobile-Client 的请求（轻量版）生效。
        # 曾改成"默认对所有请求瘦身"，结果完整版打不开（它需要被裁掉的字段）—— 已回滚。
        # 另提供 ?no-trim=1 便于对照。
        _p = target.split("?")[0]
        trim = (parts[0] == "POST" and _p in TRIM_PATHS and "no-trim=1" not in target
                and any(h.lower().startswith("x-mobile-client:") for h in hdrs_in))
        # 侧栏列表瘦身：与上面的 trim 完全独立的开关。
        #   DSH_LIST_TRIM=0 或 ?no-list-trim=1 -> 逐字节回到未裁剪行为
        #   ?no-trim=1 是"这次请求全都不裁"，两套一起短路（保留它原有的语义）
        # lmode 参与缓存键，所以旧缓存不会和裁剪后的响应串味。
        # "?no-trim=1 保持既有语义：这一次请求什么都别裁" —— 所以它同时短路两套裁剪；
        # 而侧栏裁剪另有独立开关 ?no-list-trim=1 / DSH_LIST_TRIM=0，两者互不依赖。
        ltrim = (parts[0] == "POST" and _p == "/api/session/list" and LIST_TRIM_STATE[0]
                 and "no-list-trim=1" not in target and "no-trim=1" not in target)
        ltrim_proj = LIST_TRIM_PROJ_STATE[0] or trim      # 轻量页始终保留 title
        lmode = "N" if not ltrim else ("L" if ltrim_proj else "X")
        # Mobile adaptation: mobile UA + extension-less path (HTML page)
        _ua = next((h.split(":", 1)[1] for h in hdrs_in if h.lower().startswith("user-agent:")), "")
        _mobile_ua = bool(re.search(r"Android|iPhone|iPod|Mobile|HarmonyOS|Windows Phone|BlackBerry|Opera Mini", _ua, re.I))
        adapt = (parts[0] == "GET" and _mobile_ua and "." not in _p.rsplit("/", 1)[-1] and not is_upgrade
                 and "no-adapt=1" not in target)   # A/B switch: disable adaptation
        # 热补丁注入：与 adapt 完全独立的一条通路（手机 UA / 桌面 UA 都注入）。
        # 判定刻意保守 —— 必须是"文档级导航"（Accept: text/html 或 Sec-Fetch-Mode: navigate）
        # 且路径末段没有扩展名；这样绝不碰 SSE / JSON / WebSocket，也不会去缓冲流式响应。
        _acc = next((h.split(":", 1)[1] for h in hdrs_in if h.lower().startswith("accept:")), "")
        _sfm = next((h.split(":", 1)[1] for h in hdrs_in if h.lower().startswith("sec-fetch-mode:")), "")
        _doc_nav = ("text/html" in _acc.lower()) or (_sfm.strip().lower() == "navigate")
        hot = (HOT_ON and parts[0] == "GET" and _doc_nav and not is_upgrade
               and "." not in _p.rsplit("/", 1)[-1] and "no-hot=1" not in target)
        if _p in ("/", "/index.html"):
            log("UA=%r mobile=%s adapt=%s hot=%s" % (_ua[:48], _mobile_ua, adapt, hot))
        # Proxy-side compression: the DSH server gzips /assets/* but NOT the
        # /plugins/?? combo bundles. A phone first load pulls ~11.4 MB of
        # uncompressed plugin JS; compressing here (localhost upstream, no cost)
        # cuts the first-load payload by about half (br when the client allows it).
        _ae = next((h.split(":", 1)[1] for h in hdrs_in if h.lower().startswith("accept-encoding:")), "")
        _ae_l = _ae.lower()
        want_br = ("br" in _ae_l) and (brotli is not None)
        want_gz = "gzip" in _ae_l
        gzip_paths = ("/plugins/", "/assets/", "/static/")
        # 巨型合并包 /plugins/??@scope/pkg/... 的原样透传判定。
        # 旧写法 `_p.startswith("/plugins/??")` 恒为假：_p 是 target 按 "?" 切分的首段，
        # 对 "/plugins/??xxx" 而言 _p 只会是 "/plugins/"，所以排除从未生效（大包仍被 gzip）。
        # 必须用原始 target（含查询串）判断。
        _pq = target.split("?", 1)[1] if "?" in target else ""
        _plugin_combo = ("/plugins/??" in target) or (_p == "/plugins/" and _pq.startswith("?"))
        api_path = (API_CACHE_ON and parts[0] == "POST" and _p in API_CACHE_PATHS
                    and not is_upgrade)
        compress_out = ((parts[0] == "GET" and (want_br or want_gz) and not is_upgrade
                         and (_p.startswith(gzip_paths) or adapt)
                         and not _plugin_combo)   # 巨型合并包：原样透传（压缩路径会把它弄成 0 字节）
                        # The RPC endpoints are JSON that upstream never compresses:
                        # 314 KB -> ~30 KB on the relay per session/list poll.
                        # (ltrim included: even with the disk cache off the slimmed list
                        #  must still be compressed on the relay)
                        or ((api_path or ltrim) and API_CACHE_COMPRESS and (want_br or want_gz)))
        # Alert-chime replay guard: the app re-polls this endpoint with since=0 every time
        # the (flapping) WebSocket reconnects, which makes the user's chime plugin replay
        # the whole history and ring non-stop. Substitute the last seq we have seen.
        chime = (parts[0] == "GET" and _p == "/alert-chime/events")
        if chime and CHIME_STATE["seq"] is not None:
            m2 = re.search(r"[?&]since=(\d+)", target)
            if m2 and m2.group(1) == "0":
                target = target[:m2.start(1)] + str(CHIME_STATE["seq"]) + target[m2.end(1):]
                log("chime guard: since=0 -> since=%d" % CHIME_STATE["seq"])
        transform = trim or adapt or hot or compress_out or chime or api_path or ltrim
        if transform:
            hdrs = [h for h in hdrs if not h.lower().startswith("accept-encoding:")]
            hdrs = [h for h in hdrs if not h.lower().startswith("connection:")]
            hdrs.append("Connection: close")   # upstream close is cheap (localhost)
        hdrs.extend(keep_conn)
        if not is_upgrade:
            hdrs.append("Connection: close")
        out = ("%s %s %s" % (parts[0], target, parts[2] if len(parts) > 2 else "HTTP/1.1")
               + "\r\n" + "\r\n".join(hdrs) + "\r\n\r\n").encode("latin-1")

        # Finish relaying the request body. read_head() returns only whatever happened to
        # arrive alongside the headers (4096-byte granularity); any remainder must be
        # forwarded now, otherwise the next keep-alive iteration parses body bytes as a
        # request line -> broken POSTs and a storm of reconnects.
        reuse = not client_close
        clen = 0
        chunked_req = False
        for h in hdrs_in:
            low = h.lower()
            if low.startswith("content-length:"):
                try:
                    clen = int(h.split(":", 1)[1].strip())
                except Exception:
                    clen = 0
            elif low.startswith("transfer-encoding:"):
                reuse = False       # chunked request body: cannot account for it, do not reuse
                chunked_req = True

        # ---- POST RPC disk cache: try to answer without opening an upstream socket ----
        api_key = None
        api_body = b""
        api_body_read = False
        cap_info = None
        page_shape = None
        page_imm = False
        api_bypass = any(re.match(r"(?i)^(cache-control|pragma):\s*(no-cache|no-store)", h)
                         for h in hdrs_in)
        if (api_path and not api_bypass and not chunked_req
                and 0 < clen <= API_CACHE_MAXREQ and len(rest) <= clen):
            api_body = await _read_req_body(reader, rest, clen)
            rest = b""
            api_body_read = True
            if _p == "/api/session/page":
                nb2, info2 = cap_page_messages(api_body)
                if info2 is not None:
                    api_body = nb2
                    clen = len(nb2)
                    out = _set_content_length(out, clen)
                    cap_info = info2
            page_shape = None
            if _p == "/api/session/page":
                page_shape = _page_request_shape(api_body)
                page_imm = PAGE_IMM_ON and _page_immutable(page_shape)
            api_key = _api_body_key(_p, target, trim, api_body, lmode, _page_key_extra(page_shape))
            ent = _api_cache_get(api_key)
            if ent is not None:
                now = time.time()
                age = now - ent["ts"]
                # TTL 取自条目自身（写入时定死），键里钉住了整份请求体，两者永远一致
                ttl = API_CACHE_TTL_RUN if ent["run"] else ent["ttl"]
                swr = ent["swr"]
                if age <= ttl:
                    _api_cache_touch(ent["path"])
                    API_STATS["hit"] += 1
                    log("api cache HIT %s %s age=%.1fs ttl=%.0fs swr=%.0fs imm=%d body=%dB"
                        % (parts[0], target[:34], age, ttl, swr, 1 if ent["imm"] else 0,
                           len(ent["body"])))
                    return await _send_api_cached(writer, ent, "hit", now, client_close,
                                                  set_cookie, want_br, want_gz,
                                                  _api_rpc_id(api_body))
                if age <= ttl + swr and not ent["run"]:
                    API_STATS["stale"] += 1
                    log("api cache STALE %s %s age=%.1fs ttl=%.0fs imm=%d -> background refresh"
                        % (parts[0], target[:34], age, ttl, 1 if ent["imm"] else 0))
                    _spawn_refresh(api_key, target, api_body, trim, lmode, ttl, swr, ent["imm"])
                    return await _send_api_cached(writer, ent, "stale", now, client_close,
                                                  set_cookie, want_br, want_gz,
                                                  _api_rpc_id(api_body))
                API_STATS["miss"] += 1
                log("api cache MISS(expired) %s %s age=%.1fs ttl=%.0fs" % (parts[0], target[:34], age, ttl))
            else:
                API_STATS["miss"] += 1

        # 没有走缓存快路径时（缓存被关/请求体过大/带 no-cache）也照样压分页体积
        if _p == "/api/session/page" and not api_body_read and not chunked_req and clen > 0:
            api_body = await _read_req_body(reader, rest, clen)
            rest = b""
            api_body_read = True
            nb2, info2 = cap_page_messages(api_body)
            if info2 is not None:
                api_body = nb2
                clen = len(nb2)
                out = _set_content_length(out, clen)
                cap_info = info2

        # 大 body：先收完再连上游（见 REQ_BUFFER_MIN 的说明）。收完再转发，
        # 上游的请求超时才开始计，慢链路才不会把请求判死。
        if (not api_body_read and not chunked_req
                and REQ_BUFFER_MIN < clen <= REQ_BUFFER_MAX):
            api_body = await _read_req_body(reader, rest, clen)
            rest = b""
            api_body_read = True
            log("req buffer: %s %s %d B (wait for full body before upstream)"
                % (parts[0], target[:32], clen))

        tr, tw = await asyncio.open_connection(*TARGET)
        tw.write(out)
        if api_body_read:
            if api_body:
                tw.write(api_body)
            have = len(api_body)
        else:
            if rest:
                tw.write(rest)
            have = len(rest)
        await tw.drain()

        while reuse and clen > have:
            chunk = await reader.read(min(65536, clen - have))
            if not chunk:
                break
            tw.write(chunk)
            have += len(chunk)
        if have != clen:
            reuse = False
        if clen:
            await tw.drain()
        if cap_info is not None:
            log("page cap: maxMessages %s->%s turnWindow.minMessages %s->%s (req %d B)"
                % (cap_info[0], cap_info[1], cap_info[2], cap_info[3], clen))
        log("proxied %s %s host=%s from %s" % (parts[0], target[:40], host, peer_ip))

        # 注意：api_path 也是 transform=True，所以这里要显式排除 API，
        # 否则带 ?k= 的那一次 session/list|page 会整块绕过缓存与压缩。
        if set_cookie and not transform and not api_path:
            first = b""
            while b"\r\n\r\n" not in first:
                chunk = await tr.read(4096)
                if not chunk:
                    break
                first += chunk
            ka = False
            if b"\r\n\r\n" in first:
                head_resp, _, rest_resp = first.partition(b"\r\n\r\n")
                head_out, ka = _rewrite_head(head_resp, target, set_cookie)
                writer.write(head_out + b"\r\n\r\n" + rest_resp)
            else:
                writer.write(first)
            await writer.drain()
            await pump(tr, writer, close=False)
            try:
                tw.close()
            except Exception:
                pass
            return reuse and ka

        # request rewriting: JSON slimming and/or mobile adaptation injection
        if transform:
            raw = b""
            while True:
                chunk = await tr.read(65536)
                if not chunk:
                    break
                raw += chunk
            head_b, _, body_b = raw.partition(b"\r\n\r\n")
            try:
                if b"chunked" in head_b.lower():
                    body_b = _dechunk(body_b)
                is_html = b"text/html" in head_b.lower()
                if (adapt or hot) and is_html:
                    nb = (inject_mobile(body_b, with_css=("no-css=1" not in target),
                                        with_gestures=("no-gesture=1" not in target),
                                        with_voice=("no-voice=1" not in target))
                          if adapt else body_b)
                    # 热补丁永远排在所有其它注入之后（CSS 在 </head>，JS 在页面最后）
                    nb, _hot_done = hot_inject(nb, target)
                    tag = "+".join([t for t, on in (("adapt", adapt), ("hot", _hot_done)) if on]) or "pass"
                elif chime:
                    nb = body_b
                    tag = "chime"
                    try:
                        j = json.loads(body_b.decode("utf-8", "replace"))
                        if isinstance(j, dict) and isinstance(j.get("seq"), int):
                            CHIME_STATE["seq"] = j["seq"]
                    except Exception:
                        pass
                elif trim or ltrim:
                    data = json.loads(body_b.decode("utf-8", "replace"))
                    if trim:
                        data = trim_payload(_p, data)
                    if ltrim:
                        data = trim_session_list(data, ltrim_proj)
                    nb = _json_bytes(data)
                    tag = "+".join([t for t, on in (("trim", trim), ("listtrim", ltrim)) if on])
                    if ltrim:
                        try:
                            _n = len(((data.get("result") or {}).get("value") or {}).get("items") or [])
                        except Exception:
                            _n = -1
                        log("list trim: items=%d %d B -> %d B (mode=%s)" % (_n, len(body_b), len(nb), lmode))
                else:
                    nb = body_b
                    tag = "pass"
                if api_key is not None and nb and head_b.startswith(b"HTTP/1.1 200"):
                    if _api_cache_store(api_key, head_b, nb,
                                        ttl=(PAGE_IMM_TTL if page_imm else None),
                                        swr=(PAGE_IMM_SWR if page_imm else None),
                                        imm=page_imm, rid=_api_rpc_id(api_body)):
                        log("api cache STORE %s %s -> %d B key=%s imm=%d ttl=%s"
                            % (parts[0], target[:34], len(nb), api_key[:8],
                               1 if page_imm else 0, "7d" if page_imm else "20s"))
                enc_used = None
                if compress_out and len(nb) > 1024:
                    if want_br:
                        try:
                            # lgwin=24 (16 MB window): the default 4 MB window fails on
                            # the ~10 MB plugin combo bundle and would silently fall back.
                            nb = brotli.compress(nb, quality=5, lgwin=24)
                            enc_used = b"br"
                        except Exception as e:
                            log("brotli failed (%r) -> gzip" % (e,))
                            nb = gzip.compress(nb, 6)
                            enc_used = b"gzip"
                    else:
                        nb = gzip.compress(nb, 6)
                        enc_used = b"gzip"
                    tag += "+" + enc_used.decode()
                lines = head_b.split(b"\r\n")
                keep = [l for l in lines[1:]
                        if not re.match(rb"(?i)^(content-length|content-encoding|transfer-encoding|connection|cache-control|vary):", l)]
                keep.append(b"Vary: Accept-Encoding")
                if api_path:
                    # hit/stale returned long before this point; anything that reaches
                    # upstream is a miss (including no-cache bypasses and oversized bodies)
                    keep.append(b"X-DSH-Cache: miss")
                    keep.append((CACHE_AGE_HDR + ": 0").encode("latin-1"))
                if enc_used:
                    keep.append(b"Content-Encoding: " + enc_used)
                if tag.startswith("adapt") and b"</body>" in nb:
                    nb = nb.replace(b"</body>",
                                    b"<script>(function(){try{window.dispatchEvent("
                                    b"new Event('dsh-ready'));}catch(e){}})();</script></body>", 1)
                    tag += "+ready"
                if tag.startswith("adapt") or hot:
                    # 手机 / 热补丁页面永远拿最新前端（改完刷新即生效的前提）
                    keep.append(b"Cache-Control: no-store")
                elif _p.startswith(gzip_paths) and lines[0].startswith(b"HTTP/1.1 200"):
                    # /plugins/ and /assets/ URLs carry content hashes: cache hard (200 only,
                    # never cache a transient 404 for a year)
                    keep.append(b"Cache-Control: public, max-age=31536000, immutable")
                out = (lines[0] + b"\r\n" + b"\r\n".join(keep)
                       + b"\r\nContent-Length: " + str(len(nb)).encode()
                       + (("\r\nSet-Cookie: " + set_cookie).encode("latin-1") if set_cookie else b"")
                       + b"\r\nConnection: " + (b"close" if client_close else b"keep-alive")
                       + b"\r\n\r\n" + nb)
                writer.write(out)
                await writer.drain()
                log("%s %s -> %d B (was %d B) %.2fs" % (tag, target[:26], len(nb), len(body_b), time.time() - t_req))
            except Exception as e:
                log("transform failed (%r) -> pass through %d B" % (e, len(raw)))
                if raw:
                    writer.write(raw)
                    await writer.drain()
            try:
                tw.close()
            except Exception:
                pass
            return reuse

        # read the upstream response head first (log the status), then forward both ways
        first = b""
        while b"\r\n\r\n" not in first and len(first) < 65536:
            chunk = await tr.read(4096)
            if not chunk:
                break
            first += chunk
        status = first.split(b"\r\n", 1)[0].decode("latin-1", "replace") if first else "(no response)"
        elapsed = time.time() - t_req
        ka = False
        if first:
            head_only = first.split(b"\r\n\r\n", 1)[0]
            head_out, ka = _rewrite_head(head_only, target, None, is_upgrade=is_upgrade)
            writer.write(head_out + b"\r\n\r\n"
                         + (first.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in first else b""))
            await writer.drain()
        log("<- %s | %s %s (%.2fs)" % (status[:36], parts[0], target[:36], elapsed))
        if is_upgrade:
            wlock = asyncio.Lock()

            def ws_split(buf):
                """把缓冲区切成完整 WebSocket 帧的原始字节列表，返回 (frames, rest)。"""
                frames = []
                i, n = 0, len(buf)
                while True:
                    if n - i < 2:
                        break
                    b1 = buf[i + 1]
                    ln = b1 & 0x7F
                    off = i + 2
                    if ln == 126:
                        if n - off < 2:
                            break
                        ln = int.from_bytes(buf[off:off + 2], "big")
                        off += 2
                    elif ln == 127:
                        if n - off < 8:
                            break
                        ln = int.from_bytes(buf[off:off + 8], "big")
                        off += 8
                    mk = 4 if (b1 & 0x80) else 0
                    end = off + mk + ln
                    if n < end:
                        break
                    frames.append(bytes(buf[i:end]))
                    i = end
                return frames, bytes(buf[i:])

            async def ws_up(r, w):
                """客户端 -> DSH。整帧写入并持锁，保证 pong 不会插进半截帧里。"""
                buf = b""
                try:
                    while True:
                        data = await r.read(65536)
                        if not data:
                            log("ws client->dsh: EOF")
                            return
                        buf += data
                        frames, buf = ws_split(buf)
                        for f in frames:
                            async with wlock:
                                # 首屏历史也在这里被压到 PAGE_MSG_LIMIT（见 ws_cap_frame）
                                w.write(ws_cap_frame(f))
                                await w.drain()
                except Exception as ex:
                    log("ws client->dsh: %r" % (ex,))

            async def ws_down(r, w):
                """DSH -> 客户端：原样转发；解析出 PING 时**立刻**替客户端回 PONG。

                服务器每 ~2s 发一次 ping，收不到 pong 就掐连接（实测 4-6 秒）。
                手机经中继时 pong 常迟到 → 完整版一直重连、看不到会话。
                回 pong 走同一把锁，避免与客户端帧交织。
                """
                buf = b""
                try:
                    while True:
                        data = await r.read(65536)
                        if not data:
                            log("ws dsh->client: EOF")
                            return
                        w.write(data)
                        await w.drain()
                        buf += data
                        frames, buf = ws_split(buf)
                        for f in frames:
                            op = f[0] & 0x0F
                            if op != 0x9:
                                continue
                            # 取 payload 长度（ping 通常 0 字节）
                            b1 = f[1]
                            ln = b1 & 0x7F
                            pstart = 2
                            if ln == 126:
                                ln = int.from_bytes(f[2:4], "big")
                                pstart = 4
                            elif ln == 127:
                                ln = int.from_bytes(f[2:10], "big")
                                pstart = 10
                            payload = f[pstart:pstart + ln] if ln <= 125 else b""
                            async with wlock:
                                tw.write(bytes([0x8A, 0x80 | len(payload)])
                                         + b"\x00\x00\x00\x00" + payload)
                                await tw.drain()
                except Exception as ex:
                    log("ws dsh->client: %r" % (ex,))

            t1 = asyncio.ensure_future(ws_up(reader, tw))
            t2 = asyncio.ensure_future(ws_down(tr, writer))
            done, pending = await asyncio.wait([t1, t2], return_when=asyncio.FIRST_COMPLETED)
            log("ws closed first: %s" % ("client->dsh" if t1 in done else "dsh->client"))
            for t in pending:
                t.cancel()
            return False
        await pump(tr, writer, close=False)
        log("keepalive: reuse=%s ka=%s %s %s clen=%d have=%d" % (reuse, ka, parts[0], target[:24], clen, have))
        return reuse and ka
_CACHEABLE_PREFIXES = ("/assets/", "/static/", "/share/")


def _rewrite_head(head_b, target, set_cookie, is_upgrade=False):
    """Rewrite an upstream response head. Returns (head_bytes, keep_alive_ok).

    Hard-won details:
      * Transfer-Encoding MUST be kept: it is the framing. Dropping it leaves the
        client unable to find the end of the body -> the page hangs forever.
      * A 101 upgrade head must pass through verbatim (Connection: Upgrade is part
        of the handshake and must not become keep-alive).
      * Claim keep-alive only when the body is self-delimiting (Content-Length or
        chunked); otherwise the client waits forever for data.
    """
    if is_upgrade:
        return head_b, False
    lines = head_b.split(b"\r\n")
    keep = [lines[0]]
    has_len = False
    has_te = False
    for l in lines[1:]:
        if not l:
            continue
        low = l.lower()
        if low.startswith(b"content-length:"):
            has_len = True
        elif low.startswith(b"transfer-encoding:"):
            has_te = True
        if re.match(rb"(?i)^(connection|keep-alive|proxy-connection|proxy-authenticate|proxy-authorization|upgrade):", l):
            continue
        if re.match(rb"(?i)^cache-control:", l):
            continue
        keep.append(l)
    keep_alive = has_len or has_te
    keep.append(b"Connection: keep-alive" if keep_alive else b"Connection: close")
    path = target.split("?")[0]
    if path.startswith(_CACHEABLE_PREFIXES):
        # Vite asset names are content-hashed: cache hard (big win on a slow link)
        keep.append(b"Cache-Control: public, max-age=31536000, immutable")
    if set_cookie:
        keep.append(("Set-Cookie: " + set_cookie).encode("latin-1"))
    return b"\r\n".join(keep), keep_alive


async def handle(reader, writer):
    peer = writer.get_extra_info("peername")
    peer_ip = peer[0] if peer else "?"
    try:
        while True:
            try:
                keep = await serve_once(reader, writer, peer_ip)
            except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
                keep = False
            except Exception as e:
                log("handler error from %s: %r" % (peer_ip, e))
                keep = False
            # 注意：不要用 reader.at_eof() 判断——在 CPython/asyncio 上它会在连接
            # 仍然可用时返回 True，导致每个连接只服务一个请求（实测连接洪流的元凶）。
            # 客户端真断开时 read_head() 会返回 None，那时自然退出。
            if not keep:
                break
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(handle, LISTEN[0], LISTEN[1])
    log("listening %s -> %s (key %s...)" % (LISTEN, TARGET, KEY[:6]))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
