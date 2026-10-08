// Cloudflare Worker — proxies Claude calls and verifies the Supabase
// connection, keeping all secrets server-side.
//
// Routes:
//   GET /         tablet-facing suggestion. Fails SOFT on purpose (always
//                 returns 200 with friendly text) so the tablet never
//                 shows a blank screen. Cached 5 minutes.
//   GET /eat-out  two dinner ideas picked by Claude with web search. Kept in memory for
//                 12 hours; ?fresh=1 forces new picks (at most once every 10 minutes).
//   GET /events        next 14 days from Google Calendar (read).
//   POST /events/quick {text} adds an event with Google's natural-language quick add
//                 ("Dinner with Anna Friday 7pm").
//   GET /meals    recent meals (with days since), meals not had in a while, dinner plan.
//   POST /meals {name, plan_id?}   log a meal eaten at home.
//   POST /meal-plan {date, name}   plan a dinner;  POST /meal-plan/remove {id}.
//   POST /receipt {image: base64 JPEG}   Claude reads a grocery receipt photo: products, receipt lines, and pantry stock with expiry dates.
//   GET /stock    what is in the house, soonest-to-expire first;  POST /stock/used {id | name}   mark something used up.
//   POST /meal-idea {name}   save a meal idea (suggested until you cook it);  POST /meals/remove {id}   undo a logged meal.
//   GET /cards    the tablet's heads-up feed (core_card). Refreshed from the database at most
//                 every 3 hours when asked, and by a cron trigger if you add one (optional).
//   POST /cards/refresh   force a refresh now.
//   POST /events/parse {text}    Claude turns a spoken calendar command into a proposed change (add/move/rename/delete); nothing is changed yet.
//   POST /events/update {id, title?, start?, shift_minutes?}   POST /events/delete {id}
//   POST /transcribe   (body: WAV audio) speech to text with Cloudflare Workers AI (Whisper).
//                 Needs a Workers AI binding named AI on this Worker.
//   GET /health   diagnostic check of Claude + Supabase. Fails LOUD on
//                 purpose (real status codes, real error messages) and is
//                 never cached, so you can actually tell what's broken.
//
// Deploy: wrangler deploy
// Secrets: wrangler secret put ANTHROPIC_API_KEY / HUB_SECRET /
//          SUPABASE_SERVICE_KEY / SUPABASE_URL
//          GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
//          (optional) GOOGLE_CALENDAR_ID — defaults to the primary calendar

export default {
  // Optional: add a Cron Trigger (e.g. hourly) in Cloudflare to keep cards fresh without the tablet asking.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshCards(env).catch((e) => console.error("cards:", e.message)));
  },

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

    if (url.pathname === "/eat-out") {
      return handleEatOut(request, env, allowedOrigin);
    }

    if (url.pathname === "/events" && request.method === "GET") return handleEvents(env, allowedOrigin);
    if (url.pathname === "/events/quick" && request.method === "POST") return handleQuickAdd(request, env, allowedOrigin);
    if (request.method === "POST" && ["/events/parse", "/events/update", "/events/delete"].includes(url.pathname)) return handleEventEdit(url.pathname, request, env, allowedOrigin);
    if (url.pathname === "/transcribe" && request.method === "POST") return handleTranscribe(request, env, allowedOrigin);
    if (url.pathname === "/stock" && request.method === "GET") return handleStock(env, allowedOrigin);
    if (url.pathname === "/stock/used" && request.method === "POST") return handleStockUsed(request, env, allowedOrigin);
    if (url.pathname === "/receipt" && request.method === "POST") return handleReceipt(request, env, allowedOrigin);
    if (url.pathname === "/meals" && request.method === "GET") return handleMeals(env, allowedOrigin);
    if (request.method === "POST" && ["/meals", "/meals/remove", "/meal-plan", "/meal-plan/remove", "/meal-idea"].includes(url.pathname)) return handleMealWrite(url.pathname, request, env, allowedOrigin);
    if (url.pathname === "/cards" && request.method === "GET") return handleCards(env, allowedOrigin, false);
    if (url.pathname === "/cards/refresh" && request.method === "POST") return handleCards(env, allowedOrigin, true);

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

