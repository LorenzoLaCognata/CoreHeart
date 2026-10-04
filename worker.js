// Cloudflare Worker — proxies Claude calls and verifies the Supabase
// connection, keeping all secrets server-side.
//
// Routes:
//   GET /         tablet-facing suggestion. Fails SOFT on purpose (always
//                 returns 200 with friendly text) so the tablet never
//                 shows a blank screen. Cached 5 minutes.
//   GET /health   diagnostic check of Claude + Supabase. Fails LOUD on
//                 purpose (real status codes, real error messages) and is
//                 never cached, so you can actually tell what's broken.
//
// Deploy: wrangler deploy
// Secrets: wrangler secret put ANTHROPIC_API_KEY / HUB_SECRET /
//          SUPABASE_SERVICE_KEY / SUPABASE_URL

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(allowedOrigin) });
    }

    // Rate limit first, before even checking the secret — applies to
    // every route below, /health included.
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success: withinLimit } = await env.RATE_LIMITER.limit({ key: clientIP });
    if (!withinLimit) {
      return jsonResponse({ error: true, message: "Rate limited — too many requests." }, 429, allowedOrigin);
    }

    // Shared-secret check — same header the tablet sends, works for curl too.
    if (request.headers.get("X-Hub-Secret") !== env.HUB_SECRET) {
      return jsonResponse(
        { error: true, message: "Unauthorized — check the X-Hub-Secret header." },
        401,
        allowedOrigin
      );
    }

    if (url.pathname === "/health") {
      return jsonResponse(await runHealthCheck(env), 200, allowedOrigin);
    }

    return handleSuggestion(request, env, allowedOrigin);
  },
};

async function handleSuggestion(request, env, allowedOrigin) {
  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Pull the current item pool. If Supabase is unreachable, degrade to the
  // old generic suggestion rather than breaking the tablet over a DB hiccup.
  let items = [];
  try {
    // Pool of 5 (close to the 3-4 we'll ask Claude to pick) rather than the
    // whole inventory — the tighter the pool, the less room Claude has to
    // fall back on its "obvious favorite" items every call, so the set
    // actually rotates refresh to refresh.
    items = shuffleAndSample(await fetchActiveItems(env), 5);
  } catch (err) {
    items = [];
  }

  const prompt = buildSuggestionPrompt(items);

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      // Claude API itself returned an error (bad key, overloaded, etc.) —
      // surface the real reason instead of a generic fallback.
      return jsonResponse(
        { error: true, message: `Claude API error (${anthropicRes.status}): ${data?.error?.message || "unknown"}` },
        200,
        allowedOrigin
      );
    }

    const rawText = data?.content?.find((c) => c.type === "text")?.text?.trim();
    if (!rawText) {
      return jsonResponse({ error: true, message: "Claude responded with no text content." }, 200, allowedOrigin);
    }

    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(rawText));
    } catch (err) {
      return jsonResponse(
        { error: true, message: `Couldn't parse Claude's response as JSON: ${rawText.slice(0, 150)}` },
        200,
        allowedOrigin
      );
    }

    const response = new Response(
      JSON.stringify({ intro: parsed.intro || "", items: Array.isArray(parsed.items) ? parsed.items : [] }),
      {
        headers: {
          "content-type": "application/json",
          "Cache-Control": "max-age=300",
          ...corsHeaders(allowedOrigin),
        },
      }
    );
    await cache.put(cacheKey, response.clone());
    return response;
  } catch (err) {
    // Network-level failure reaching Claude at all (DNS, timeout, etc.) —
    // still shown on the tablet now, not hidden.
    return jsonResponse({ error: true, message: `Couldn't reach Claude: ${err.message}` }, 200, allowedOrigin);
  }
}

async function fetchActiveItems(env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/items?select=name,category&status=eq.active&limit=50`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error(`Supabase items fetch failed: ${res.status}`);
  return res.json(); // [{ name, category }, ...]
}

// Random subset, not the whole list — with the full list, an obviously
// dominant seasonal match (pumpkin in fall) wins almost every call
// regardless of sampling temperature, since the ranking task itself has
// one clear answer. Narrowing which items are even "in the running" each
// time is what actually produces variety across refreshes.
function shuffleAndSample(items, n) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

// Season/time computed for Minneapolis specifically (America/Chicago),
// not wherever the Worker happens to execute — that's the whole point of
// a "consistent with the time of day" suggestion.
function getSeasonAndTime() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    hour12: false,
    month: "numeric",
    weekday: "long",
  }).formatToParts(new Date());

  const hour = Number(parts.find((p) => p.type === "hour").value);
  const month = Number(parts.find((p) => p.type === "month").value);
  const weekday = parts.find((p) => p.type === "weekday").value;

  const season =
    month === 12 || month <= 2 ? "winter" : month <= 5 ? "spring" : month <= 8 ? "summer" : "fall";

  return { hour, season, weekday };
}

function buildSuggestionPrompt(items) {
  const { hour, season, weekday } = getSeasonAndTime();
  const context = `It's currently ${hour}:00 on a ${weekday} in ${season} (Minneapolis, US).`;

  if (items.length === 0) {
    return (
      `${context} Respond ONLY with valid JSON, no markdown code fences, no preamble, in exactly ` +
      `this shape: {"intro": "<one short warm sentence about today>", "items": []}.`
    );
  }

  const itemsList = items.map((i) => `${i.name} (${i.category})`).join(", ");
  return (
    `${context} Item names below are in Italian, from a household inventory: ${itemsList}. ` +
    `Pick 3 to 4 items from this list that best fit buying or getting right now, given the season ` +
    `and time of day (e.g. a warm drink in the morning, a seasonal ingredient in the right season). ` +
    `Respond ONLY with valid JSON, no markdown code fences, no preamble, in exactly this shape: ` +
    `{"intro": "<one short warm sentence about the season/time, ending by asking if they'd like to ` +
    `add any of these to the shopping list>", "items": ["ItemName1", "ItemName2", "ItemName3"]}. ` +
    `Item names in the "items" array must be copied exactly as given, in Italian.`
  );
}

function stripJsonFences(text) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

async function runHealthCheck(env) {
  const result = { timestamp: new Date().toISOString(), claude: null, supabase: null };

  // Claude check: a real, minimal call — proves the key works and the
  // account can actually reach the API, not just that a key is set.
  try {
    const start = Date.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
      }),
    });
    const data = await res.json();
    const text = data?.content?.find((c) => c.type === "text")?.text?.trim();
    result.claude = res.ok
      ? { ok: true, response: text, latency_ms: Date.now() - start }
      : { ok: false, status: res.status, error: data?.error?.message || "unknown error" };
  } catch (err) {
    result.claude = { ok: false, error: err.message };
  }

  // Supabase check: a trivial read against the `items` table. 0 rows back
  // is a PASS — it proves the URL, key, and schema all work. A 401 means
  // the service key or URL is wrong; a relation-does-not-exist error means
  // supabase-schema.sql hasn't been run yet.
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/items?select=id&limit=1`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    });
    if (res.ok) {
      const rows = await res.json();
      result.supabase = { ok: true, reachable: true, sample_row_count: rows.length };
    } else {
      const errText = await res.text();
      result.supabase = { ok: false, status: res.status, error: errText };
    }
  } catch (err) {
    result.supabase = { ok: false, error: err.message };
  }

  return result;
}

function jsonResponse(body, status, allowedOrigin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(allowedOrigin) },
  });
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, X-Hub-Secret",
  };
}
