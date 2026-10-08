window.__ModuleLoader__.load({
  id: 'dsh-mobile-kit',
  factory(require) {
    var VERSION = '0.2.1';

    // Same detection the reverse proxy uses: only touch layout on a phone-like UA.
    var MOBILE = /Android|iPhone|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent || '');

    var log = [];
    function note(message) {
      try {
        log.push(String(message));
        if (log.length > 100) log.shift();
      } catch (error) {}
    }

    /* ------------------------------------------------------------------
     * Chrome-114 polyfills. A 2020 phone WebView is missing APIs the desktop
     * UI calls unconditionally — missing Promise.withResolvers / AbortSignal.any
     * is what stops the full UI from booting at all. Additive and idempotent,
     * so they need no cleanup.
     * ------------------------------------------------------------------ */
    function installPolyfills() {
      var P = Promise;
      try {
        if (typeof P.withResolvers !== 'function') {
          P.withResolvers = function () {
            var resolve, reject;
            var promise = new P(function (res, rej) { resolve = res; reject = rej; });
            return { promise: promise, resolve: resolve, reject: reject };
          };
          note('polyfill Promise.withResolvers');
        }
      } catch (error) {}

      try {
        if (!(self.crypto && self.crypto.randomUUID)) {
          var c = self.crypto || (self.crypto = {});
          if (!c.getRandomValues) {
            c.getRandomValues = function (arr) {
              for (var i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 256);
              return arr;
            };
          }
          c.randomUUID = function () {
            var b = new Uint8Array(16);
            c.getRandomValues(b);
            b[6] = (b[6] & 15) | 64;
            b[8] = (b[8] & 63) | 128;
            var hex = [], i;
            for (i = 0; i < 16; i += 1) hex.push((b[i] + 256).toString(16).slice(1));
            return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('')
              + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
          };
        }
      } catch (error) {}

      try {
        if (typeof Object.groupBy !== 'function') {
          Object.groupBy = function (items, fn) {
            var out = Object.create(null), i = 0;
            for (var item of items) {
              var key = fn(item, i++);
              (out[key] || (out[key] = [])).push(item);
            }
            return out;
          };
        }
        if (typeof Map.groupBy !== 'function') {
          Map.groupBy = function (items, fn) {
            var map = new Map(), i = 0;
            for (var item of items) {
              var key = fn(item, i++);
              if (!map.has(key)) map.set(key, []);
              map.get(key).push(item);
            }
            return map;
          };
        }
      } catch (error) {}

      try {
        if (typeof URL.canParse !== 'function') {
          URL.canParse = function (value, base) {
            try { new URL(value, base); return true; } catch (error) { return false; }
          };
        }
        if (typeof URL.parse !== 'function') {
          URL.parse = function (value, base) {
            try { return new URL(value, base); } catch (error) { return null; }
          };
        }
      } catch (error) {}

      try {
        if (typeof Array.fromAsync !== 'function') {
          Array.fromAsync = function (iterable) {
            return Promise.resolve(iterable).then(function (value) { return Array.from(value); });
          };
        }
      } catch (error) {}

      try {
        var A = Array.prototype;
        if (!A.findLast) {
          A.findLast = function (fn, thisArg) {
            for (var i = this.length - 1; i >= 0; i -= 1) if (fn.call(thisArg, this[i], i, this)) return this[i];
            return undefined;
          };
        }
        if (!A.findLastIndex) {
          A.findLastIndex = function (fn, thisArg) {
            for (var i = this.length - 1; i >= 0; i -= 1) if (fn.call(thisArg, this[i], i, this)) return i;
            return -1;
          };
        }
        if (!A.toSorted) {
          A.toSorted = function (cmp) { return Array.prototype.slice.call(this).sort(cmp); };
        }
        if (!A.toReversed) {
          A.toReversed = function () { return Array.prototype.slice.call(this).reverse(); };
        }
      } catch (error) {}

      try {
        if (typeof structuredClone !== 'function') {
          structuredClone = function (value) { return JSON.parse(JSON.stringify(value)); };
        }
      } catch (error) {}

      try {
        var S = Set.prototype;
        if (!S.union) S.union = function (other) { var out = new Set(this); for (var v of other) out.add(v); return out; };
        if (!S.intersection) {
          S.intersection = function (other) {
            var out = new Set();
            for (var v of this) if (other.has(v)) out.add(v);
            return out;
          };
        }
        if (!S.difference) {
          S.difference = function (other) {
            var out = new Set();
            for (var v of this) if (!other.has(v)) out.add(v);
            return out;
          };
        }
      } catch (error) {}

      try {
        if (typeof AbortSignal !== 'undefined') {
          if (typeof AbortSignal.any !== 'function') {
            AbortSignal.any = function (signals) {
              var controller = new AbortController();
              var list = Array.prototype.slice.call(signals || []);
              for (var i = 0; i < list.length; i += 1) {
                (function (signal) {
                  if (signal.aborted) { controller.abort(signal.reason); return; }
                  signal.addEventListener('abort', function () { controller.abort(signal.reason); }, { once: true });
                })(list[i]);
              }
              return controller.signal;
            };
          }
          if (typeof AbortSignal.timeout !== 'function') {
            AbortSignal.timeout = function (ms) {
              var controller = new AbortController();
              setTimeout(function () {
                try { controller.abort(new DOMException('TimeoutError', 'TimeoutError')); } catch (error) { controller.abort(); }
              }, ms);
              return controller.signal;
            };
          }
        }
      } catch (error) {}
    }

    /* ------------------------------------------------------------------
     * Mobile layout fixes — the two verified on a real 360x780 phone viewport.
     * The wider adaptation set (grid/drawer/composer widths) still lives in
     * proxy/ and can be ported the same way. Scoped to <=820px so a desktop
     * browser is untouched.
     * ------------------------------------------------------------------ */
    var CSS = [
      '@media (max-width:820px){',
      // (a) a full-width overlay panel positions at x=0 (left:0 resolves against
      //     the padding box), so it slides under the 56px icon rail.
      '  [class$="_panel"]{left:56px !important;right:0 !important;box-sizing:border-box !important}',
      // (b) page headers: the primary action wrapped onto two lines at 360px.
      '  [class*="pageHead"]{gap:8px !important}',
      '  [class*="pageHead"] [class*="toolbar"]{flex-wrap:nowrap !important;min-width:0 !important}',
      '  [class*="pageHead"] [class*="toolbar"] button{white-space:nowrap !important;flex:0 0 auto !important}',
      '  [class*="pageTitle"],[class*="pageIntro"]{min-width:0 !important}',
      '}',
      'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}',
      'body{overscroll-behavior-y:none}',
    ].join('\n');

    /** Register the stylesheet through ctx.effect when available so disabling the
     *  plugin removes it again; fall back to a plain injection otherwise. */
    function installStyles(ctx) {
      function add() {
        var el = document.createElement('style');
        el.id = 'dsh-mobile-kit-css';
        el.textContent = CSS;
        (document.head || document.documentElement).appendChild(el);
        return function () {
          try { if (el.parentNode) el.parentNode.removeChild(el); } catch (error) {}
        };
      }
      if (document.getElementById('dsh-mobile-kit-css')) return;
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(add);
        return;
      }
      add();
    }

    return {
      name: 'mobile-kit',
      inject: [],
      apply(ctx) {
        try {
          installPolyfills();
          if (MOBILE) installStyles(ctx);
          window.__dshMobileKit = {
            version: VERSION,
            mobile: MOBILE,
            log: function () { return log.slice(); },
            state: function () {
              return {
                version: VERSION,
                mobile: MOBILE,
                withResolvers: typeof Promise.withResolvers,
                abortAny: typeof (typeof AbortSignal !== 'undefined' ? AbortSignal.any : undefined),
                css: !!document.getElementById('dsh-mobile-kit-css'),
                notes: log.slice(-10),
              };
            },
          };
          note('applied' + (MOBILE ? ' (mobile)' : ' (desktop)'));
        } catch (error) {
          try { console.error('mobile-kit client half failed', error) } catch (ignored) {}
        }
      },
    };
  },
});
