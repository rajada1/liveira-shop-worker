/* Binance egress proxy (see wrangler.toml). Forwards an allow-listed set of GET paths to Binance, unchanged.
 * Uses the official alternate endpoint api-gcp.binance.com: api.binance.com / api1-4 answer 403/451 to Cloudflare
 * egress IPs (they geolocate as US) even from Tokyo, while api-gcp accepts them from a non-US data center.
 * GET /__egress → { colo, loc, binanceTime } (diagnostics, no secrets). */
const API = "https://api-gcp.binance.com";
const ALLOW = new Set(["/sapi/v1/pay/transactions", "/sapi/v1/account/apiRestrictions", "/api/v3/time"]);

async function where() {
  try {
    const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    const m = (k) => (t.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1] || null;
    return { colo: m("colo"), loc: m("loc") };
  } catch {
    return { colo: null, loc: null };
  }
}

export default {
  async fetch(request) {
    const u = new URL(request.url);
    if (request.method === "GET" && u.pathname === "/__egress") {
      const out = { ...(await where()), api: API };
      try {
        out.binanceTime = (await fetch(API + "/api/v3/time")).status;
      } catch {
        out.binanceTime = "error";
      }
      return Response.json(out);
    }
    if (request.method !== "GET" || !ALLOW.has(u.pathname)) return new Response("not found", { status: 404 });
    const key = request.headers.get("X-MBX-APIKEY");
    let res;
    try {
      res = await fetch(API + u.pathname + u.search, { headers: key ? { "X-MBX-APIKEY": key } : {} });
    } catch (err) {
      return Response.json({ code: -1, msg: "egress fetch failed" }, { status: 502 });
    }
    const h = new Headers({ "content-type": res.headers.get("content-type") || "application/json" });
    for (const k of ["retry-after", "x-mbx-used-weight", "x-mbx-used-weight-1m"]) if (res.headers.get(k)) h.set(k, res.headers.get(k));
    return new Response(res.body, { status: res.status, headers: h });
  },
};