// ---- Database helpers, meals and the heads-up cards ----
const HOME_TZ = "America/Chicago";   // the household's time zone, for "today" and "days since"
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: HOME_TZ });
const daysBetween = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 864e5);

const dbHint = (msg) => /PGRST|42P01|does not exist|Could not find|schema cache/i.test(msg) ? `The database tables aren't set up yet: run schema.sql in the Supabase SQL Editor. (${msg})`
  : /401|403|Invalid API key|JWT/i.test(msg) ? `Supabase refused the key: check that SUPABASE_SERVICE_KEY is the service_role key. (${msg})`
  : /Invalid URL|fetch failed|must be set/i.test(msg) ? `Check the SUPABASE_URL and SUPABASE_SERVICE_KEY secrets on the Worker. (${msg})` : msg;

async function sb(env, path, { method = "GET", body, prefer } = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set as Worker secrets.");
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, "content-type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Database error ${res.status}: ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

// Recent meals, meals not had for a week or more (but not in the last 60 days), and the dinner plan.
async function loadMealData(env) {
  const today = todayStr();
  const [recent, all, plan, recipes] = await Promise.all([
    sb(env, "food_meal?select=id,name,eaten_on&order=eaten_on.desc&limit=8"),
    sb(env, "v_meal_gaps?select=name,last_eaten_on,times_eaten&limit=200"),
    sb(env, `food_meal_plan?select=id,planned_for,name,status&status=eq.planned&planned_for=gte.${today}&order=planned_for.asc&limit=14`),
    sb(env, "food_recipe?select=id,name&limit=100"),
  ]);
  const planned = new Set(plan.map((p) => p.name.toLowerCase())), eaten = new Set(all.map((g) => g.name.toLowerCase()));
  const stale = all.map((g) => ({ name: g.name, days_since: daysBetween(today, g.last_eaten_on), times: g.times_eaten }))
    .filter((g) => g.days_since >= 7 && g.days_since <= 60 && !planned.has(g.name.toLowerCase())).sort((a, b) => b.days_since - a.days_since);
  const ideas = recipes.filter((r) => !eaten.has(r.name.toLowerCase()) && !planned.has(r.name.toLowerCase())).map((r) => ({ name: r.name, days_since: null, idea: true }));
  return { recent: recent.map((m) => ({ ...m, days_since: daysBetween(today, m.eaten_on) })), gaps: [...stale, ...ideas].slice(0, 8), plan };
}
async function handleMeals(env, allowedOrigin) {
  try { return jsonResponse(await loadMealData(env), 200, allowedOrigin); }
  catch (err) { return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin); }
}

async function handleMealWrite(path, request, env, allowedOrigin) {
  try {
    const b = await request.json();
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || ""), isId = (s) => /^[0-9a-f-]{36}$/i.test(s || "");
    const name = String(b.name || "").trim().slice(0, 80);
    if (path === "/meal-plan/remove") {
      if (!isId(b.id)) throw new Error("Bad id.");
      await sb(env, `food_meal_plan?id=eq.${b.id}`, { method: "PATCH", body: { status: "skipped" } });
    } else if (path === "/meal-plan") {
      if (!name || !isDate(b.date)) throw new Error("Need a meal name and a date.");
      await sb(env, "food_meal_plan?on_conflict=planned_for", { method: "POST", prefer: "resolution=merge-duplicates",
        body: { planned_for: b.date, name, status: "planned" } });
    } else if (path === "/meal-idea") {
      if (!name) throw new Error("Need a meal name.");
      const have = await sb(env, "food_recipe?select=name&limit=200");
      if (!have.some((r) => r.name.toLowerCase() === name.toLowerCase())) await sb(env, "food_recipe", { method: "POST", body: { name } });
    } else if (path === "/meals/remove") {
      if (!isId(b.id)) throw new Error("Bad id.");
      await sb(env, `food_meal?id=eq.${b.id}`, { method: "DELETE" });
    } else {
      if (!name) throw new Error("Need a meal name.");
      let date = isDate(b.eaten_on) ? b.eaten_on : todayStr(); if (date > todayStr()) date = todayStr();
      await sb(env, "food_meal", { method: "POST", body: { name, eaten_on: date } });
      // Close the matching plan: the one the tablet pointed at, or that day's plan if the name matches.
      if (isId(b.plan_id)) await sb(env, `food_meal_plan?id=eq.${b.plan_id}`, { method: "PATCH", body: { status: "cooked" } });
      else {
        const p = await sb(env, `food_meal_plan?select=id,name&planned_for=eq.${date}&status=eq.planned`);
        if (p[0] && p[0].name.toLowerCase() === name.toLowerCase()) await sb(env, `food_meal_plan?id=eq.${p[0].id}`, { method: "PATCH", body: { status: "cooked" } });
      }
    }
    lastCards = 0;   // so the heads-up cards pick the change up soon
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin);
  }
}

