package ai.deepseek.dsh.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.ParcelFileDescriptor;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.RandomAccessFile;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

import org.json.JSONObject;

/**
 * DSH WebView 壳（v6：永不空白 + 崩溃自报 + WebView 不可用则走系统浏览器）。
 *
 * 设计要点：
 *  1) onCreate 第一件事就是 setContentView(一个纯 TextView) —— 屏幕永远不会是"什么都没有"；
 *  2) WebView 的创建包在 try/catch 里：设备 WebView 组件异常时不再整页空白，而是给"浏览器打开"；
 *  3) 注册全局未捕获异常处理器，把堆栈写文件，下次启动直接显示在屏幕上。
 */
public class MainActivity extends Activity {

    private static final String DEFAULT_HOST = "your-host:19390";
    private static final String DEFAULT_KEY = "PASTE_YOUR_CAP_KEY_HERE";
    private static final int REQ_FILE = 1001;
    private static final String CRASH_FILE = "crash.txt";

    private SharedPreferences prefs;
    private String host;
    private String key;

    /* ---- 局域网 / VPN 双模：候选线路 + 探测结果 ---- */
    static final String DEFAULT_LAN = "<PC-LAN-IP>:19390";    // 有线局域网
    static final String DEFAULT_LAN2 = "<SRV-LAN-IP>:19390";  // WiFi 网段（同网段时可用）
    private static final int PROBE_TIMEOUT_MS = 1500;
    private static final long PROBE_MIN_GAP_MS = 20000L;
    private static final long PROBE_PERIOD_MS = 45000L;
    private java.util.List<String> hosts = new java.util.ArrayList<String>();
    private final java.util.Map<String, Integer> probeMs =
            new java.util.concurrent.ConcurrentHashMap<String, Integer>();
    private volatile long lastProbeAt = 0L;
    private volatile boolean probing = false;
    private volatile String lastProbeSummary = "(未探测)";
    private Object netCallback = null;

    private TextView status;      // 兜底视图：任何时刻都能显示文字
    private String webError;      // WebView 构造失败时的异常文本（直接显示给用户）
    private FrameLayout stage;
    private LinearLayout homeView;
    private TextView homeInfo;
    private WebView web;
    private ProgressBar bar;
    private TextView banner;
    private LinearLayout errorView;
    private TextView errorDetail;
    private final StringBuilder consoleLog = new StringBuilder();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> filePathCallback;
    private boolean probed = false;
    private boolean onLite = false;
    private long loadT0 = 0;
    private Map<String, String[]> bundleIdx;   // "path?query" -> {assetFile, mime}
    private int bundleHits = 0;
    private long lastPrewarm = 0;              // 上次预热时间戳（防抖）
    private int prewarmRuns = 0;
    private long lastKeepalive = 0;            // 上次"回到前台唤醒连接"时间戳（防抖）
    private int keepaliveRuns = 0;
    private String keepaliveInfo = "(尚未唤醒)";
    private String prewarmInfo = "(尚未预热)";
    private String cacheDirInfo = "(未启用)";

    // ---------------- 语音输入（v8） ----------------
    // 手机端 DSH 的「语音输入」在 WebView 里坏掉有两条独立原因，这里各修一半：
    //
    //  ① 页面是 http://<Tailscale/LAN IP>:19390 —— 非安全上下文，Chromium 下
    //     `navigator.mediaDevices` 直接不存在，前端的 Recording.start() 立刻抛
    //     RecordingError("unavailable")（"This browser cannot record audio"）。
    //     这一条**不能**靠授权解决，只能由代理注入的 shim 把 getUserMedia/MediaRecorder
    //     接管到下面的原生 AudioRecord 上。
    //  ② 即使来源安全，manifest 里声明了 RECORD_AUDIO 也还不够：targetSdk 34 必须
    //     运行时申请。所以这里补 requestPermissions/onRequestPermissionsResult。
    //
    // 录音用 AudioRecord 直接出 16 kHz 单声道 PCM → WAV，**不依赖任何识别引擎**；
    // 识别在运行 DSH 的电脑上做（前端照旧把 WAV base64 POST 给 Host）。
    // 另外用 SpeechRecognizer 提供一份真正的端上识别，给 Web Speech API polyfill 用
    // （华为部分机型没有可用识别服务，此时必须回明确错误码）。
    private static final int REQ_AUDIO = 2001;
    private static final String VOICE_WAV = "dsh-voice.wav";
    private static final String VOICE_PCM = "dsh-voice.pcm";
    private DshVoice voice;
    private boolean voiceAsked = false;

    /**
     * 预热脚本（在完整版页面就绪后注入执行）。
     *
     * 只做一件事：用 App 自己的 /api/session/* 读接口把「会话列表」和「最近一个会话的分页」
     * 主动拉一遍。这样用户点进完整版时：
     *   · 代理侧的 POST 磁盘缓存（/api/session/list、/api/session/page）已经是热的，
     *     App 随后的同参数请求直接命中，不必再等一次中继往返；
     *   · 到代理的 TCP 长连接被提前建立。
     * 请求体必须与 App 自己发出的完全一致（同样的 method/args，且**不带** x-mobile-client，
     * 否则代理会对轻量客户端做 JSON 瘦身，缓存键就对不上了）。
     */
    private static final String PREWARM_TAG = "DSH-PREWARM";

    private static String prewarmJs() {
        return "(function(){try{var w=window;var now=Date.now();"
                + "if(w.__dshPrewarmAt&&now-w.__dshPrewarmAt<15000){return 'skip(recent)';}"
                + "w.__dshPrewarmAt=now;"
                + "function uuid(){return (w.crypto&&w.crypto.randomUUID)?w.crypto.randomUUID():"
                + "'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;"
                + "return (c==='x'?r:(r&0x3|0x8)).toString(16);});}"
                + "function rpc(ep,args){var body={type:'client-request',rpcId:uuid(),method:ep,payload:{args:args}};"
                + "return fetch('/api/'+ep,{method:'POST',headers:{'content-type':'application/json'},"
                + "body:JSON.stringify(body)}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);"
                + "return r.json();}).then(function(d){var res=d&&d.result;if(!res)throw new Error('bad envelope');"
                + "if(!res.ok)throw new Error((res.error&&res.error.code)||'rpc error');return res.value;});}"
                + "var t0=Date.now();"
                + "function pageOf(s){var seq=(s.projections&&s.projections.asOfSeq)||0;"
                + "return rpc('session/page',{request:{address:{kind:'session',sessionId:s.sessionId},"
                + "throughSeq:seq,maxMessages:500,turnWindow:{minMessages:50,minTurns:2}}}"
                + ").then(function(p){return {sessionId:s.sessionId,seq:seq,records:((p&&p.records)||[]).length,ms:Date.now()-t0};});}"
                + "w.__dshPrewarm=rpc('session/list',{_request:{}}).then(function(v){"
                + "var items=(v&&v.items)||[];"
                // 只挑「能直接用 {kind:'session'} 地址读」的会话：
                //   · subagent 子会话（origin==='subagent'）必须用 subagent 地址，用会话地址会被
                //     服务端拒（session/agent-busy），等于白发一次请求；
                //   · blank 会话本来就没历史可灌。
                // 排序上让「空闲会话」优先：running 会话的 asOfSeq 一直在涨，这次预热到的分页
                // 下一跳就对不上了；空闲会话的 asOfSeq 稳定，App 点进去时能直接命中。
                + "var cand=[];var i;for(i=0;i<items.length;i++){var it=items[i];"
                + "if(it.blank||it.origin==='subagent'){continue;}cand.push(it);}"
                + "cand.sort(function(a,b){var r=(a.running?1:0)-(b.running?1:0);"
                + "return r!==0?r:((b.updatedAt||0)-(a.updatedAt||0));});"
                + "if(!cand.length){return {list:'ok',items:items.length,cand:0,ms:Date.now()-t0};}"
                + "var k=Math.min(3,cand.length);"
                + "var chain=Promise.reject(new Error('none'));"
                + "for(i=0;i<k;i++){(function(s){chain=chain.catch(function(){return pageOf(s);});})(cand[i]);}"
                + "return chain.then(function(r){r.list='ok';r.items=items.length;r.cand=cand.length;r.ms=Date.now()-t0;"
                + "return r;},function(e){return {list:'ok',items:items.length,cand:cand.length,pageErr:String(e),ms:Date.now()-t0};});"
                + "}).catch(function(e){return {listErr:String(e),ms:Date.now()-t0};});"
                + "w.__dshPrewarm.then(function(r){try{console.log('" + PREWARM_TAG + " '+JSON.stringify(r));}catch(e){}});"
                + "return 'started';}catch(e){return 'ERR '+e;}})()";
    }

