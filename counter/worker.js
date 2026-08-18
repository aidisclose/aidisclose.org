// aidisclose global counter — Cloudflare Worker
//
// GET  /  -> { "count": <n> }            (read-only, never increments)
// POST /  -> { "count": <n+1> }          (increment, returns new total)
//
// Storage: a single KV key "count" in the bound namespace `AID_COUNTER`.
// Abuse mitigation: POST is restricted to the site's own origins, plus a
// per-IP rate limit (one increment per IP per RATE_WINDOW seconds).
//
// Known limitation: KV is eventually consistent and this read-then-write is
// not atomic, so simultaneous increments can collapse into one and the total
// can briefly appear to stall. That is acceptable for a vanity counter; if the
// number ever needs to be exact, move the state into a Durable Object.

const ALLOWED_ORIGINS = [
  "https://aidisclose.org",
  "https://www.aidisclose.org",
  // add "http://localhost:8080" etc. while testing locally
];

const RATE_WINDOW = 60; // seconds between counted increments per IP

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, origin, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// The rate-limit key is derived from the IP rather than being the IP itself:
// the counter has no need to hold visitor addresses, even for 60 seconds. A
// truncated SHA-256 of an IPv4 address is still brute-forceable, so this is
// data minimisation rather than true anonymisation; add a secret salt (via
// `wrangler secret put`) if that distinction ever matters here.
async function ipKey(ip) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ip:${hex.slice(0, 32)}`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const kv = env.AID_COUNTER;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === "GET") {
      // cacheTtl lets edge reads serve from cache instead of spending a KV read.
      const current = parseInt((await kv.get("count", { cacheTtl: 60 })) || "0", 10) || 0;
      return json({ count: current }, origin);
    }

    if (request.method === "POST") {
      // Reject unknown origins *before* touching KV. Relying on the CORS
      // response header alone only hid the reply from the caller: the write had
      // already happened, so any site or curl could inflate the total.
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return json({ error: "origin not allowed" }, origin, 403);
      }

      // Per-IP rate limit: skip the increment if this IP bumped recently.
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const key = await ipKey(ip);
      const current = parseInt((await kv.get("count")) || "0", 10) || 0;
      if (await kv.get(key)) {
        return json({ count: current, throttled: true }, origin);
      }
      const next = current + 1;
      await kv.put("count", String(next));
      await kv.put(key, "1", { expirationTtl: RATE_WINDOW });
      return json({ count: next }, origin);
    }

    return json({ error: "method not allowed" }, origin, 405);
  },
};