// Card refresh: turn the database's "worth your attention" feed into rows the tablet can read.
let lastCards = 0;
const MANAGED_KINDS = ["reminder", "stock", "item", "meal_gap", "meal_plan"];
async function refreshCards(env) {
  const started = new Date().toISOString(), today = todayStr();
  const ICON = { core: "🔔", food: "🥬", home: "🏠" };
  const rows = await sb(env, "v_heads_up?select=*");
  const cards = rows.filter((r) => !(r.source === "stock" && daysBetween(r.due_on, today) < -3)).map((r) => {
    const d = daysBetween(r.due_on, today);
    return { domain: r.domain, kind: r.source, dedupe_key: r.ref_id, headline: r.title, icon: ICON[r.domain] || "🔔", refreshed_at: started,
      body: d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "Today" : d === 1 ? "Tomorrow" : `In ${d} days`, priority: d < 0 ? 90 : d <= 7 ? 70 : 50 };
  });
  const meals = await loadMealData(env);
  meals.plan.filter((p) => p.planned_for === today).forEach((p) =>
    cards.push({ domain: "food", kind: "meal_plan", dedupe_key: p.id, headline: `Tonight: ${p.name}`, body: "On the dinner plan", icon: "🍽️", priority: 80, refreshed_at: started }));
  meals.gaps.filter((g) => !g.idea).slice(0, 2).forEach((g) =>
    cards.push({ domain: "food", kind: "meal_gap", dedupe_key: g.name.toLowerCase(), headline: `${g.name}: not had in ${g.days_since} days`, body: "Plan it this week?", icon: "🍽️", priority: 40, refreshed_at: started }));
  if (cards.length) await sb(env, "core_card?on_conflict=kind,dedupe_key", { method: "POST", prefer: "resolution=merge-duplicates", body: cards });
  await sb(env, `core_card?kind=in.(${MANAGED_KINDS.join(",")})&refreshed_at=lt.${encodeURIComponent(started)}`, { method: "DELETE" });
  lastCards = Date.now();
}
async function handleCards(env, allowedOrigin, force) {
  try {
    if (force || Date.now() - lastCards > 3 * 3600e3) await refreshCards(env);
    const now = encodeURIComponent(new Date().toISOString());
    const cards = await sb(env, `core_card?select=id,domain,kind,headline,body,icon,priority&or=(expires_at.is.null,expires_at.gt.${now})&order=priority.desc&limit=8`);
    return jsonResponse({ cards }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin);
  }
}

// ---- Pantry: a receipt photo becomes products, receipt lines and stock with expiry dates ----
const RECEIPT_MODEL = "claude-sonnet-5-5";      // reads receipts well; "claude-haiku-4-5-20251001" is cheaper but misreads more
const FOOD_CATS = ["Produce", "Dairy & eggs", "Meat & fish", "Bakery", "Pantry", "Frozen", "Drinks", "Household"];

