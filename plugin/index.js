/**
 * Host half of dsh-mobile-kit (bundle + UI plugin, dual-face package).
 *
 * Registers two tiny read-only JSON routes for mobile shells:
 *   GET /mobile-kit/health   liveness, for probes and connection keepers
 *   GET /mobile-kit/info     this host's non-internal IPv4 addresses, so an
 *                            Android shell can discover LAN candidates instead
 *                            of hardcoding a subnet (that is what the LAN/VPN
 *                            dual-mode switcher needs)
 *
 * Two rules from the plugin docs shape this file:
 *   · `ctx.webServer` has NO built-in authentication, so a plugin route is
 *     reachable by anyone who can reach the port. `/info` therefore answers
 *     only loopback/Tailscale/private peers and refuses everything else.
 *   · A host plugin is `export function apply(ctx, config)` with optional
 *     `export const inject`; resources are registered inside `apply` through
 *     `ctx.effect` (which owns their cleanup). Never throw out of `apply`:
 *     host code runs in-process and would take the composition down with it.
 */
export const name = 'mobile-kit'
export const inject = ['webServer']

const VERSION = '0.2.0'
const BASE = '/mobile-kit'

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  } catch (error) {
    try {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('mobile-kit: response failed')
    } catch (ignored) {}
  }
}

/** Loopback, private LAN, or Tailscale CGNAT (100.64.0.0/10). */
function peerIsLocal(req) {
  try {
    let address = req && req.socket ? req.socket.remoteAddress : ''
    if (typeof address !== 'string' || address.length === 0) return false
    if (address.startsWith('::ffff:')) address = address.slice(7)
    if (address === '127.0.0.1' || address === '::1') return true
    if (address.startsWith('192.168.') || address.startsWith('10.')) return true
    if (address.startsWith('100.')) {
      const second = Number(address.split('.')[1])
      return second >= 64 && second <= 127
    }
    if (address.startsWith('172.')) {
      const second = Number(address.split('.')[1])
      return second >= 16 && second <= 31
    }
    return false
  } catch (error) {
    return false
  }
}

async function localAddresses() {
  const out = []
  try {
    const os = await import('node:os')
    const interfaces = os.networkInterfaces()
    for (const key of Object.keys(interfaces)) {
      for (const entry of interfaces[key] || []) {
        if (entry && entry.family === 'IPv4' && entry.internal !== true) {
          out.push({ iface: key, address: entry.address })
        }
      }
    }
  } catch (error) {
    return out
  }
  return out
}

export function apply(ctx) {
  try {
    const webServer = ctx && ctx.webServer !== undefined && ctx.webServer !== null
      ? ctx.webServer
      : (ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      console.log('mobile-kit: loaded without a webServer; routes not registered')
      return
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: BASE + '/health',
      handler: (req, res) => sendJson(res, 200, { ok: true, name: name, version: VERSION, ts: Date.now() }),
    }))

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: BASE + '/info',
      handler: async (req, res) => {
        if (!peerIsLocal(req)) {
          sendJson(res, 403, { ok: false, error: 'local-peers-only' })
          return
        }
        const addresses = await localAddresses()
        sendJson(res, 200, {
          name: name,
          version: VERSION,
          platform: process.platform,
          node: process.versions && process.versions.node ? process.versions.node : null,
          addresses: addresses,
          note: 'Candidate addresses for LAN/VPN switching. Probe <address>:<port>/mobile-kit/health.',
        })
      },
    }))

    console.log('mobile-kit: host half active v' + VERSION + ' on ' + BASE + '/{health,info}')
  } catch (error) {
    try { console.error('mobile-kit: host half failed', error) } catch (ignored) {}
  }
}