    /**
     * 回到前台时的“轻量恢复”：只做一次，不整页 reload。
     *
     * 页面里的连接守夜人（代理注入的 window.__dshKeeper）会：
     *   1) 发一次同源小请求 /__health 把被挂起的网络/连接栈唤醒；
     *   2) 派发一次 online 事件 —— 连接服务监听网络状态，收到就取消退避、立刻重连；
     *   3) 同时代理把重连退避上限从默认 10s 压到 2.5s（__DSH_CONNECTION_RECOVERY__）。
     * App 侧只负责“回到前台”这个时机，不碰 WebSocket、不刷新页面。
     * 另外这里**不调用** web.pauseTimers()/resumeTimers()，后台不会主动暂停页面。
     */
    private void maybeKeepalive(final String why) {
        if (web == null || onLite) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastKeepalive < 3000) {       // 3s 防抖：锁屏反复开关也只唤醒一次
            return;
        }
        lastKeepalive = now;
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (web == null || onLite) {
                    return;
                }
                keepaliveRuns++;
                web.evaluateJavascript(
                        "(function(){try{var k=window.__dshKeeper;"
                                + "if(!k||typeof k.poke!=='function'){return JSON.stringify({keeper:0,ready:0});}"
                                + "var st=k.state?k.state():null;var r=k.poke();"
                                + "return JSON.stringify({keeper:1,ready:k.ready||0,poke:r,"
                                + "state:st,gen:(k.generation?k.generation():null),"
                                + "ws:(navigator.onLine?'online':'offline')});"
                                + "}catch(e){return JSON.stringify({err:String(e)});}})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String v) {
                                keepaliveInfo = (v == null ? "(null)" : v.replace("\\", ""));
                                Log.i("DSH", "keepalive(" + why + ") -> " + keepaliveInfo);
                            }
                        });
            }
        }, 600);
    }

    /** 页面就绪 / 回到前台时触发一次预热（15s 防抖，绝不重复打）。 */
    private void maybePrewarm(final String why) {
        if (web == null || onLite) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastPrewarm < 15000) {
            return;
        }
        lastPrewarm = now;
        prewarmRuns++;
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (web == null) {
                    return;
                }
                web.evaluateJavascript(prewarmJs(), new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        Log.i("DSH", "prewarm(" + why + ") -> " + v);
                    }
                });
            }
        }, 1500);
    }

    /* ===================== 局域网 / VPN 双模热切换 =====================
     * 手机在家 -> 直连 PC 的局域网地址（快）；出门 -> 走 Tailscale 转发的远程地址。
     * 两条路都在候选表里，App 探测 /__health（免密钥、极轻）后自动切到最快的一条；
     * 切换只是换 host 重载页面 —— 同一台 DSH 服务端，会话与数据都在服务端，不会丢。
     * ================================================================= */

    static String normalizeHost(String s) {
        String h = s == null ? "" : s.trim();
        h = h.replace("http://", "").replace("https://", "");
        while (h.endsWith("/")) {
            h = h.substring(0, h.length() - 1);
        }
        return h;
    }

    /** 仅用于打标签（局域网/远程），判断错也无害。 */
    static boolean isPrivateLan(String h) {
        if (h == null) {
            return false;
        }
        if (h.startsWith("192.168.") || h.startsWith("10.")) {
            return true;
        }
        if (h.startsWith("172.")) {
            try {
                int second = Integer.parseInt(h.split("\\.")[1]);
                return second >= 16 && second <= 31;
            } catch (Throwable ignored) {
                return false;
            }
        }
        return false;
    }

    static String lineTag(String h) {
        return isPrivateLan(h) ? "（局域网）" : "（远程/VPN）";
    }

    private void loadHosts() {
        String raw = prefs.getString("hosts", "");
        hosts = new java.util.ArrayList<String>();
        if (raw != null && raw.trim().length() > 0) {
            for (String s : raw.split(",")) {
                String h = normalizeHost(s);
                if (h.length() > 0 && !hosts.contains(h)) {
                    hosts.add(h);
                }
            }
        }
        if (hosts.isEmpty()) {
            hosts.add(normalizeHost(DEFAULT_HOST));
            hosts.add(DEFAULT_LAN);
            hosts.add(DEFAULT_LAN2);
        }
        if (host != null && host.length() > 0 && !hosts.contains(host)) {
            hosts.add(0, host);
        }
    }

    private void saveHosts() {
        StringBuilder sb = new StringBuilder();
        for (String h : hosts) {
            if (sb.length() > 0) {
                sb.append(",");
            }
            sb.append(h);
        }
        prefs.edit().putString("hosts", sb.toString()).apply();
    }

    /** 探测一个地址：GET /__health（不需要访问密钥），返回毫秒；不可达 -1。 */
    private int probeHost(String h) {
        java.net.HttpURLConnection c = null;
        long t0 = System.currentTimeMillis();
        try {
            c = (java.net.HttpURLConnection) new java.net.URL("http://" + h + "/__health").openConnection();
            c.setConnectTimeout(PROBE_TIMEOUT_MS);
            c.setReadTimeout(PROBE_TIMEOUT_MS);
            c.setUseCaches(false);
            c.setRequestProperty("User-Agent", "DSH-Android-probe");
            if (c.getResponseCode() != 200) {
                return -1;
            }
            InputStream in = c.getInputStream();
            byte[] buf = new byte[64];
            in.read(buf);
            in.close();
            return (int) (System.currentTimeMillis() - t0);
        } catch (Throwable e) {
            return -1;
        } finally {
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /** 并行探测所有候选，返回最快可达的那条（全不可达返回 null）。 */
    private String probeAll() {
        final java.util.List<String> list = new java.util.ArrayList<String>(hosts);
        java.util.List<Thread> ts = new java.util.ArrayList<Thread>();
        for (final String h : list) {
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    probeMs.put(h, probeHost(h));
                }
            }, "dsh-probe");
            t.setDaemon(true);
            ts.add(t);
            t.start();
        }
        for (Thread t : ts) {
            try {
                t.join(PROBE_TIMEOUT_MS + 800);
            } catch (Throwable ignored) {
            }
        }
        String best = null;
        int bestMs = Integer.MAX_VALUE;
        StringBuilder sb = new StringBuilder();
        for (String h : list) {
            Integer boxed = probeMs.get(h);
            int v = boxed == null ? -1 : boxed;
            sb.append(h).append(v < 0 ? "=不可达" : ("=" + v + "ms")).append("  ");
            if (v >= 0 && v < bestMs) {
                bestMs = v;
                best = h;
            }
        }
        lastProbeSummary = sb.toString().trim();
        lastProbeAt = System.currentTimeMillis();
        return best;
    }

    private void maybeAutoPick(final String why) {
        long now = System.currentTimeMillis();
        if (probing) {
            return;
        }
        if (!"start".equals(why) && now - lastProbeAt < PROBE_MIN_GAP_MS) {
            return;
        }
        probing = true;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                String best = null;
                try {
                    best = probeAll();
                } catch (Throwable e) {
                    Log.w("DSH", "probe failed", e);
                }
                final String fbest = best;
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        probing = false;
                        if (fbest != null && !fbest.equals(host)) {
                            switchTo(fbest, "auto:" + why);
                        }
                    }
                });
            }
        }, "dsh-autopick");
        t.setDaemon(true);
        t.start();
    }

    private void startProbeLoop() {
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    maybeAutoPick("periodic");
                } catch (Throwable ignored) {
                }
                handler.postDelayed(this, PROBE_PERIOD_MS);
            }
        }, PROBE_PERIOD_MS);
    }

    private void switchTo(final String newHost, String why) {
        if (newHost == null || newHost.length() == 0 || newHost.equals(host)) {
            return;
        }
        String old = host;
        host = newHost;
        prefs.edit().putString("host", host).apply();
        Log.i("DSH", "line switch (" + why + "): " + old + " -> " + host);
        try {
            Toast.makeText(this, "线路：" + host + lineTag(host), Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {
        }
        // 热切换：换入口重载页面（同一台服务端，会话数据不丢）
        try {
            if (web != null && web.getVisibility() == View.VISIBLE) {
                web.loadUrl(onLite ? liteUrl() : fullUrl());
            }
        } catch (Throwable e) {
            Log.w("DSH", "line switch reload failed", e);
        }
    }

    private void initNetCallback() {
        try {
            if (Build.VERSION.SDK_INT < 24) {
                return;
            }
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager)
                    getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) {
                return;
            }
            android.net.ConnectivityManager.NetworkCallback cb =
                    new android.net.ConnectivityManager.NetworkCallback() {
                        @Override
                        public void onAvailable(android.net.Network n) {
                            handler.postDelayed(new Runnable() {
                                @Override
                                public void run() {
                                    maybeAutoPick("net-up");
                                }
                            }, 1200);
                        }

                        @Override
                        public void onLost(android.net.Network n) {
                            handler.postDelayed(new Runnable() {
                                @Override
                                public void run() {
                                    maybeAutoPick("net-down");
                                }
                            }, 1200);
                        }
                    };
            cm.registerDefaultNetworkCallback(cb);
            netCallback = cb;
        } catch (Throwable e) {
            Log.w("DSH", "network callback unavailable", e);
        }
    }

    private void showLineDialog() {
        try {
            final java.util.List<String> cands = new java.util.ArrayList<String>(hosts);
            final String[] labels = new String[cands.size() + 3];
            for (int i = 0; i < cands.size(); i++) {
                Integer ms = probeMs.get(cands.get(i));
                String stat = ms == null ? "" : (ms < 0 ? "  不可达" : ("  " + ms + "ms"));
                String mark = cands.get(i).equals(host) ? "● " : "○ ";
                labels[i] = mark + cands.get(i) + lineTag(cands.get(i)) + stat;
            }
            labels[cands.size()] = "自动选择（探测后取最快）";
            labels[cands.size() + 1] = "重新探测";
            labels[cands.size() + 2] = "编辑候选地址…";
            new AlertDialog.Builder(this)
                    .setTitle("线路（当前 " + host + lineTag(host) + "）")
                    .setItems(labels, new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int which) {
                            if (which < cands.size()) {
                                switchTo(cands.get(which), "manual");
                                maybeAutoPick("manual-check");
                            } else if (which == cands.size()) {
                                maybeAutoPick("manual-auto");
                                Toast.makeText(MainActivity.this, "正在探测…", Toast.LENGTH_SHORT).show();
                            } else if (which == cands.size() + 1) {
                                lastProbeAt = 0;
                                maybeAutoPick("manual-probe");
                                Toast.makeText(MainActivity.this, "正在重新探测…", Toast.LENGTH_SHORT).show();
                            } else {
                                editHostsDialog();
                            }
                        }
                    })
                    .setNegativeButton("关闭", null)
                    .show();
        } catch (Throwable t) {
            Toast.makeText(this, "打开线路面板失败：" + t.getClass().getSimpleName(), Toast.LENGTH_LONG).show();
        }
    }

    private void editHostsDialog() {
        try {
            final EditText ed = new EditText(this);
            ed.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
            StringBuilder sb = new StringBuilder();
            for (String h : hosts) {
                if (sb.length() > 0) {
                    sb.append(",");
                }
                sb.append(h);
            }
            ed.setText(sb.toString());
            LinearLayout box2 = new LinearLayout(this);
            box2.setOrientation(LinearLayout.VERTICAL);
            box2.setPadding(32, 24, 32, 8);
            TextView tip = new TextView(this);
            tip.setText("每行/每个逗号一条，例如：\n<PC-LAN-IP>:19390（家里直连）\n<TAILSCALE-IP>:19390（走 Tailscale）");
            tip.setTextSize(13f);
            box2.addView(tip);
            box2.addView(ed);
            new AlertDialog.Builder(this)
                    .setTitle("候选线路")
                    .setView(box2)
                    .setPositiveButton("保存", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int which) {
                            String raw = ed.getText().toString().replace("\n", ",");
                            hosts = new java.util.ArrayList<String>();
                            for (String s : raw.split(",")) {
                                String h = normalizeHost(s);
                                if (h.length() > 0 && !hosts.contains(h)) {
                                    hosts.add(h);
                                }
                            }
                            if (hosts.isEmpty()) {
                                hosts.add(normalizeHost(DEFAULT_HOST));
                            }
                            saveHosts();
                            lastProbeAt = 0;
                            maybeAutoPick("hosts-edited");
                            Toast.makeText(MainActivity.this, "已保存 " + hosts.size() + " 条候选",
                                    Toast.LENGTH_SHORT).show();
                        }
                    })
                    .setNegativeButton("取消", null)
                    .show();
        } catch (Throwable t) {
            Toast.makeText(this, "编辑失败：" + t.getClass().getSimpleName(), Toast.LENGTH_LONG).show();
        }
    }

    private String fullUrl() {
        return "http://" + host + "/?k=" + key;
    }

    private String liteUrl() {
        return "http://" + host + "/m/?k=" + key;
    }

    // ---------------- 崩溃日志 ----------------

    private File crashFile() {
        return new File(getFilesDir(), CRASH_FILE);
    }

    private void saveCrash(Throwable t) {
        try {
            StringWriter sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            FileWriter w = new FileWriter(crashFile(), false);
            w.write(sw.toString());
            w.close();
        } catch (Exception ignored) {
        }
    }

    private String readCrash() {
        File f = crashFile();
        if (!f.exists()) {
            return null;
        }
        try {
            BufferedReader r = new BufferedReader(new FileReader(f));
            StringBuilder sb = new StringBuilder();
            String line;
            int n = 0;
            while ((line = r.readLine()) != null && n++ < 14) {
                sb.append(line).append("\n");
            }
            r.close();
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler def = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread th, Throwable t) {
                saveCrash(t);
                if (def != null) {
                    def.uncaughtException(th, t);
                }
            }
        });
    }

    // ---------------- 生命周期 ----------------

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        installCrashHandler();

        // ① 先上屏一个纯文本视图：保证"永远不会什么都没有"
        status = new TextView(this);
        status.setBackgroundColor(Color.parseColor("#151517"));
        status.setTextColor(Color.parseColor("#E6E6E6"));
        status.setTextSize(14f);
        status.setPadding(48, 96, 48, 48);
        setContentView(status);
        String prev = readCrash();
        status.setText("DSH 启动中…" + (prev != null ? "\n\n上次崩溃记录：\n" + prev : ""));

        prefs = getSharedPreferences("dsh", Context.MODE_PRIVATE);
        host = prefs.getString("host", DEFAULT_HOST);
        key = prefs.getString("key", DEFAULT_KEY);
        loadHosts();
        initNetCallback();
        maybeAutoPick("start");
        startProbeLoop();

        // ② 构建真正的界面（出错也不空白，而是把异常显示出来）
        try {
            setContentView(buildRoot());
            int last = prefs.getInt("lastMode", 0);
            if (last == 2) {
                openMode(true);            // 上次用的轻量版：直接进
            } else if (last == 1) {
                openMode(false);           // 上次用的完整版：直接进
            } else {
                showHome();
                preloadFull();             // 你在看选择页时，后台已经在下载完整版
            }
        } catch (Throwable t) {
            saveCrash(t);
            StringWriter sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            status.setText("DSH 启动失败（已记录，下次启动仍会显示）：\n\n" + sw.toString());
        }
    }

    /**
     * 后台预加载完整版：用户还在选择页犹豫时，5 MB 的资源已经在下载。
     * 探测逻辑在预加载期间关闭（probed=true），避免把隐藏页面判成"没渲染出来"。
     */
    private void preloadFull() {
        if (web == null) {
            return;
        }
        probed = true;
        onLite = false;
        web.loadUrl(fullUrl());
    }

    // ---------------- 界面 ----------------

    private View buildRoot() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#151517"));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.GONE);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 6));

        // 顶部横幅已按用户要求去掉：不再加入视图树。
        // 返回选择页改由返回键负责（网页不能后退时按返回即回选择页）；
        // 加载进度由上面那条 6px 的进度条体现。
        banner = new TextView(this);
        banner.setVisibility(View.GONE);

        stage = new FrameLayout(this);
        root.addView(stage, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // ★★ 顺序很重要：必须先创建 WebView，再构建首页。
        //    首页里有 `if (web == null)` 判断；若先建首页，那一刻 web 尚未赋值，
        //    会永久误判成"WebView 用不了"（这个 bug 骗过我自己两轮）。
        web = createWebView();
        if (web != null) {
            try {
                WebSettings s = web.getSettings();
                s.setJavaScriptEnabled(true);
                s.setDomStorageEnabled(true);
                s.setDatabaseEnabled(true);
                // ★ 历史对话本地缓存（v7）：
                //   1) HTTP 磁盘缓存显式开启并落在应用私有目录；之前没设过 cacheMode，
                //      冷启动时 /assets/*（含字体）都要经中继重新拉一遍。
                //   2) 只用 LOAD_DEFAULT —— 过期就回网络，绝不用 LOAD_CACHE_ELSE_NETWORK
                //      那种"宁可吃陈旧页面"的模式。
                s.setCacheMode(WebSettings.LOAD_DEFAULT);
                try {
                    // WebView 的 HTTP 磁盘缓存本身就落在应用私有 cache 目录
                    // (<cacheDir>/WebView/Default/HTTP Cache)，API 33 起 setAppCachePath/
                    // setAppCacheEnabled 已被删除，公开 API 无法（也不需要）再改路径。
                    // 这里只做一件事：把目录建出来并把路径显示在诊断页，便于确认确实在私有目录。
                    cacheDirInfo = new File(getCacheDir(), "WebView").getAbsolutePath();
                    File wc = new File(getCacheDir(), "WebView");
                    if (!wc.exists()) {
                        wc.mkdirs();
                    }
                } catch (Throwable ignored) {
                }
                try {
                    // DOM storage / database 的持久化也随应用私有目录走（setDatabaseEnabled 已在上面开启；
                    // setDatabasePath 是 WebSQL 时代的老 API，JDK17 下会打 deprecation note，去掉）
                    File db = new File(getDir("webview", Context.MODE_PRIVATE), "dbs");
                    if (!db.exists()) {
                        db.mkdirs();
                    }
                } catch (Throwable ignored) {
                }
                s.setUseWideViewPort(true);
                s.setLoadWithOverviewMode(true);
                s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                CookieManager.getInstance().setAcceptCookie(true);
                web.setVisibility(View.GONE);
                wireWebView();
            } catch (Throwable t) {
                webError = stackOf(t);
                saveCrash(t);
                web = null;
            }
        }

        homeView = buildHomeView();
        stage.addView(homeView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        if (web != null) {
            stage.addView(web, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        stage.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return root;
    }

    private void wireWebView() {
        // 原生语音桥（必须在任何 loadUrl 之前注册，代理注入的 polyfill 才能立刻看到它）。
        // 安全性：桥只在页面里暴露少量录音/识别动作，不接触文件系统、不读写用户数据；
        // 页面来源是用户自己配置的 DSH 服务器。
        try {
            voice = new DshVoice();
            web.addJavascriptInterface(voice, "__DSHVoice");
        } catch (Throwable t) {
            voice = null;
            Log.w("DSH", "voice bridge 注册失败", t);
        }

        // 通用原生桥（v9）：唯一的稳定入口 window.__DSHNative。
        // 之后新增原生能力只改 JS 层（走热补丁通道），不必再重打包 APK。
        try {
            nat = new DshNative();
            web.addJavascriptInterface(nat, "__DSHNative");
            Log.i("DSH", "native bridge __DSHNative registered");
        } catch (Throwable t) {
            nat = null;
            Log.w("DSH", "native bridge 注册失败", t);
        }

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                bar.setVisibility(p < 100 ? View.VISIBLE : View.GONE);
                bar.setProgress(p);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                String msg = m.message() == null ? "" : m.message();
                if (msg.startsWith(PREWARM_TAG)) {
                    prewarmInfo = msg.substring(PREWARM_TAG.length()).trim();
                    Log.i("DSH", "prewarm result: " + prewarmInfo);
                    return true;
                }
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    consoleLog.append("· ").append(msg).append("\n");
                    if (consoleLog.length() > 1500) {
                        consoleLog.delete(0, 500);
                    }
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            request.grant(request.getResources());
                        } catch (Throwable ignored) {
                        }
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Throwable e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "打不开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;
            }

            /**
             * 预装资源直出：首屏那 12.5 MB 的插件包/JS/CSS 已经打进 APK，
             * 命中就用包内文件返回，完全不联网（中继再慢也不影响首屏）。
             * 键是"路径 + 完整查询串"（含内容哈希/rev），服务器一升级键就变，
             * 自动回落到网络，所以不会吃到过期资源。
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                try {
                    if (req == null || req.getUrl() == null) {
                        return null;
                    }
                    android.net.Uri u = req.getUrl();
                    String scheme = u.getScheme();
                    if (!"http".equals(scheme) && !"https".equals(scheme)) {
                        return null;
                    }
                    String p = u.getPath();
                    // ★ 语音通道（v8）：录音结束后，注入的 shim 用同源 fetch 把刚写好的
                    //   WAV 取回页面（比把 base64 塞进 evaluateJavascript 稳得多，
                    //   30 秒录音 ≈ 960 KB，base64 会到 1.3 MB）。
                    //   页面本身就是这台服务器，所以这里不需要再核对 host。
                    if (p != null && p.startsWith("/__dshvoice/")) {
                        String wavName = "dsh-voice.wav";
                        if (p.endsWith("/rec.wav")) {
                            File f = new File(getCacheDir(), wavName);
                            if (f.isFile() && f.length() > 44) {
                                WebResourceResponse r = new WebResourceResponse(
                                        "audio/wav", null, new FileInputStream(f));
                                Map<String, String> h = new HashMap<String, String>();
                                h.put("X-From-Voice", "1");
                                h.put("Cache-Control", "no-store");
                                r.setResponseHeaders(h);
                                return r;
                            }
                        }
                        WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8",
                                new java.io.ByteArrayInputStream("not-ready".getBytes()));
                        Map<String, String> h = new HashMap<String, String>();
                        h.put("Cache-Control", "no-store");
                        r.setResponseHeaders(h);
                        return r;
                    }
                    String h = u.getHost();
                    if (h == null || !host.startsWith(h)) {
                        return null;      // 不是我们的服务器，交给网络
                    }
                    if (p == null || !(p.startsWith("/assets/") || p.startsWith("/plugins/"))) {
                        return null;
                    }
                    // 键必须是原始（未百分号解码）的 "路径?查询"，与抓包时保存的键一致
                    String full = u.toString();
                    int schemeEnd = full.indexOf("://");
                    int pathStart = schemeEnd < 0 ? -1 : full.indexOf('/', schemeEnd + 3);
                    String key = pathStart >= 0 ? full.substring(pathStart) : null;
                    if (key == null) {
                        return null;
                    }
                    Map<String, String[]> idx = bundleIndex();
                    String[] e = idx.get(key);
                    if (e == null) {
                        // 忽略 rev 哈希再试：App 请求带 &rev=<内容哈希>，预装包是按抓包时的键存的，
                        // 不忽略就永远命中不了（10MB 插件包每次都得从中继下载）。
                        String k2 = key.replaceAll("[?&]rev=[^&]*", "");
                        e = idx.get(k2);
                        if (e == null) {
                            for (String kk : idx.keySet()) {
                                if (kk.replaceAll("[?&]rev=[^&]*", "").equals(k2)) {
                                    e = idx.get(kk);
                                    break;
                                }
                            }
                        }
                    }
                    if (e == null) {
                        return null;
                    }
                    // 先 hotbundle（OTA 覆盖包），再 assets/bundle（APK 预装）
                    File hf = new File(hotBundleDir(), e[0]);
                    boolean fromHot = hf.isFile();
                    InputStream in = fromHot ? (InputStream) new FileInputStream(hf)
                                             : getAssets().open("bundle/" + e[0]);
                    if (fromHot) {
                        hotHits++;
                    }
                    WebResourceResponse r = new WebResourceResponse(e[1], null, in);
                    Map<String, String> hdr = new HashMap<String, String>();
                    hdr.put("X-From-Bundle", "1");
                    hdr.put("X-From-Hotbundle", fromHot ? "1" : "0");
                    r.setResponseHeaders(hdr);
                    bundleHits++;
                    return r;
                } catch (Throwable t) {
                    return null;          // 任何异常都回落网络，绝不让页面打不开
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 页面一就绪就把「会话列表 + 最近会话分页」预热掉（走 App 自己的 /api/session/*）
                maybePrewarm("load");
                if (!probed) {
                    probed = true;
                    handler.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            probeContent(0);
                        }
                    }, 6000);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) {
                    showError("连不上服务器：确认手机 Tailscale 已连接、电脑开着。\n\n地址 " + host);
                }
            }
        });

        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String ua, String disposition,
                                        String mime, long length) {
                try {
                    openWithFromListener(url, mime);
                } catch (Throwable e) {
                    Toast.makeText(MainActivity.this, "无法下载：" + url, Toast.LENGTH_LONG).show();
                }
            }
        });
    }

    /* ===================== 用手机上的第三方 App 打开文件 =====================
     * 为什么需要它：DSH 前端把「打开文件 / 在应用中打开」委派给**电脑**（Host 侧用默认
     * 程序打开）。手机上要的是把文件交给本机的 App —— 走 Android 的 ACTION_VIEW 选择器。
     *
     * 链路：页面调 __DSHNative.call("openwith",{url,name,mime})
     *   -> 后台线程用 HttpURLConnection 把 /dl?path=...&k=... 下到 getCacheDir()/openwith/
     *   -> 通过本类的 DshFileProvider 得到 content:// URI（带读权限授予）
     *   -> 主线程 Intent.createChooser(ACTION_VIEW) —— 系统弹出"用哪个应用打开"
     * ====================================================================== */

    static final String OPENWITH_AUTHORITY = "ai.deepseek.dsh.mobile.fileprovider";
    static final String OPENWITH_DIR = "openwith";

    private File openWithDir() {
        File d = new File(getCacheDir(), OPENWITH_DIR);
        if (!d.isDirectory()) {
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
        }
        return d;
    }

    /** 只取 basename 并清掉路径分隔符/控制字符，绝不信任页面传来的名字。 */
    static String safeFileName(String name) {
        String n = name == null ? "" : name.trim();
        int cut = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (cut >= 0) {
            n = n.substring(cut + 1);
        }
        n = n.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
        if (n.length() == 0 || ".".equals(n) || "..".equals(n)) {
            n = "dsh-file";
        }
        if (n.length() > 96) {
            String ext = "";
            int dot = n.lastIndexOf('.');
            if (dot > 0 && n.length() - dot <= 12) {
                ext = n.substring(dot);
            }
            n = n.substring(0, 80) + ext;
        }
        return n;
    }

    private String openWithAbsUrl(String url) {
        if (url == null) {
            return null;
        }
        String u = url.trim();
        if (u.length() == 0) {
            return null;
        }
        if (u.startsWith("http://") || u.startsWith("https://")) {
            return u;
        }
        if (u.startsWith("/")) {
            return "http://" + host + u;      // 页面给同源相对路径：/dl?path=...&k=...
        }
        return null;
    }

    static String guessMime(String fileName) {
        String n = fileName == null ? "" : fileName.toLowerCase();
        int dot = n.lastIndexOf('.');
        String ext = dot > 0 ? n.substring(dot + 1) : "";
        try {
            String m = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (m != null && m.length() > 0) {
                return m;
            }
        } catch (Throwable ignored) {
        }
        if ("md".equals(ext) || "markdown".equals(ext)) {
            return "text/markdown";
        }
        if ("log".equals(ext) || "txt".equals(ext) || "ini".equals(ext) || "cfg".equals(ext)) {
            return "text/plain";
        }
        if ("py".equals(ext) || "js".equals(ext) || "ts".equals(ext) || "java".equals(ext)
                || "c".equals(ext) || "cpp".equals(ext) || "h".equals(ext) || "cs".equals(ext)
                || "go".equals(ext) || "rs".equals(ext) || "sh".equals(ext)) {
            return "text/plain";
        }
        if ("json".equals(ext)) {
            return "application/json";
        }
        return "application/octet-stream";
    }

    /**
     * 下载并弹选择器。故意在调用线程（JavaBridge 的后台线程）里做阻塞下载 ——
     * handle() 对 "openwith" 开头的方法走后台线程，主线程绝不能被这里堵住。
     */
    private String openWithDownload(String url, String name, String mime) {
        final String abs = openWithAbsUrl(url);
        if (abs == null) {
            return fail("bad-args", "url required (absolute or same-origin path)");
        }
        final String fname = safeFileName(name != null && name.length() > 0
                ? name : abs.substring(abs.lastIndexOf('/') + 1));
        final String type = (mime != null && mime.length() > 0) ? mime : guessMime(fname);
        File out = new File(openWithDir(), fname);
        long bytes = 0;
        java.net.HttpURLConnection c = null;
        try {
            c = (java.net.HttpURLConnection) new java.net.URL(abs).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(180000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "DSH-Android");
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new java.io.IOException("HTTP " + code);
            }
            InputStream in = c.getInputStream();
            FileOutputStream fo = new FileOutputStream(out);
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) {
                fo.write(buf, 0, n);
                bytes += n;
            }
            try {
                fo.flush();
            } catch (Throwable ignored) {
            }
            fo.close();
            in.close();
        } catch (Throwable e) {
            Log.w("DSH", "openwith 下载失败 " + abs, e);
            return fail("download", String.valueOf(e));
        } finally {
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
        launchChooser(out, type);
        return ok("{\"bytes\":" + bytes + ",\"name\":" + jsQuote(fname)
                + ",\"mime\":" + jsQuote(type) + ",\"dir\":\"cache\"}");
    }

    private void launchChooser(final File f, final String mime) {
        handler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Uri u = Uri.parse("content://" + OPENWITH_AUTHORITY + "/" + Uri.encode(f.getName()));
                    String type = (mime == null || mime.length() == 0) ? guessMime(f.getName()) : mime;
                    Intent i = new Intent(Intent.ACTION_VIEW);
                    i.setDataAndType(u, type);
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    Intent chooser = Intent.createChooser(i, "用手机应用打开");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    MainActivity.this.startActivity(chooser);
                } catch (Throwable t) {
                    Log.w("DSH", "openwith 起选择器失败", t);
                    try {
                        Toast.makeText(MainActivity.this, "没有可打开它的应用：" + t,
                                Toast.LENGTH_LONG).show();
                    } catch (Throwable ignored) {
                    }
                }
            }
        });
    }

    /**
     * 极简 ContentProvider：只读地对外提供 getCacheDir()/openwith/ 下的文件。
     * 不用 androidx.core 的 FileProvider —— 本项目离线构建（只有 android.jar），
     * 拿不到 androidx 依赖，自己实现这几十行反而更稳。
     */
    public static class DshFileProvider extends ContentProvider {

        private File dir() {
            Context c = getContext();
            File d = new File(c.getCacheDir(), OPENWITH_DIR);
            if (!d.isDirectory()) {
                //noinspection ResultOfMethodCallIgnored
                d.mkdirs();
            }
            return d;
        }

        private File fileOf(Uri uri) {
            String name = uri == null ? null : uri.getLastPathSegment();
            if (name == null || name.length() == 0) {
                return null;
            }
            File d = dir();
            File f = new File(d, name);
            try {
                if (!f.getCanonicalPath().startsWith(d.getCanonicalPath() + File.separator)) {
                    return null;      // 防穿越：只能取该目录下的文件
                }
            } catch (Throwable t) {
                return null;
            }
            return f;
        }

        @Override
        public boolean onCreate() {
            return true;
        }

        @Override
        public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
            File f = fileOf(uri);
            if (f == null || !f.isFile()) {
                throw new java.io.FileNotFoundException(String.valueOf(uri));
            }
            return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
        }

        @Override
        public String getType(Uri uri) {
            File f = fileOf(uri);
            return f == null ? "application/octet-stream" : guessMime(f.getName());
        }

        @Override
        public Cursor query(Uri uri, String[] projection, String selection,
                            String[] selectionArgs, String sortOrder) {
            File f = fileOf(uri);
            if (f == null) {
                return null;
            }
            MatrixCursor cur = new MatrixCursor(new String[]{"_display_name", "_size"});
            cur.addRow(new Object[]{f.getName(), f.length()});
            return cur;
        }

        @Override
        public Uri insert(Uri uri, ContentValues values) {
            return null;
        }

        @Override
        public int delete(Uri uri, String selection, String[] selectionArgs) {
            return 0;
        }

        @Override
        public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
            return 0;
        }
    }

    /** DownloadListener 在 UI 线程被调用 —— 必须换线程下载，绝不能堵主线程。 */
    private void openWithFromListener(final String url, final String mime) {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                final String res = openWithDownload(url, null, mime);
                if (res != null && res.contains("\"ok\":false")) {
                    handler.post(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                Toast.makeText(MainActivity.this, "下载失败：" + url,
                                        Toast.LENGTH_LONG).show();
                            } catch (Throwable ignored) {
                            }
                        }
                    });
                }
            }
        }, "dsh-openwith-dl");
        t.setDaemon(true);
        t.start();
    }

    private LinearLayout buildHomeView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.parseColor("#151517"));
        box.setPadding(56, 96, 56, 48);

        TextView title = new TextView(this);
        title.setText("DSH");
        title.setTextColor(Color.WHITE);
        title.setTextSize(30f);

        TextView sub = new TextView(this);
        sub.setText("选择打开方式");
        sub.setTextColor(Color.parseColor("#9AA4B2"));
        sub.setTextSize(14f);
        sub.setPadding(0, 8, 0, 40);

        Button full = new Button(this);
        full.setText("完整版（全功能）");
        full.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openMode(false);
            }
        });

        Button lite = new Button(this);
        lite.setText("轻量版（消息 + 发送）");
        lite.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openMode(true);
            }
        });

        Button lineBtn = new Button(this);
        lineBtn.setText("线路（局域网 / VPN 自动切换）");
        lineBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showLineDialog();
            }
        });
        box.addView(lineBtn);

        Button diag = new Button(this);
        diag.setText("诊断与设置");
        diag.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showError("当前服务器：" + host + "\n密钥："
                        + (key.length() > 6 ? key.substring(0, 6) + "…" : key) + "\n\n"
                        + "预装资源：包内 " + bundleIndex().size() + " 个，已命中 " + bundleHits + " 次\n"
                        + "HTTP 磁盘缓存：" + cacheDirInfo + "\n"
                        + "历史预热：已执行 " + prewarmRuns + " 次 · 最近结果 " + prewarmInfo + "\n"
                        + "连接唤醒：已执行 " + keepaliveRuns + " 次 · 最近结果 " + keepaliveInfo + "\n"
                        + "OTA 预装包：" + hotBundleInfo + "（hotbundle 命中 " + hotHits + " 次）\n"
                        + "原生桥：" + (nat != null ? "window.__DSHNative 已注册" : "未注册") + "\n"
                        + "线路：" + host + lineTag(host) + "\n"
                        + "候选探测：" + lastProbeSummary + "\n\n"
                        + "WebView 默认 UA：\n" + defaultUa() + "\n\n"
                        + (consoleLog.length() > 0 ? "控制台错误：\n" + consoleLog : "（暂无控制台错误）"));
            }
        });


        // 热补丁 / 原生桥自检：页面侧热补丁状态 + __dshHotErrors + 一次真实的
        // __DSHNative.call("info") 往返（验证 callId 关联与 __DSHNativeResult 通路）。
        Button hotDiag = new Button(this);
        hotDiag.setText("热补丁 / 原生桥自检");
        hotDiag.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                final String base = "OTA 预装包：" + hotBundleInfo
                        + "\nhotbundle 命中：" + hotHits + " 次"
                        + "\n包内索引：" + bundleIndex().size() + " 条"
                        + "\n原生桥 __DSHNative：" + (nat != null ? "已注册" : "未注册") + "\n\n";
                if (web == null) {
                    showError(base + "（WebView 不可用，页面侧信息取不到）");
                    return;
                }
                showError(base + "正在自检…");
                web.evaluateJavascript(hotDiagJs(), new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        hotDiagPage = unquoteJson(v);
                        evalJs("(function(){try{if(!window.dshNative){"
                                + "window.__dshDiagBridge='(页面里没有 dshNative 包装，热补丁未注入)';return;}"
                                + "window.dshNative('info',{}).then(function(r){"
                                + "window.__dshDiagBridge=JSON.stringify(r);},function(e){"
                                + "window.__dshDiagBridge='ERR '+(e&&(e.error||e.message)||e);});"
                                + "}catch(e){window.__dshDiagBridge='ERR '+e;}})()");
                        handler.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                try {
                                    web.evaluateJavascript("window.__dshDiagBridge||'(无应答)'",
                                            new ValueCallback<String>() {
                                                @Override
                                                public void onReceiveValue(String v2) {
                                                    showError(base + "页面侧热补丁：\n" + hotDiagPage
                                                            + "\n\n__DSHNative.call('info') 真实往返：\n"
                                                            + unquoteJson(v2));
                                                }
                                            });
                                } catch (Throwable t) {
                                    showError(base + "页面侧热补丁：\n" + hotDiagPage
                                            + "\n\n桥往返取不到：" + t);
                                }
                            }
                        }, 1200);
                    }
                });
            }
        });

        // 语音输入自检：页面侧的 __dshVoiceDiag()（shim 装没装上、桥信息、最近日志）
        // + 原生侧的权限 / 识别引擎状态。手机上一眼能看出卡在哪一环。
        Button voiceDiag = new Button(this);
        voiceDiag.setText("\u8bed\u97f3\u8f93\u5165\u81ea\u68c0");
        voiceDiag.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String head = "\u539f\u751f\u8bed\u97f3\u6865 __DSHVoice\uff1a"
                        + (voice != null ? "\u5df2\u6ce8\u518c" : "\u672a\u6ce8\u518c\uff08\u88c5\u7684\u662f\u65e7 APK\uff09")
                        + "\n\u9ea6\u514b\u98ce\u6743\u9650 RECORD_AUDIO\uff1a" + voicePermState()
                        + "\n\u7aef\u4e0a\u8bc6\u522b\u5f15\u64ce SpeechRecognizer\uff1a"
                        + (voiceAsrAvailable() ? "\u53ef\u7528" : "\u4e0d\u53ef\u7528\uff08\u672c\u673a\u6ca1\u6709\u8bc6\u522b\u670d\u52a1\uff09") + "\n"
                        + "\uff08\u8bed\u97f3\u8f93\u5165\u672c\u8eab\u53ea\u7528\u5230\u5f55\u97f3\uff0c\u8bc6\u522b\u5728\u8dd1 DSH \u7684\u7535\u8111\u4e0a\u505a\uff09\n\n";
                if (web == null || web.getUrl() == null) {
                    showError(head + "WebView \u8fd8\u6ca1\u6253\u5f00\u8fc7\u9875\u9762\uff0c\u5148\u70b9\u4e00\u6b21\u300c\u5b8c\u6574\u7248\u300d\u518d\u6765\u81ea\u68c0\u3002");
                    return;
                }
                showError(head + "\u6b63\u5728\u81ea\u68c0\u2026");
                web.evaluateJavascript(
                        "(function(){try{return (window.__dshVoiceDiag?"
                                + "window.__dshVoiceDiag():"
                                + "JSON.stringify({polyfill:0,"
                                + "note:'proxy did not inject dsh-voice (?no-voice=1 or old proxy)',"
                                + "mediaDevices:typeof navigator.mediaDevices,"
                                + "secure:!!window.isSecureContext,"
                                + "bridge:typeof window.__DSHVoice}));"
                                + "}catch(e){return JSON.stringify({err:String(e)});}})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String v) {
                                showError(head + "\u9875\u9762\u4fa7\uff1a\n" + voiceUnquote(v));
                            }
                        });
            }
        });

        // WebView 不可用时的兜底：交给系统浏览器
        Button browser = new Button(this);
        browser.setText("用系统浏览器打开");
        browser.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(fullUrl())));
                } catch (Throwable e) {
                    showError("没有可用的浏览器。\n\n" + fullUrl());
                }
            }
        });

        homeInfo = new TextView(this);
        homeInfo.setTextColor(Color.parseColor("#6E7681"));
        homeInfo.setTextSize(12f);
        homeInfo.setPadding(0, 32, 0, 0);

        box.addView(title);
        box.addView(sub);
        if (web == null) {
            TextView warn = new TextView(this);
            warn.setText("⚠ 这台设备的 WebView 组件用不了，下面这段就是原因（可截图/复制发我）：\n\n"
                    + (webError != null ? webError : "（没有捕获到异常文本）"));
            warn.setTextColor(Color.parseColor("#FFB4A2"));
            warn.setTextSize(11f);
            warn.setPadding(0, 0, 0, 24);
            ScrollView wsv = new ScrollView(this);
            wsv.addView(warn);
            box.addView(wsv, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

            Button copyErr = new Button(this);
            copyErr.setText("复制这段原因");
            copyErr.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("dsh-webview-error",
                            webError != null ? webError : "no-error"));
                    Toast.makeText(MainActivity.this, "已复制 ✓", Toast.LENGTH_SHORT).show();
                }
            });
            box.addView(copyErr);
        } else {
            box.addView(full);
            box.addView(lite);
        }
        box.addView(diag);
        box.addView(voiceDiag);
        box.addView(browser);
        box.addView(homeInfo);

        for (int i = 0; i < box.getChildCount(); i++) {
            View c = box.getChildAt(i);
            if (c instanceof Button) {
                c.setOnLongClickListener(new View.OnLongClickListener() {
                    @Override
                    public boolean onLongClick(View v) {
                        showSettingsDialog();
                        return true;
                    }
                });
            }
        }
        return box;
    }

    /**
     * 用多种主题逐个尝试构造 WebView。
     * 部分 ROM（尤其华为/HarmonyOS）下 Activity 主题取不到 webViewStyle 会让
     * `new WebView(activity)` 抛异常；换成 ContextThemeWrapper 包一层 Material/DeviceDefault 主题常能成功。
     */
    private WebView createWebView() {
        int[] themes = new int[]{
                -1,                                     // 先用 Activity 自身主题
                android.R.style.Theme_DeviceDefault,
                android.R.style.Theme_Material_Light,
                android.R.style.Theme_DeviceDefault_Light,
                android.R.style.Theme_Material,
                android.R.style.Theme_Holo_Light,
        };
        Throwable last = null;
        StringBuilder tried = new StringBuilder();
        for (int th : themes) {
            try {
                WebView w = (th == -1)
                        ? new WebView(this)
                        : new WebView(new android.view.ContextThemeWrapper(this, th));
                Log.i("DSH", "WebView 构造成功，主题=" + th);
                return w;
            } catch (Throwable t) {
                last = t;
                tried.append("theme=").append(th).append(" → ")
                        .append(t.getClass().getSimpleName()).append(": ")
                        .append(String.valueOf(t.getMessage())).append("\n");
                Log.w("DSH", "WebView 构造失败 theme=" + th, t);
            }
        }
        if (last != null) {
            webError = "WebView 构造失败（已逐个尝试主题）：\n" + tried + "\n"
                    + stackOf(last);
            saveCrash(last);
        }
        return null;
    }

    private String stackOf(Throwable t) {
        try {
            StringWriter sw = new StringWriter();
            t.printStackTrace(new PrintWriter(sw));
            String s = sw.toString();
            return s.length() > 1200 ? s.substring(0, 1200) : s;
        } catch (Throwable e) {
            return String.valueOf(t);
        }
    }

    /** 读取 APK 内预装的资源索引（assets/bundle/index.json），失败就当作没有预装包。 */
    private Map<String, String[]> bundleIndex() {
        if (bundleIdx != null) {
            return bundleIdx;
        }
        Map<String, String[]> m = new HashMap<String, String[]>();
        try {
            // 启动优先级：应用私有目录 <filesDir>/hotbundle/index.json（OTA 覆盖包，存在就用）
            //             否则回落到 APK 内的 assets/bundle/index.json。
            File hb = hotBundleIndex();
            InputStream in = (hb != null) ? (InputStream) new FileInputStream(hb)
                                          : getAssets().open("bundle/index.json");
            hotBundleInfo = (hb != null) ? ("hotbundle " + hb.getAbsolutePath())
                                         : "assets/bundle (无 hotbundle)";
            Log.i("DSH", "bundle source: " + hotBundleInfo);
            BufferedReader r = new BufferedReader(new java.io.InputStreamReader(in, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line);
            }
            r.close();
            org.json.JSONObject o = new org.json.JSONObject(sb.toString());
            java.util.Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                org.json.JSONObject v = o.getJSONObject(k);
                m.put(k, new String[]{v.optString("f"), v.optString("m", "application/octet-stream")});
            }
        } catch (Throwable ignored) {
        }
        bundleIdx = m;
        return m;
    }

    private String defaultUa() {
        try {
            return WebSettings.getDefaultUserAgent(this);
        } catch (Throwable t) {
            return "取不到（" + t.getClass().getSimpleName() + "）";
        }
    }

    private void showHome() {
        homeView.setVisibility(View.VISIBLE);
        if (web != null) {
            web.setVisibility(View.GONE);
        }
        errorView.setVisibility(View.GONE);
        banner.setVisibility(View.GONE);
        bar.setVisibility(View.GONE);
        probed = false;
        String ua = defaultUa();
        String ver = "?";
        int i = ua.indexOf("Chrome/");
        if (i >= 0) {
            ver = ua.substring(i + 7).split("[ .]")[0];
        }
        String prev = readCrash();
        homeInfo.setText("服务器 " + host + "\nWebView Chrome/" + ver
                + (prev != null ? "\n\n⚠ 上次崩溃记录：\n" + prev : "")
                + "\n（长按任意按钮可改地址/密钥）");
    }

    private void openMode(boolean lite) {
        if (web == null) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(fullUrl())));
            } catch (Throwable e) {
                showError("WebView 不可用，也没有可用的浏览器。\n\n" + fullUrl());
            }
            return;
        }
        onLite = lite;
        prefs.edit().putInt("lastMode", lite ? 2 : 1).apply();
        homeView.setVisibility(View.GONE);
        errorView.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        if (lite) {
            banner.setVisibility(View.GONE);
            probed = true;
            web.loadUrl(liteUrl());
            return;
        }
        // 完整版：如果后台预加载已经拉过这个地址，就不再重新下载，直接显示
        String cur = web.getUrl();
        boolean warm = cur != null && cur.startsWith("http") && cur.contains("k=" + key)
                && !cur.contains("/m/");
        probed = false;
        banner.setVisibility(View.VISIBLE);
        if (warm) {
            banner.setText("完整版（已预加载）· 点此回到选择页");
            startLoadTimer();
            handler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    probeContent(0);
                }
            }, 2500);
        } else {
            banner.setText("完整版加载中 0s · 点此回到选择页");
            startLoadTimer();
            web.loadUrl(fullUrl());
        }
    }

    /** 加载期间每秒刷新"已用秒数"，让用户知道它在动。 */
    private void startLoadTimer() {
        loadT0 = System.currentTimeMillis();
        handler.post(new Runnable() {
            @Override
            public void run() {
                if (web == null || web.getVisibility() != View.VISIBLE) {
                    return;
                }
                long s = (System.currentTimeMillis() - loadT0) / 1000;
                if (s > 0 && s < 600) {
                    CharSequence cur = banner.getText();
                    String base = cur.toString().replaceAll("\\d+s", "").trim();
                    banner.setText(base + " " + s + "s");
                }
                handler.postDelayed(this, 1000);
            }
        });
    }

    /**
     * 多点探测（6s / 14s / 26s）。只看渲染相关的 innerText 会误判：
     *   · 页面慢时还没渲染完 → 误报"没内容"并把用户正在加载的页面盖掉；
     *   · 元素被隐藏/零高时 innerText 为空，但 textContent 与 DOM 节点数是有内容的。
     * 因此：innerText / textContent / DOM 节点数 / 应用根节点文本 一起看，且要连续失败才报错。
     */
    private void probeContent(final int attempt) {
        if (onLite || web == null) {
            return;
        }
        web.evaluateJavascript(
                "(function(){try{var b=document.body||{};"
                        + "var it=(b.innerText||'').trim();var tc=(b.textContent||'').trim();"
                        + "var n=document.querySelectorAll('*').length;"
                        + "var a=document.querySelector('[class*=\"frame\"],[class*=\"centerCol\"]');"
                        + "var at=a?((a.innerText||a.textContent||'').trim()):'';"
                        + "return JSON.stringify({il:it.length,tl:tc.length,n:n,al:at.length,"
                        + "rs:String(document.readyState),head:(it||tc).slice(0,60)});"
                        + "}catch(e){return JSON.stringify({err:String(e)});}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        int il = -1, tl = -1, n = -1, al = -1;
                        String head = "", err = "";
                        try {
                            String decoded = String.valueOf(new org.json.JSONTokener(value).nextValue());
                            org.json.JSONObject o = new org.json.JSONObject(decoded);
                            il = o.optInt("il", -1);
                            tl = o.optInt("tl", -1);
                            n = o.optInt("n", -1);
                            al = o.optInt("al", -1);
                            head = o.optString("head", "");
                            err = o.optString("err", "");
                        } catch (Throwable t) {
                            err = String.valueOf(t);
                        }
                        boolean ok = il >= 5 || tl >= 200 || (n >= 60 && al >= 5);
                        if (ok) {
                            banner.setText("完整版 · 点此回到选择页");
                            banner.setVisibility(View.VISIBLE);
                            return;
                        }
                        if (attempt < 2) {
                            banner.setVisibility(View.VISIBLE);
                            banner.setText("完整版仍在加载…（第 " + (attempt + 2) + " 次探测）· 点此回到选择页");
                            handler.postDelayed(new Runnable() {
                                @Override
                                public void run() {
                                    probeContent(attempt + 1);
                                }
                            }, 8000);
                            return;
                        }
                        showError("完整版在这台机的 WebView 里没有渲染出内容。\n\n"
                                + "WebView 版本：\n" + defaultUa() + "\n\n"
                                + "探测数据：innerText=" + il + " 字 · textContent=" + tl + " 字 · DOM 节点="
                                + n + " · 应用根文本=" + al + " 字\n"
                                + "页面开头：" + head + "\n"
                                + (err.length() > 0 ? "探测异常：" + err + "\n" : "")
                                + (consoleLog.length() > 0 ? "控制台错误：\n" + consoleLog : "（无控制台错误）"));
                    }
                });
    }

    private LinearLayout buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setBackgroundColor(Color.parseColor("#151517"));
        box.setPadding(48, 96, 48, 48);

        TextView title = new TextView(this);
        title.setText("DSH");
        title.setTextColor(Color.WHITE);
        title.setTextSize(20f);

        errorDetail = new TextView(this);
        errorDetail.setTextColor(Color.parseColor("#9AA4B2"));
        errorDetail.setTextSize(13f);
        errorDetail.setPadding(0, 24, 0, 24);

        Button home = new Button(this);
        home.setText("返回选择页");
        home.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showHome();
            }
        });

        // 探测可能误判（页面只是慢）：提供"不重载、直接回到刚才那个页面"
        Button resume = new Button(this);
        resume.setText("回到页面（继续等待）");
        resume.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                errorView.setVisibility(View.GONE);
                homeView.setVisibility(View.GONE);
                if (web != null) {
                    web.setVisibility(View.VISIBLE);
                    banner.setText("完整版 · 点此回到选择页");
                    banner.setVisibility(View.VISIBLE);
                }
            }
        });

        Button retry = new Button(this);
        retry.setText("重试完整版");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openMode(false);
            }
        });

        Button lite = new Button(this);
        lite.setText("打开轻量版（消息+发送）");
        lite.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openMode(true);
            }
        });

        Button browser = new Button(this);
        browser.setText("用系统浏览器打开");
        browser.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(fullUrl())));
                } catch (Throwable e) {
                    Toast.makeText(MainActivity.this, "没有可用的浏览器", Toast.LENGTH_SHORT).show();
                }
            }
        });

        Button server = new Button(this);
        server.setText("设置服务器地址 / 密钥");
        server.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showSettingsDialog();
            }
        });

        final Button copy = new Button(this);
        copy.setText("复制诊断信息");
        copy.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("dsh-diag", errorDetail.getText().toString()));
                copy.setText("已复制 ✓");
            }
        });

        ScrollView sv = new ScrollView(this);
        sv.addView(errorDetail);
        box.addView(title);
        box.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        box.addView(home);
        box.addView(resume);
        box.addView(retry);
        box.addView(lite);
        box.addView(browser);
        box.addView(server);
        box.addView(copy);
        return box;
    }

    private void showSettingsDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(48, 32, 48, 16);

        TextView l1 = new TextView(this);
        l1.setText("服务器地址（host:port）");
        l1.setTextSize(13f);
        final EditText e1 = new EditText(this);
        e1.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        e1.setText(host);

        TextView l2 = new TextView(this);
        l2.setText("访问密钥（?k= 后面那串）");
        l2.setTextSize(13f);
        l2.setPadding(0, 24, 0, 0);
        final EditText e2 = new EditText(this);
        e2.setInputType(InputType.TYPE_CLASS_TEXT);
        e2.setText(key);

        box.addView(l1);
        box.addView(e1);
        box.addView(l2);
        box.addView(e2);

        final Button clear = new Button(this);
        clear.setText("清理缓存（下次重新下载前端）");
        clear.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    if (web != null) {
                        web.clearCache(true);
                        web.clearHistory();
                    }
                    prefs.edit().remove("lastMode").apply();
                    Toast.makeText(MainActivity.this, "缓存已清理", Toast.LENGTH_SHORT).show();
                    clear.setText("缓存已清理 ✓");
                } catch (Throwable e) {
                    Toast.makeText(MainActivity.this, "清理失败：" + e.getClass().getSimpleName(),
                            Toast.LENGTH_LONG).show();
                }
            }
        });
        box.addView(clear);

        try {
            new AlertDialog.Builder(this)
                    .setTitle("服务器设置")
                    .setView(box)
                    .setPositiveButton("保存", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface d, int which) {
                            String h = e1.getText().toString().trim();
                            String k = e2.getText().toString().trim();
                            h = h.replace("http://", "").replace("https://", "");
                            while (h.endsWith("/")) {
                                h = h.substring(0, h.length() - 1);
                            }
                            if (h.length() == 0) {
                                Toast.makeText(MainActivity.this, "地址不能为空", Toast.LENGTH_SHORT).show();
                                return;
                            }
                            prefs.edit().putString("host", h).putString("key", k).apply();
                            host = h;
                            key = k;
                            showHome();
                        }
                    })
                    .setNegativeButton("取消", null)
                    .show();
        } catch (Throwable t) {
            saveCrash(t);
            Toast.makeText(this, "打不开设置：" + t.getClass().getSimpleName(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        maybeAutoPick("resume");
        // 回到前台：
        //   ① 轻量数据刷新 —— 唤醒 WS 连接（唯一一次 poke，绝不整页 reload）；
        //   ② 顺手预热一次，把重启代理/清空缓存后的空档补上。
        if (web != null && web.getVisibility() == View.VISIBLE && !onLite) {
            maybeKeepalive("resume");
            maybePrewarm("resume");
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            Uri[] results = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    results = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(req, res, data);
    }

    private void showError(String msg) {
        errorDetail.setText(msg);
        errorView.setVisibility(View.VISIBLE);
        homeView.setVisibility(View.GONE);
        if (web != null) {
            web.setVisibility(View.GONE);
        }
        banner.setVisibility(View.GONE);
        Log.e("DSH", msg);
    }

    @Override
    public void onBackPressed() {
        // 先问页面：热补丁/页面脚本通过 window.__dshNativeBack() 返回 true 表示"我处理了这次返回"，
        // 此时不退出。页面没应答（或没有该函数）就在 400ms 内走默认动作，绝不会按了没反应。
        if (askPageBack()) {
            return;
        }
        doBackDefault();
    }

    // ==================================================================
    //  语音输入桥（v8）
    // ==================================================================

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == REQ_AUDIO) {
            boolean ok = res != null && res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
            Log.i("DSH", "voice perm result: " + ok);
            if (ok) {
                String r = onUi(new Callable<String>() {
                    @Override
                    public String call() {
                        return voiceStartNow();
                    }
                });
                if (r == null || r.indexOf("\"ok\":1") < 0) {
                    evalJs("window.__dshVoicePerm&&window.__dshVoicePerm(\"0\")");
                }
            } else {
                evalJs("window.__dshVoicePerm&&window.__dshVoicePerm(\"0\")");
            }
            return;
        }
        super.onRequestPermissionsResult(req, perms, res);
    }

    /** 在 UI 线程上跑一段代码并把结果同步带回 JavaBridge 线程。 */
    private String onUi(final Callable<String> c) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            try {
                return c.call();
            } catch (Throwable t) {
                return errJson("bridge", String.valueOf(t));
            }
        }
        FutureTask<String> ft = new FutureTask<String>(c);
        handler.post(ft);
        try {
            return ft.get(6000, TimeUnit.MILLISECONDS);
        } catch (Throwable t) {
            return errJson("timeout", String.valueOf(t));
        }
    }

    private static String errJson(String code, String msg) {
        return "{\"ok\":0,\"code\":" + jsQuote(code) + ",\"msg\":" + jsQuote(msg) + "}";
    }

    static String jsQuote(String s) {
        return org.json.JSONObject.quote(s == null ? "" : s);
    }

    private void evalJs(String js) {
        final WebView w = web;
        if (w == null) {
            return;
        }
        w.post(new Runnable() {
            @Override
            public void run() {
                try {
                    w.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    private static void le32(byte[] b, int at, int v) {
        b[at] = (byte) (v & 0xFF);
        b[at + 1] = (byte) ((v >> 8) & 0xFF);
        b[at + 2] = (byte) ((v >> 16) & 0xFF);
        b[at + 3] = (byte) ((v >> 24) & 0xFF);
    }

    private static void le16(byte[] b, int at, int v) {
        b[at] = (byte) (v & 0xFF);
        b[at + 1] = (byte) ((v >> 8) & 0xFF);
    }

    private static void ascii(byte[] b, int at, String s) {
        for (int i = 0; i < s.length(); i++) {
            b[at + i] = (byte) s.charAt(i);
        }
    }

    /** 把裸 PCM（16 kHz / 单声道 / 16 bit）加上 WAV 头写成 <cache>/dsh-voice.wav。 */
    private static long writeWav(File pcm, File wav) throws Exception {
        long len = pcm.length();
        int dataLen = (int) Math.min(len, 0x7FFFF000L);
        FileOutputStream o = new FileOutputStream(wav, false);
        try {
            byte[] h = new byte[44];
            ascii(h, 0, "RIFF");
            le32(h, 4, 36 + dataLen);
            ascii(h, 8, "WAVE");
            ascii(h, 12, "fmt ");
            le32(h, 16, 16);
            le16(h, 20, 1);          // PCM
            le16(h, 22, 1);          // mono
            le32(h, 24, 16000);
            le32(h, 28, 32000);      // byte rate
            le16(h, 32, 2);
            le16(h, 34, 16);
            ascii(h, 36, "data");
            le32(h, 40, dataLen);
            o.write(h);
            FileInputStream in = new FileInputStream(pcm);
            try {
                byte[] b = new byte[16384];
                long left = dataLen;
                while (left > 0) {
                    int n = in.read(b, 0, (int) Math.min(b.length, left));
                    if (n <= 0) {
                        break;
                    }
                    o.write(b, 0, n);
                    left -= n;
                }
            } finally {
                try {
                    in.close();
                } catch (Throwable ignored) {
                }
            }
        } finally {
            try {
                o.close();
            } catch (Throwable ignored) {
            }
        }
        return wav.length();
    }

    private static String asrErrorCode(int e) {
        switch (e) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio-capture";
            case SpeechRecognizer.ERROR_CLIENT:
                return "client";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network";
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "busy";
            case SpeechRecognizer.ERROR_SERVER:
                return "server";
            default:
                return "unknown";
        }
    }

    // ---- 录音状态（全部只在 UI 线程读写） ----
    private AudioRecord aRec;
    private Thread aPump;
    private volatile boolean aOn;
    private volatile boolean aAbort;
    private File aPcm;
    private long aT0;
    private SpeechRecognizer asr;
    private volatile boolean asrOn;
    private volatile boolean asrAbort;

    private String voicePermState() {
        boolean granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            return "granted";
        }
        return voiceAsked ? "denied" : "prompt";
    }

    private boolean voiceAsrAvailable() {
        try {
            return SpeechRecognizer.isRecognitionAvailable(this);
        } catch (Throwable t) {
            return false;
        }
    }

    /** \u628a evaluateJavascript \u8fd4\u56de\u7684 JSON \u5b57\u7b26\u4e32\u8fd8\u539f\u6210\u53ef\u8bfb\u6587\u672c\u3002 */
    private static String voiceUnquote(String v) {
        if (v == null) {
            return "(null)";
        }
        try {
            return String.valueOf(new org.json.JSONTokener(v).nextValue());
        } catch (Throwable t) {
            return v;
        }
    }

    private String voiceStartNow() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            return "{\"ok\":0,\"pending\":1,\"code\":\"permission\"}";
        }
        try {
            voiceStopNow(true);
            int sr = 16000;
            int min = AudioRecord.getMinBufferSize(sr, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT);
            int buf = Math.max(min > 0 ? min * 2 : 8192, 8192);
            int[] sources = new int[]{
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    MediaRecorder.AudioSource.MIC};
            AudioRecord r = null;
            String last = "";
            for (int i = 0; i < sources.length && r == null; i++) {
                try {
                    AudioRecord t = new AudioRecord(sources[i], sr,
                            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buf);
                    if (t.getState() == AudioRecord.STATE_INITIALIZED) {
                        r = t;
                    } else {
                        try {
                            t.release();
                        } catch (Throwable ignored) {
                        }
                        last = "STATE_UNINITIALIZED(source=" + sources[i] + ")";
                    }
                } catch (Throwable t) {
                    last = t.getClass().getSimpleName() + ": " + t.getMessage();
                }
            }
            if (r == null) {
                return errJson("audio-capture", "AudioRecord 初始化失败 " + last);
            }
            aPcm = new File(getCacheDir(), VOICE_PCM);
            final RandomAccessFile raf = new RandomAccessFile(aPcm, "rw");
            raf.setLength(0);
            aAbort = false;
            aOn = true;
            aRec = r;
            aT0 = System.currentTimeMillis();
            r.startRecording();
            if (r.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                aOn = false;
                try {
                    r.release();
                } catch (Throwable ignored) {
                }
                aRec = null;
                raf.close();
                return errJson("audio-capture", "AudioRecord.startRecording() 没有进入录音态");
            }
            final AudioRecord fr = r;
            aPump = new Thread(new Runnable() {
                @Override
                public void run() {
                    byte[] b = new byte[4096];
                    try {
                        while (aOn) {
                            int n = fr.read(b, 0, b.length);
                            if (n <= 0) {
                                break;
                            }
                            raf.write(b, 0, n);
                        }
                    } catch (Throwable t) {
                        Log.w("DSH", "voice pump: " + t);
                    } finally {
                        try {
                            raf.close();
                        } catch (Throwable ignored) {
                        }
                    }
                }
            }, "dsh-voice-pump");
            aPump.start();
            evalJs("window.__dshVoiceRecReady&&window.__dshVoiceRecReady()");
            return "{\"ok\":1}";
        } catch (Throwable t) {
            voiceStopNow(true);
            return errJson("audio-capture", String.valueOf(t));
        }
    }

    private void voiceStopNow(boolean discard) {
        aOn = false;
        AudioRecord r = aRec;
        aRec = null;
        if (r != null) {
            try {
                if (r.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    r.stop();
                }
            } catch (Throwable ignored) {
            }
            try {
                r.release();
            } catch (Throwable ignored) {
            }
        }
        Thread p = aPump;
        aPump = null;
        if (p != null) {
            try {
                p.join(1500);
            } catch (Throwable ignored) {
            }
        }
        if (discard && aPcm != null) {
            try {
                aPcm.delete();
            } catch (Throwable ignored) {
            }
        }
    }

    private void voiceFinish() {
        long ms = aT0 > 0 ? System.currentTimeMillis() - aT0 : 0;
        aT0 = 0;
        boolean discard = aAbort;
        aAbort = false;
        voiceStopNow(discard);
        long bytes = 0;
        String wavErr = null;
        try {
            if (!discard && aPcm != null && aPcm.isFile() && aPcm.length() > 0) {
                bytes = writeWav(aPcm, new File(getCacheDir(), VOICE_WAV));
            }
        } catch (Throwable t) {
            wavErr = String.valueOf(t);
        }
        if (wavErr != null) {
            evalJs("window.__dshVoiceRecError&&window.__dshVoiceRecError("
                    + jsQuote("write") + "," + jsQuote(wavErr) + ")");
            return;
        }
        evalJs("window.__dshVoiceRecEnd&&window.__dshVoiceRecEnd(" + ms + "," + bytes + ")");
    }

    /**
     * 原生语音桥。页面里叫 window.__DSHVoice。
     *
     * 所有 @JavascriptInterface 方法都在 WebView 的 JavaBridge 线程上被调用，
     * 因此凡是碰 AudioRecord / SpeechRecognizer / 权限对话框的都走 onUi()。
     */
    private final class DshVoice {

        @JavascriptInterface
        public String version() {
            return "1";
        }

        @JavascriptInterface
        public String perm() {
            return voicePermState();
        }

        @JavascriptInterface
        public String info() {
            String asrAvail = "0";
            try {
                asrAvail = SpeechRecognizer.isRecognitionAvailable(MainActivity.this) ? "1" : "0";
            } catch (Throwable ignored) {
            }
            String ua = "";
            try {
                ua = WebSettings.getDefaultUserAgent(MainActivity.this);
                int i = ua.indexOf("Chrome/");
                if (i >= 0) {
                    ua = "Chrome/" + ua.substring(i + 7).split("[ .]")[0];
                } else {
                    ua = "";
                }
            } catch (Throwable ignored) {
            }
            return "{\"v\":\"1\",\"sdk\":" + Build.VERSION.SDK_INT
                    + ",\"perm\":" + jsQuote(voicePermState())
                    + ",\"asr\":" + ("1".equals(asrAvail) ? "1" : "0")
                    + ",\"rec\":1,\"sampleRate\":16000"
                    + ",\"ua\":" + jsQuote(ua) + "}";
        }

        @JavascriptInterface
        public String startRec() {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                voiceAsked = true;
                MainActivity.this.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},
                                    REQ_AUDIO);
                            Log.i("DSH", "voice: requested RECORD_AUDIO");
                        } catch (Throwable t) {
                            Log.w("DSH", "voice: requestPermissions 失败", t);
                            evalJs("window.__dshVoicePerm&&window.__dshVoicePerm(\"0\")");
                        }
                    }
                });
                return "{\"ok\":0,\"pending\":1,\"code\":\"permission\"}";
            }
            return onUi(new Callable<String>() {
                @Override
                public String call() {
                    return voiceStartNow();
                }
            });
        }

        @JavascriptInterface
        public String stopRec() {
            return onUi(new Callable<String>() {
                @Override
                public String call() {
                    voiceFinish();
                    return "{\"ok\":1}";
                }
            });
        }

        @JavascriptInterface
        public String abortRec() {
            return onUi(new Callable<String>() {
                @Override
                public String call() {
                    aAbort = true;
                    voiceFinish();
                    return "{\"ok\":1}";
                }
            });
        }

        @JavascriptInterface
        public String asrAvailable() {
            try {
                return SpeechRecognizer.isRecognitionAvailable(MainActivity.this) ? "1" : "0";
            } catch (Throwable t) {
                return "0";
            }
        }

        @JavascriptInterface
        public String startAsr(final String lang) {
            return onUi(new Callable<String>() {
                @Override
                public String call() {
                    if (!SpeechRecognizer.isRecognitionAvailable(MainActivity.this)) {
                        return errJson("service-not-allowed",
                                "设备上没有可用的语音识别服务（华为部分机型无 Google/讯飞识别服务）");
                    }
                    asrStopNow();
                    try {
                        asrAbort = false;
                        asr = SpeechRecognizer.createSpeechRecognizer(MainActivity.this);
                        asr.setRecognitionListener(new RecognitionListener() {
                            @Override
                            public void onReadyForSpeech(Bundle p) {
                                evalJs("window.__dshVoiceAsrReady&&window.__dshVoiceAsrReady()");
                            }

                            @Override
                            public void onBeginningOfSpeech() {
                            }

                            @Override
                            public void onRmsChanged(float v) {
                            }

                            @Override
                            public void onBufferReceived(byte[] b) {
                            }

                            @Override
                            public void onEndOfSpeech() {
                            }

                            @Override
                            public void onPartialResults(Bundle b) {
                                asrEmit(b, false);
                            }

                            @Override
                            public void onResults(Bundle b) {
                                asrEmit(b, true);
                                asrOn = false;
                                evalJs("window.__dshVoiceAsrEnd&&window.__dshVoiceAsrEnd()");
                            }

                            @Override
                            public void onError(int e) {
                                boolean aborted = asrAbort;
                                asrOn = false;
                                if (aborted) {
                                    evalJs("window.__dshVoiceAsrError&&window.__dshVoiceAsrError("
                                            + jsQuote("aborted") + "," + jsQuote("") + ")");
                                } else {
                                    evalJs("window.__dshVoiceAsrError&&window.__dshVoiceAsrError("
                                            + jsQuote(asrErrorCode(e)) + ","
                                            + jsQuote("SpeechRecognizer error " + e) + ")");
                                }
                                evalJs("window.__dshVoiceAsrEnd&&window.__dshVoiceAsrEnd()");
                            }

                            @Override
                            public void onEvent(int t, Bundle b) {
                            }
                        });
                        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE,
                                (lang == null || lang.length() == 0) ? "zh-CN" : lang);
                        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
                        asrOn = true;
                        asr.startListening(i);
                        return "{\"ok\":1}";
                    } catch (Throwable t) {
                        asrStopNow();
                        return errJson("asr-start", String.valueOf(t));
                    }
                }
            });
        }

        @JavascriptInterface
        public String stopAsr() {
            return onUi(new Callable<String>() {
                @Override
                public String call() {
                    try {
                        if (asr != null && asrOn) {
                            asr.stopListening();
                        }
                    } catch (Throwable ignored) {
                    }
                    return "{\"ok\":1}";
                }
            });
        }

        @JavascriptInterface
        public String abortAsr() {
            return onUi(new Callable<String>() {
                @Override
                public String call() {
                    asrAbort = true;
                    asrStopNow();
                    evalJs("window.__dshVoiceAsrError&&window.__dshVoiceAsrError("
                            + jsQuote("aborted") + "," + jsQuote("") + ")");
                    evalJs("window.__dshVoiceAsrEnd&&window.__dshVoiceAsrEnd()");
                    return "{\"ok\":1}";
                }
            });
        }
    }

    private void asrEmit(Bundle b, boolean isFinal) {
        String text = "";
        try {
            ArrayList<String> l = b == null ? null
                    : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (l != null && !l.isEmpty()) {
                text = l.get(0);
            }
        } catch (Throwable ignored) {
        }
        if (text == null) {
            text = "";
        }
        if (text.length() == 0 && !isFinal) {
            return;
        }
        evalJs("window.__dshVoiceResult&&window.__dshVoiceResult("
                + jsQuote(text) + "," + (isFinal ? "true" : "false") + ")");
    }

    private void asrStopNow() {
        asrOn = false;
        SpeechRecognizer s = asr;
        asr = null;
        if (s != null) {
            try {
                s.cancel();
            } catch (Throwable ignored) {
            }
            try {
                s.destroy();
            } catch (Throwable ignored) {
            }
        }
    }

    // ==================================================================
    //  通用原生桥（v9）：window.__DSHNative.call(method, argsJson)
    // ==================================================================
    //  设计目标：APK 里只留**一个**稳定入口，以后新增原生能力全部在 JS 层（热补丁）
    //  扩展，不必再重打包 APK。
    //
    //  协议：
    //    · JS 调 window.__DSHNative.call(method, argsJson) -> 同步返回 callId
    //    · 结果异步回到 window.__DSHNativeResult(callId, resultJson)，用 callId 关联
    //    · 成功 {"ok":true,"value":{...}}；失败 {"ok":false,"error":"..."}
    //    · 未实现的方法一律回 {"ok":false,"error":"unknown-method"}，**绝不静默**
    //
    //  speech.* 不重复实现识别引擎，直接复用上面的 DshVoice（另一 agent 的语音桥）：
    //  speech.start -> DshVoice.startAsr；流式分片由 JS 层把 __dshVoiceResult /
    //  __dshVoiceAsrReady / __dshVoiceAsrEnd / __dshVoiceAsrError 中继到
    //  __DSHNativeResult（中继代码在热补丁 10-base.js 里，可随时热改）。
    private static final String HOTBUNDLE_DIR = "hotbundle";
    private static final long HOTBUNDLE_MAX = 64L * 1024 * 1024;
    private DshNative nat;
    private long natSeq = 0;
    private int hotHits = 0;
    private String hotBundleInfo = "(未检测)";
    private String hotDiagPage = "(未取)";
    private boolean backPending = false;
    private long backAskId = 0;

    // 类必须是 public：WebView 的 JS 桥走反射调用，public 类 + public 方法最稳。
    public final class DshNative {

        @JavascriptInterface
        public String call(final String method, final String argsJson) {
            final String callId = "n" + (++natSeq) + "-" + System.currentTimeMillis();
            final String m = method == null ? "" : method.trim();
            try {
                if (m.startsWith("bundle.") || m.startsWith("openwith")) {
                    // 下载/解包/校验会阻塞，放到后台线程；结果照样回 __DSHNativeResult
                    Thread t = new Thread(new Runnable() {
                        @Override
                        public void run() {
                            String res;
                            try {
                                res = handle(m, argsJson, callId);
                            } catch (Throwable e) {
                                res = fail("bridge", String.valueOf(e));
                            }
                            deliver(callId, res);
                        }
                    }, "dsh-native");
                    t.setDaemon(true);
                    t.start();
                } else {
                    // 其余方法都在主线程执行（Toast/剪贴板/震动/Intent/WebView 都要求主线程）
                    handler.post(new Runnable() {
                        @Override
                        public void run() {
                            String res;
                            try {
                                res = handle(m, argsJson, callId);
                            } catch (Throwable e) {
                                res = fail("bridge", String.valueOf(e));
                            }
                            deliver(callId, res);
                        }
                    });
                }
            } catch (Throwable ignored) {
            }
            return callId;
        }

        String handle(String m, String argsJson, String callId) {
            JSONObject args = new JSONObject();
            try {
                args = new JSONObject(argsJson == null || argsJson.length() == 0 ? "{}" : argsJson);
            } catch (Throwable ignored) {
            }

            if ("ping".equals(m)) {
                return ok("{\"pong\":true,\"t\":" + System.currentTimeMillis()
                        + ",\"callId\":" + jsQuote(callId) + "}");
            }

            if ("info".equals(m)) {
                return ok(appInfoJson());
            }

            if ("toast".equals(m)) {
                String text = args.optString("text", "");
                boolean longT = args.optBoolean("long", false);
                try {
                    Toast.makeText(MainActivity.this, text,
                            longT ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT).show();
                } catch (Throwable t) {
                    return fail("toast", String.valueOf(t));
                }
                return ok("{\"shown\":true,\"chars\":" + text.length() + "}");
            }

            if ("vibrate".equals(m)) {
                int ms2 = args.optInt("ms", 30);
                if (ms2 < 1) {
                    ms2 = 1;
                }
                if (ms2 > 5000) {
                    ms2 = 5000;
                }
                try {
                    Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                    if (v == null || !v.hasVibrator()) {
                        return "{\"ok\":false,\"error\":\"no-vibrator\"}";
                    }
                    if (Build.VERSION.SDK_INT >= 26) {
                        v.vibrate(android.os.VibrationEffect.createOneShot(
                                ms2, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
                    } else {
                        v.vibrate(ms2);
                    }
                } catch (Throwable t) {
                    return fail("vibrate", String.valueOf(t));
                }
                return ok("{\"vibrated\":true,\"ms\":" + ms2 + "}");
            }

            if ("share".equals(m)) {
                String text = args.optString("text", "");
                String title = args.optString("title", "DSH");
                try {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_TEXT, text);
                    i.putExtra(Intent.EXTRA_SUBJECT, title);
                    startActivity(Intent.createChooser(i, title));
                } catch (Throwable t) {
                    return fail("share", String.valueOf(t));
                }
                return ok("{\"shared\":true,\"chars\":" + text.length() + "}");
            }

            if (m.startsWith("openwith")) {
                // 下载 + 交给手机上的第三方 App：downloads on the JavaBridge/background pool
                return openWithDownload(args.optString("url", ""), args.optString("name", ""),
                        args.optString("mime", ""));
            }

            if ("openUrl".equals(m)) {
                String url = args.optString("url", "");
                if (url.length() == 0) {
                    return fail("bad-args", "url required");
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Throwable t) {
                    return fail("openUrl", String.valueOf(t));
                }
                return ok("{\"opened\":true,\"url\":" + jsQuote(url) + "}");
            }

            if ("clipboard.get".equals(m)) {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    CharSequence cs = "";
                    if (cm != null && cm.getPrimaryClip() != null
                            && cm.getPrimaryClip().getItemCount() > 0) {
                        cs = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
                    }
                    return ok("{\"text\":" + jsQuote(cs == null ? "" : cs.toString()) + "}");
                } catch (Throwable t) {
                    return fail("clipboard.get", String.valueOf(t));
                }
            }

            if ("clipboard.set".equals(m)) {
                String text = args.optString("text", "");
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cm == null) {
                        return fail("clipboard.set", "no clipboard service");
                    }
                    cm.setPrimaryClip(ClipData.newPlainText("dsh", text));
                } catch (Throwable t) {
                    return fail("clipboard.set", String.valueOf(t));
                }
                return ok("{\"set\":true,\"chars\":" + text.length() + "}");
            }

            if ("back".equals(m)) {
                // 桥方向：页面请原生执行一次"返回"。返回 handled 表示这次返回被消耗掉了。
                String r = doBackDefault();
                return ok(r);
            }

            if ("speech.available".equals(m)) {
                boolean av = false;
                String extra = "";
                try {
                    av = voice != null && SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
                } catch (Throwable ignored) {
                }
                try {
                    if (voice != null) {
                        extra = voice.info();
                    }
                } catch (Throwable ignored) {
                }
                return ok("{\"available\":" + (av ? "true" : "false")
                        + ",\"engine\":\"__DSHVoice\",\"info\":" + jsQuote(extra) + "}");
            }

            if ("speech.start".equals(m)) {
                if (voice == null) {
                    return "{\"ok\":false,\"error\":\"voice-bridge-unavailable\"}";
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED) {
                    requestAudioPerm();
                    return "{\"ok\":false,\"error\":\"permission\",\"pending\":1,"
                            + "\"msg\":" + jsQuote("正在申请录音权限，授权后再调一次 speech.start") + "}";
                }
                String lang = args.optString("lang", "zh-CN");
                String r = voice.startAsr(lang);
                return translateVoice(r, "{\"started\":true,\"lang\":" + jsQuote(lang) + "}");
            }

            if ("speech.stop".equals(m)) {
                if (voice == null) {
                    return "{\"ok\":false,\"error\":\"voice-bridge-unavailable\"}";
                }
                return translateVoice(voice.stopAsr(), "{\"stopped\":true}");
            }

            if ("bundle.info".equals(m)) {
                return ok(bundleInfoJson());
            }

            if ("bundle.reset".equals(m)) {
                // 回滚：删掉 hotbundle，下次启动回落到 APK 内 assets/bundle/
                try {
                    rmrf(hotBundleDir());
                } catch (Throwable t) {
                    return fail("bundle.reset", String.valueOf(t));
                }
                bundleIdx = null;
                hotBundleInfo = "reset -> assets/bundle";
                clearWebCache();
                return ok("{\"reset\":true,\"hotbundle\":" + jsQuote(hotBundleDir().getAbsolutePath()) + "}");
            }

            if ("bundle.install".equals(m)) {
                return bundleInstall(args);
            }

            return "{\"ok\":false,\"error\":\"unknown-method\",\"method\":" + jsQuote(m) + "}";
        }
    }

    private static String ok(String valueFields) {
        return "{\"ok\":true,\"value\":" + valueFields + "}";
    }

    private static String fail(String code, String msg) {
        return "{\"ok\":false,\"error\":" + jsQuote(code) + ",\"msg\":" + jsQuote(msg) + "}";
    }

    private void deliver(String callId, String resultJson) {
        evalJs("window.__DSHNativeResult&&window.__DSHNativeResult("
                + jsQuote(callId) + "," + jsQuote(resultJson) + ")");
    }

    private String appInfoJson() {
        String ua = "";
        String pkg = "";
        String ver = "";
        int vc = 0;
        try {
            if (web != null) {
                ua = web.getSettings().getUserAgentString();
            }
        } catch (Throwable ignored) {
        }
        try {
            pkg = getPackageName();
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(pkg, 0);
            vc = pi.versionCode;
            ver = pi.versionName == null ? "" : pi.versionName;
        } catch (Throwable ignored) {
        }
        boolean wv = false;
        try {
            wv = web != null && (ua.contains("; wv") || ua.contains(" Version/4.0 "));
        } catch (Throwable ignored) {
        }
        return "{\"app\":\"DSH\",\"bridge\":\"__DSHNative\",\"package\":" + jsQuote(pkg)
                + ",\"versionCode\":" + vc + ",\"versionName\":" + jsQuote(ver)
                + ",\"sdk\":" + Build.VERSION.SDK_INT
                + ",\"device\":" + jsQuote(Build.MANUFACTURER + " " + Build.MODEL)
                + ",\"webview\":" + (wv ? "true" : "false")
                + ",\"ua\":" + jsQuote(ua)
                + ",\"nativeVoice\":" + (voice != null ? "true" : "false")
                + ",\"hotbundle\":" + jsQuote(hotBundleInfo)
                + ",\"hotbundleDir\":" + jsQuote(hotBundleDir().getAbsolutePath()) + "}";
    }

    /** 语音桥返回体（{"ok":1} / errJson）翻译成本桥的统一信封。 */
    private static String translateVoice(String raw, String okValue) {
        try {
            JSONObject o = new JSONObject(raw == null ? "{}" : raw);
            if (o.optInt("ok", 0) == 1) {
                return "{\"ok\":true,\"value\":" + okValue + "}";
            }
            return "{\"ok\":false,\"error\":" + jsQuote(o.optString("code", "voice-error"))
                    + ",\"msg\":" + jsQuote(o.optString("msg", ""))
                    + ",\"pending\":" + o.optInt("pending", 0) + "}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"error\":\"voice-bad-json\",\"msg\":" + jsQuote(String.valueOf(raw)) + "}";
        }
    }

    private void requestAudioPerm() {
        voiceAsked = true;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
                } catch (Throwable t) {
                    Log.w("DSH", "requestPermissions(RECORD_AUDIO) 失败", t);
                }
            }
        });
    }

    /** 默认返回动作，返回描述这次动作的 JSON 片段。 */
    private String doBackDefault() {
        try {
            if (errorView != null && errorView.getVisibility() == View.VISIBLE) {
                showHome();
                return "{\"handled\":true,\"action\":\"home\"}";
            }
            if (homeView != null && homeView.getVisibility() == View.VISIBLE) {
                return "{\"handled\":false,\"action\":\"exit\"}";
            }
            if (web != null && web.canGoBack()) {
                web.goBack();
                return "{\"handled\":true,\"action\":\"webview-goBack\"}";
            }
            showHome();
            return "{\"handled\":true,\"action\":\"home\"}";
        } catch (Throwable t) {
            return "{\"handled\":false,\"action\":\"error\"}";
        }
    }

    /**
     * 先问页面：window.__dshNativeBack() 返回 true 表示页面自己处理了这次返回。
     * evaluateJavascript 是异步的，所以给 400ms 兜底；页面没应答就照旧走默认动作，
     * 绝不会出现"返回键按了没反应"。
     */
    private boolean askPageBack() {
        if (web == null || web.getVisibility() != View.VISIBLE) {
            return false;
        }
        if (errorView != null && errorView.getVisibility() == View.VISIBLE) {
            return false;
        }
        if (homeView != null && homeView.getVisibility() == View.VISIBLE) {
            return false;
        }
        if (backPending) {
            return true;
        }
        final long id = ++backAskId;
        backPending = true;
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (backPending && id == backAskId) {
                    backPending = false;
                    doBackDefault();
                }
            }
        }, 400);
        try {
            web.evaluateJavascript(
                    "(function(){try{var f=window.__dshNativeBack;"
                            + "return (typeof f==='function')?(f()===true):false;}catch(e){return false;}})()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String v) {
                            if (id != backAskId) {
                                return;
                            }
                            boolean handled = "true".equals(v);
                            backPending = false;
                            if (!handled) {
                                doBackDefault();
                            }
                        }
                    });
        } catch (Throwable t) {
            backPending = false;
            return false;
        }
        return true;
    }

    // ---------------- OTA 预装包（hotbundle） ----------------

    /** 启动优先用应用私有目录 <filesDir>/hotbundle/；有 index.json 才算数。 */
    private File hotBundleDir() {
        return new File(getFilesDir(), HOTBUNDLE_DIR);
    }

    private File hotBundleIndex() {
        try {
            File f = new File(hotBundleDir(), "index.json");
            return (f.isFile() && f.length() > 0) ? f : null;
        } catch (Throwable t) {
            return null;
        }
    }

    private String bundleInfoJson() {
        File hot = hotBundleDir();
        int n = 0;
        long bytes = 0;
        try {
            File[] fs = hot.listFiles();
            if (fs != null) {
                for (File f : fs) {
                    n++;
                    bytes += f.length();
                }
            }
        } catch (Throwable ignored) {
        }
        return "{\"hotbundle\":" + jsQuote(hot.getAbsolutePath())
                + ",\"exists\":" + (hot.isDirectory() ? "true" : "false")
                + ",\"hasIndex\":" + (hotBundleIndex() != null ? "true" : "false")
                + ",\"files\":" + n + ",\"bytes\":" + bytes
                + ",\"active\":" + jsQuote(hotBundleInfo)
                + ",\"assetIndex\":" + bundleIndex().size()
                + ",\"hits\":" + hotHits + "}";
    }

    /**
     * bundle.install(url, sha256?, name?)：下载 zip / 单文件到 <filesDir>/hotbundle/，
     * 原子替换 + sha256 校验；任何一步失败都保留旧包（绝不出现"半个包"）。
     */
    private String bundleInstall(JSONObject args) {
        String url = args.optString("url", "");
        String wantSha = args.optString("sha256", "").trim().toLowerCase();
        String single = args.optString("name", "").trim();
        if (url.length() == 0) {
            return fail("bad-args", "url required");
        }
        byte[] data;
        try {
            data = httpGet(url);
        } catch (Throwable t) {
            return fail("download", String.valueOf(t));
        }
        String sha;
        try {
            sha = sha256hex(data);
        } catch (Throwable t) {
            return fail("sha256", String.valueOf(t));
        }
        if (wantSha.length() > 0 && !wantSha.equals(sha)) {
            return "{\"ok\":false,\"error\":\"sha256-mismatch\",\"want\":" + jsQuote(wantSha)
                    + ",\"got\":" + jsQuote(sha) + "}";
        }
        boolean zip = data.length > 4 && data[0] == 'P' && data[1] == 'K'
                && (data[2] == 3 || data[2] == 5 || data[2] == 7);
        File hot = hotBundleDir();
        String mode;
        try {
            if (zip) {
                mode = "zip";
                File stage = new File(getFilesDir(), HOTBUNDLE_DIR + ".new");
                File old = new File(getFilesDir(), HOTBUNDLE_DIR + ".old");
                rmrf(stage);
                rmrf(old);
                if (!stage.mkdirs()) {
                    return fail("io", "mkdir staging failed");
                }
                unzipInto(data, stage);
                if (!new File(stage, "index.json").isFile()) {
                    rmrf(stage);
                    return fail("no-index-json", "zip 里没有 index.json，拒绝替换（旧包保留）");
                }
                if (hot.exists() && !hot.renameTo(old)) {
                    rmrf(stage);
                    return fail("swap", "rename hotbundle -> .old failed（旧包保留）");
                }
                if (!stage.renameTo(hot)) {
                    if (old.exists()) {
                        old.renameTo(hot);      // 回滚
                    }
                    rmrf(stage);
                    return fail("swap", "rename .new -> hotbundle failed（已回滚旧包）");
                }
                rmrf(old);
            } else {
                mode = "file";
                String nm = single.length() > 0 ? single : baseName(url);
                if (nm.length() == 0 || nm.indexOf('/') >= 0 || nm.indexOf('\\') >= 0
                        || ".".equals(nm) || "..".equals(nm)) {
                    return fail("bad-name", "无法从 URL 推出安全文件名，请显式传 name");
                }
                if (!hot.isDirectory() && !hot.mkdirs()) {
                    return fail("io", "mkdir hotbundle failed");
                }
                File tmp = new File(hot, nm + ".part");
                writeFile(tmp, data);
                File dst = new File(hot, nm);
                if (dst.exists() && !dst.delete()) {
                    tmp.delete();
                    return fail("io", "delete old " + nm + " failed（旧文件保留）");
                }
                if (!tmp.renameTo(dst)) {
                    tmp.delete();
                    return fail("swap", "rename " + nm + " failed（旧文件保留）");
                }
                if (!new File(hot, "index.json").isFile()) {
                    // 单文件模式必须让查找表立即可用：把 APK 内的索引拷出来
                    copyAsset("bundle/index.json", new File(hot, "index.json"));
                }
            }
        } catch (Throwable t) {
            return fail("install", String.valueOf(t));
        }
        bundleIdx = null;        // 让下一次 shouldInterceptRequest 重读 hotbundle/index.json
        hotBundleInfo = "hotbundle(" + mode + ") " + sha.substring(0, 12);
        clearWebCache();
        return "{\"ok\":true,\"value\":{\"mode\":" + jsQuote(mode)
                + ",\"bytes\":" + data.length + ",\"sha256\":" + jsQuote(sha)
                + ",\"hotbundle\":" + jsQuote(hot.getAbsolutePath()) + "}}";
    }

    private void clearWebCache() {
        handler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (web != null) {
                        web.clearCache(true);
                    }
                } catch (Throwable ignored) {
                }
            }
        });
    }

    private byte[] httpGet(String url) throws Exception {
        java.net.HttpURLConnection c = null;
        try {
            c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(180000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "DSH-APK-hotbundle");
            int code = c.getResponseCode();
            if (code / 100 != 2) {
                throw new Exception("HTTP " + code);
            }
            int len = c.getContentLength();
            if (len > HOTBUNDLE_MAX) {
                throw new Exception("too large: " + len);
            }
            InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream bo =
                    new java.io.ByteArrayOutputStream(len > 0 ? len : 65536);
            try {
                byte[] buf = new byte[65536];
                int n;
                int total = 0;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > HOTBUNDLE_MAX) {
                        throw new Exception("too large (>64MB)");
                    }
                    bo.write(buf, 0, n);
                }
            } finally {
                in.close();
            }
            return bo.toByteArray();
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    private static String sha256hex(byte[] b) throws Exception {
        java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(b);
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte x : d) {
            sb.append(Character.forDigit((x >> 4) & 0xF, 16));
            sb.append(Character.forDigit(x & 0xF, 16));
        }
        return sb.toString();
    }

    private void unzipInto(byte[] data, File dir) throws Exception {
        java.util.zip.ZipInputStream z =
                new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(data));
        try {
            byte[] buf = new byte[65536];
            java.util.zip.ZipEntry e;
            while ((e = z.getNextEntry()) != null) {
                String n = e.getName().replace('\\', '/');
                if (n.startsWith("/") || n.contains("..")) {
                    throw new Exception("unsafe zip entry: " + n);
                }
                File f = new File(dir, n);
                if (e.isDirectory()) {
                    f.mkdirs();
                    continue;
                }
                File p = f.getParentFile();
                if (p != null && !p.isDirectory() && !p.mkdirs()) {
                    throw new Exception("mkdir failed: " + p);
                }
                FileOutputStream o = new FileOutputStream(f);
                try {
                    int k;
                    while ((k = z.read(buf)) > 0) {
                        o.write(buf, 0, k);
                    }
                } finally {
                    o.close();
                }
                z.closeEntry();
            }
        } finally {
            z.close();
        }
    }

    private void writeFile(File f, byte[] b) throws Exception {
        FileOutputStream o = new FileOutputStream(f);
        try {
            o.write(b);
            o.flush();
        } finally {
            o.close();
        }
    }

    private void copyAsset(String asset, File dst) throws Exception {
        InputStream in = getAssets().open(asset);
        try {
            writeFile(dst, readAll(in));
        } finally {
            in.close();
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream(65536);
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) {
            bo.write(buf, 0, n);
        }
        return bo.toByteArray();
    }

    private static String baseName(String url) {
        String s = url == null ? "" : url;
        int q = s.indexOf('?');
        if (q >= 0) {
            s = s.substring(0, q);
        }
        int h = s.indexOf('#');
        if (h >= 0) {
            s = s.substring(0, h);
        }
        int i = s.lastIndexOf('/');
        if (i >= 0) {
            s = s.substring(i + 1);
        }
        return s.trim();
    }

    private static void rmrf(File f) {
        try {
            if (f == null || !f.exists()) {
                return;
            }
            if (f.isDirectory()) {
                File[] cs = f.listFiles();
                if (cs != null) {
                    for (File c : cs) {
                        rmrf(c);
                    }
                }
            }
            f.delete();
        } catch (Throwable ignored) {
        }
    }

    private static String unquoteJson(String v) {
        if (v == null) {
            return "(null)";
        }
        try {
            String s = v;
            if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
                s = s.substring(1, s.length() - 1);
            }
            return s.replace("\\\"", "\"").replace("\\/", "/").replace("\\n", "\n")
                    .replace("\\t", "  ").replace("\\\\", "\\");
        } catch (Throwable t) {
            return String.valueOf(v);
        }
    }

    private static String hotDiagJs() {
        return "(function(){try{var h=window.__dshHot;var e=window.__dshHotErrors||[];"
                + "return JSON.stringify({hot:!!h,version:h?h.version:null,"
                + "native:!!(window.__DSHNative&&window.__DSHNative.call),"
                + "css:(document.getElementById('dsh-hot-css')||{}).href||null,"
                + "js:(document.getElementById('dsh-hot')||{}).src||null,"
                + "errors:e.slice(0,8),nErrors:e.length,"
                + "keeper:!!window.__dshKeeper,pager:!!window.__dshPager});"
                + "}catch(err){return JSON.stringify({err:String(err)});}})()";
    }
}