async function handleReceipt(request, env, allowedOrigin) {
  try {
    const img = String((await request.json()).image || "");
    if (!/^[A-Za-z0-9+/=]+$/.test(img) || img.length < 1000 || img.length > 6_000_000) throw new Error("The photo was missing or too large.");
    const [products, cats] = await Promise.all([sb(env, "food_product?select=id,name,category_id,shelf_life_days&limit=1000"), sb(env, "food_category?select=id,name_en&limit=100")]);
    const today = todayStr();
    const prompt = `This is a photo of a grocery receipt. Read it and reply with ONLY this JSON, no markdown:
{"store":"store name","purchased_on":"YYYY-MM-DD or empty","total":number or null,"items":[{"raw":"the line as printed","name":"clear product name in English, singular, no brand, e.g. Chicken breast","qty":number,"line_total":number,"category":"one of: ${FOOD_CATS.join(", ")}","is_food":true or false,"shelf_life_days":integer}]}
shelf_life_days is how many days the product stays good after purchase when stored normally: leafy greens 4, most fresh produce 7, milk 8, yogurt 14, eggs 28, fresh meat or fish 2, bread 4, hard cheese 30, frozen food 90, canned or dry goods 365. Skip tax, totals, discounts, bag fees and payment lines.
If a product matches one of these existing names, use exactly that name: ${products.slice(0, 200).map((p) => p.name).join("; ")}.
Today is ${today}. If the image is not a receipt or is unreadable, reply {"error":"short reason"}.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: RECEIPT_MODEL, max_tokens: 3500, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } }, { type: "text", text: prompt }] }] }) });
    const data = await res.json();
    if (!res.ok) throw new Error(`Claude API error (${res.status}): ${data?.error?.message || "unknown"}`);
    const m = (data.content || []).map((c) => c.text || "").join("").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("I couldn't read that receipt.");
    const r = JSON.parse(m[0]);
    if (r.error) throw new Error("I couldn't read that receipt: " + String(r.error).slice(0, 120));
    const items = (Array.isArray(r.items) ? r.items : []).slice(0, 60).map((i) => ({
      raw: String(i.raw || i.name || "").slice(0, 120), name: String(i.name || "").trim().slice(0, 80), qty: Math.max(0.001, Number(i.qty) || 1), line_total: Number(i.line_total) || 0,
      category: FOOD_CATS.includes(i.category) ? i.category : "Pantry", is_food: i.is_food !== false && i.category !== "Household", shelf: Math.min(730, Math.max(1, Math.round(Number(i.shelf_life_days) || 7))) })).filter((i) => i.name);
    if (!items.length) throw new Error("I couldn't find any items. Lay the whole receipt flat in good light and try again.");
    const when = /^\d{4}-\d{2}-\d{2}$/.test(r.purchased_on || "") && r.purchased_on <= today ? r.purchased_on : today;
    const total = Number(r.total) > 0 ? Number(r.total) : Math.round(items.reduce((a, i) => a + i.line_total, 0) * 100) / 100;
    const store = String(r.store || "").trim().slice(0, 80);

    // the same receipt scanned twice should not double the pantry
    const dupe = await sb(env, `food_receipt?select=id&purchased_at=eq.${encodeURIComponent(when + "T12:00:00Z")}&total=eq.${total}&limit=1`);
    if (dupe.length) return jsonResponse({ ok: true, duplicate: true, store }, 200, allowedOrigin);

    let storeId = null;
    if (store) {
      const places = await sb(env, "core_place?select=id,name&kind=eq.store&limit=200");
      let p = places.find((x) => x.name.toLowerCase() === store.toLowerCase());
      if (!p) [p] = await sb(env, "core_place", { method: "POST", prefer: "return=representation", body: { name: store, kind: "store" } });
      storeId = p.id;
    }
    const byName = new Map(products.map((p) => [p.name.toLowerCase(), p])), catId = new Map(cats.map((c) => [String(c.name_en || "").toLowerCase(), c.id])), fresh = [];
    for (const i of items) if (!byName.has(i.name.toLowerCase()) && !fresh.some((f) => f.name.toLowerCase() === i.name.toLowerCase()))
      fresh.push({ name: i.name, name_en: i.name, category_id: catId.get(i.category.toLowerCase()) || null, shelf_life_days: i.is_food ? i.shelf : null });
    if (fresh.length) (await sb(env, "food_product", { method: "POST", prefer: "return=representation", body: fresh })).forEach((p) => byName.set(p.name.toLowerCase(), p));
    const filled = new Set();      // products you made yourself may lack a category or shelf life: fill the gaps, never overwrite
    for (const i of items) { const p = products.find((x) => x.name.toLowerCase() === i.name.toLowerCase()); if (!p || filled.has(p.id)) continue;
      const patch = {}; if (p.shelf_life_days == null && i.is_food) patch.shelf_life_days = i.shelf; if (p.category_id == null && catId.get(i.category.toLowerCase())) patch.category_id = catId.get(i.category.toLowerCase());
      if (Object.keys(patch).length) { filled.add(p.id); await sb(env, `food_product?id=eq.${p.id}`, { method: "PATCH", body: patch }); p.shelf_life_days = patch.shelf_life_days ?? p.shelf_life_days; } }
    const [receipt] = await sb(env, "food_receipt", { method: "POST", prefer: "return=representation", body: { store_id: storeId, purchased_at: when + "T12:00:00Z", total } });
    await sb(env, "food_receipt_line", { method: "POST", body: items.map((i) => ({ receipt_id: receipt.id, product_id: byName.get(i.name.toLowerCase()).id, raw_text: i.raw || i.name, qty: i.qty, line_total: i.line_total })) });
    const stock = items.filter((i) => i.is_food).map((i) => { const p = byName.get(i.name.toLowerCase()); return { product_id: p.id, qty: i.qty, purchased_on: when, expires_on: addDay(when, p.shelf_life_days || i.shelf) }; });
    if (stock.length) await sb(env, "food_stock", { method: "POST", body: stock });
    lastCards = 0;
    return jsonResponse({ ok: true, store, total, added: items.length, stocked: stock.length, soon: stock.filter((s) => daysBetween(s.expires_on, today) <= 7).length }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin);
  }
}

// What is in the house, soonest to expire first. Anything more than 3 days past its date is assumed gone.
async function loadStock(env) {
  const rows = await sb(env, "food_stock?select=id,product_id,qty,expires_on&status=eq.in_stock&order=expires_on.asc&limit=150");
  const ids = [...new Set(rows.map((r) => r.product_id))], today = todayStr();
  const prods = ids.length ? await sb(env, `food_product?select=id,name&id=in.(${ids.join(",")})`) : [];
  const name = new Map(prods.map((p) => [p.id, p.name]));
  return rows.map((r) => ({ id: r.id, name: name.get(r.product_id) || "Item", qty: r.qty, expires_on: r.expires_on, days_left: r.expires_on ? daysBetween(r.expires_on, today) : null }))
    .filter((r) => r.days_left === null || r.days_left >= -3);
}
async function handleStock(env, allowedOrigin) {
  try { return jsonResponse({ items: await loadStock(env) }, 200, allowedOrigin); }
  catch (err) { return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin); }
}
async function handleStockUsed(request, env, allowedOrigin) {
  try {
    const b = await request.json(), items = await loadStock(env);
    let item = null;
    if (/^[0-9a-f-]{36}$/i.test(b.id || "")) item = items.find((i) => i.id === b.id);
    else {      // by name, spoken: soonest-expiring item whose name contains (or is contained in) what was said
      const n = String(b.name || "").toLowerCase().trim().replace(/s$/, "");
      if (n) item = items.find((i) => { const x = i.name.toLowerCase(); return x.includes(n) || n.includes(x.replace(/s$/, "")); });
    }
    if (!item) throw new Error(`I couldn't find “${String(b.name || "that").slice(0, 40)}” in the pantry.`);
    await sb(env, `food_stock?id=eq.${item.id}`, { method: "PATCH", body: { status: "used" } });
    lastCards = 0;
    return jsonResponse({ ok: true, matched: item.name }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin);
  }
}

// ---- Voice input without the browser's speech service: the tablet records, this Worker transcribes ----
function toBase64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
async function handleTranscribe(request, env, allowedOrigin) {
  try {
    if (!env.AI) throw new Error("Cloud voice isn't set up yet: add a Workers AI binding named AI to this Worker.");
    const audio = await request.arrayBuffer();
    if (!audio.byteLength || audio.byteLength > 2_000_000) throw new Error("The recording was empty or too long.");
    const q = new URL(request.url).searchParams, lang = /^[a-z]{2}$/.test(q.get("lang") || "") ? q.get("lang") : "en", hint = (q.get("hint") || "").slice(0, 400);
    const bytes = new Uint8Array(audio);
    let text;
    try {   // the larger Whisper model, told the language and the words to expect (meal names, event titles): much better with accents
      const out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: toBase64(bytes), language: lang, ...(hint ? { initial_prompt: hint } : {}) });
      text = out.text;
    } catch (e) {   // fall back to the smaller model if the larger one isn't available
      const out = await env.AI.run("@cf/openai/whisper", { audio: [...bytes] });
      text = out.text;
    }
    return jsonResponse({ text: String(text || "").trim() }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: err.message }, 200, allowedOrigin);
  }
}

// ---- Google Calendar: the OAuth refresh token lives in Worker secrets ----
let gTok = { value: "", exp: 0 };
async function googleToken(env) {
  if (gTok.value && Date.now() < gTok.exp) return gTok.value;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error}`);
  gTok = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return gTok.value;
}
const calId = (env) => encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary");

async function handleEvents(env, allowedOrigin) {
  try {
    const tok = await googleToken(env);
    const now = new Date();
    const q = new URLSearchParams({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 14 * 864e5).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "20" });
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId(env)}/events?${q}`, { headers: { Authorization: `Bearer ${tok}` } });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || res.status);
    const events = (j.items || []).filter((e) => e.status !== "cancelled")
      .map((e) => ({ id: e.id, title: e.summary || "(no title)", start: e.start?.dateTime || e.start?.date, allDay: !!e.start?.date, location: e.location || "" }));
    return jsonResponse({ events }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: `Calendar failed: ${err.message}` }, 200, allowedOrigin);
  }
}

async function handleQuickAdd(request, env, allowedOrigin) {
  try {
    const { text } = await request.json();
    if (!text || text.length > 200) throw new Error("Missing or too-long text.");
    const tok = await googleToken(env);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId(env)}/events/quickAdd?` + new URLSearchParams({ text }), {
      method: "POST", headers: { Authorization: `Bearer ${tok}` },
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || res.status);
    return jsonResponse({ ok: true, title: j.summary, start: j.start?.dateTime || j.start?.date }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: `Could not add event: ${err.message}` }, 200, allowedOrigin);
  }
}

// ---- Calendar: change or delete an existing event (by tap, or by voice through Claude) ----
async function gcal(env, path, method = "GET", body) {
  const tok = await googleToken(env);
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId(env)}/events${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(), j = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(j?.error?.message || res.status);
  return j;
}
const isEventId = (s) => /^[A-Za-z0-9_-]{5,200}$/.test(s || "");
const addDay = (dateStr, n) => new Date(Date.parse(dateStr + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

async function handleEventEdit(path, request, env, allowedOrigin) {
  try {
    const b = await request.json();
    if (path === "/events/parse") return jsonResponse(await parseEventCommand(b.text, env), 200, allowedOrigin);
    if (!isEventId(b.id)) throw new Error("Bad event id.");
    if (path === "/events/delete") { await gcal(env, "/" + b.id, "DELETE"); return jsonResponse({ ok: true }, 200, allowedOrigin); }
    const ev = await gcal(env, "/" + b.id), allDay = !!ev.start?.date, patch = {};
    if (typeof b.title === "string" && b.title.trim()) patch.summary = b.title.trim().slice(0, 120);
    if (Number.isFinite(b.shift_minutes)) {                       // nudge: ±1 day or ±1 hour
      const m = Math.round(b.shift_minutes);
      if (allDay) { const d = Math.round(m / 1440); patch.start = { date: addDay(ev.start.date, d) }; patch.end = { date: addDay(ev.end.date, d) }; }
      else { patch.start = { dateTime: new Date(Date.parse(ev.start.dateTime) + m * 60000).toISOString() }; patch.end = { dateTime: new Date(Date.parse(ev.end.dateTime) + m * 60000).toISOString() }; }
    } else if (b.start) {                                         // exact new start, keeping the event's length
      if (allDay) { if (!/^\d{4}-\d{2}-\d{2}/.test(b.start)) throw new Error("Need a date."); const s = b.start.slice(0, 10), span = Math.max(1, daysBetween(ev.end.date, ev.start.date)); patch.start = { date: s }; patch.end = { date: addDay(s, span) }; }
      else { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(b.start)) throw new Error("Need a date and a time for this event."); const dur = Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime), local = b.start.slice(0, 16) + ":00";
        patch.start = { dateTime: local, timeZone: HOME_TZ }; patch.end = { dateTime: new Date(Date.parse(local + "Z") + dur).toISOString().slice(0, 19), timeZone: HOME_TZ }; }
    }
    if (!Object.keys(patch).length) throw new Error("Nothing to change.");
    await gcal(env, "/" + b.id, "PATCH", patch);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: err.message }, 200, allowedOrigin);
  }
}

// Claude reads the spoken command next to the upcoming events and proposes ONE change. It never changes anything itself:
// the tablet shows the proposal and only an explicit "Yes" calls update/delete, and only for an event id that is on the calendar.
async function parseEventCommand(text, env) {
  if (!text || text.length > 200) throw new Error("Missing or too-long text.");
  const now = new Date();
  const q = new URLSearchParams({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 30 * 864e5).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "40" });
  const list = await gcal(env, "?" + q);
  const events = (list.items || []).filter((e) => e.status !== "cancelled").map((e) => ({ id: e.id, title: e.summary || "(no title)", start: e.start?.dateTime || e.start?.date, all_day: !!e.start?.date }));
  const nowLocal = now.toLocaleString("sv-SE", { timeZone: HOME_TZ }).slice(0, 16).replace(" ", "T"), weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: HOME_TZ });
  const prompt = `You turn a spoken command about a household calendar into JSON. The text was transcribed from speech and may contain mishearings, so match event names loosely.
Now (local time): ${nowLocal}, ${weekday}. Time zone: ${HOME_TZ}.
Upcoming events: ${JSON.stringify(events)}
Command: ${JSON.stringify(text)}
Reply with ONLY this JSON, no markdown: {"action":"add|delete|move|rename|none","event_id":"id from the list (delete, move, rename)","new_start":"YYYY-MM-DDTHH:MM local, or YYYY-MM-DD for an all-day event; if only the day changes keep the event's original time of day","new_title":"for rename","add_text":"for add: the corrected sentence, e.g. Dinner with Anna Friday 7pm","say":"a short confirmation without a question mark, e.g. Move “Farmers market” to Saturday at 10 AM"}
A new event is add. If the command refers to an event that is not in the list, or is unclear, use none and explain briefly in say.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] }) });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API error (${res.status}): ${data?.error?.message || "unknown"}`);
  const m = (data.content || []).map((c) => c.text || "").join("").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Could not understand that.");
  const p = JSON.parse(m[0]), ids = new Set(events.map((e) => e.id));
  const plan = { action: ["add", "delete", "move", "rename"].includes(p.action) ? p.action : "none", event_id: String(p.event_id || ""), new_start: String(p.new_start || ""), new_title: String(p.new_title || "").slice(0, 120), add_text: String(p.add_text || text).slice(0, 200), say: String(p.say || "").slice(0, 160) };
  if (["delete", "move", "rename"].includes(plan.action) && !ids.has(plan.event_id)) return { action: "none", say: "I couldn't find that event on your calendar." };
  if (plan.action === "move" && !/^\d{4}-\d{2}-\d{2}/.test(plan.new_start)) return { action: "none", say: "I didn't catch the new day or time." };
  if (plan.action === "rename" && !plan.new_title) return { action: "none", say: "I didn't catch the new name." };
  return plan;
}

// ---- Eat out card: Claude picks 2 places, using web search to check hours ----
// Needs web search enabled for your org in the Anthropic Console. Optional:
// the `v_restaurants_to_try` view (see schema.sql) to steer picks.
// Kept in this isolate's memory (the Cache API doesn't work on *.workers.dev). The tablet also
// caches the picks itself, so a Worker restart doesn't trigger a new (paid) search by itself.
let eatCache = { at: 0, body: null };
const EAT_TTL = 12 * 3600e3, EAT_MIN_GAP = 10 * 60e3;

async function handleEatOut(request, env, allowedOrigin) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const age = Date.now() - eatCache.at;
  if (eatCache.body && ((!fresh && age < EAT_TTL) || (fresh && age < EAT_MIN_GAP))) {
    return jsonResponse({ ...eatCache.body, cached: true }, 200, allowedOrigin);
  }

  let toTry = [];
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/v_restaurants_to_try?select=name,cuisine&limit=20`, {
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
    });
    if (r.ok) toTry = await r.json();
  } catch (err) { /* table not there yet — fine */ }

  const { hour, weekday } = getSeasonAndTime();
  const prompt =
    `Two adults live in Downtown West, Minneapolis (around 44.975, -93.275). It's ${hour}:00 on a ${weekday} ` +
    `(Minneapolis time). Use web search to find 2 good restaurants within about a 15-minute walk that are open ` +
    `now or will be open this evening, with different cuisines from each other. Verify opening hours with a ` +
    `search; if you can't confirm them, say "hours unverified" in the hours field. ` +
    (toTry.length ? `If any fit, prefer places from their to-try list: ${toTry.map((p) => `${p.name} (${p.cuisine || "?"})`).join(", ")}. ` : "") +
    `Respond ONLY with valid JSON, no markdown fences, no preamble, in exactly this shape: ` +
    `{"places":[{"name":"","kind":"cuisine","price":"$ to $$$$","rating":"e.g. 4.5 (only if found in search, else empty)","walk":"e.g. 8 min walk","hours":"e.g. Open until 10 PM","addr":"street address","dish":"one dish worth ordering","why":"max 14 words on why it suits tonight"}]}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return jsonResponse({ error: true, message: `Claude API error (${res.status}): ${data?.error?.message || "unknown"}` }, 200, allowedOrigin);
    }
    // After a search the reply has several text blocks; join them and pull out the JSON object.
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return jsonResponse({ error: true, message: `No JSON in Claude's reply: ${text.slice(0, 150)}` }, 200, allowedOrigin);
    const parsed = JSON.parse(match[0]);
    const places = (Array.isArray(parsed.places) ? parsed.places : [])
      .filter((p) => p && p.name)
      .slice(0, 2)
      .map((p) => ({ name: String(p.name), kind: String(p.kind || ""), price: String(p.price || ""), rating: String(p.rating || ""), walk: String(p.walk || ""), hours: String(p.hours || ""), addr: String(p.addr || ""), dish: String(p.dish || ""), why: String(p.why || "") }));
    if (!places.length) return jsonResponse({ error: true, message: "Claude returned no places." }, 200, allowedOrigin);

    const body = { places, generated_at: new Date().toISOString() };
    eatCache = { at: Date.now(), body };
    return jsonResponse(body, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: `Eat-out failed: ${err.message}` }, 200, allowedOrigin);
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, X-Hub-Secret",
  };
}
