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
//   GET /shopping  the open shopping list;  POST /shopping/add {names} /update {id,status} /remove {id|names} /bought {names} /clear
//   POST /stock/remove {id}  POST /meal-idea/remove {name}  POST /cards/dismiss {id}   delete or dismiss an entry from its screen.
//   GET /money?period=this|last|3m|year   spending by category vs budget for this month, last month, the last 3 months or this year to date (the Money card).
//   GET /restock  things you used to buy regularly but haven't for a while (the Pantry card).
//   GET /money/setup  accounts, categories with budgets, merchants (finance admin page).
//   POST /money/import {account, kind, rows}   bank CSV rows -> transactions, categorized (history first, then Claude Haiku for new merchants).
//   POST /money/budget {category, amount}   POST /money/recategorize {merchant, category}
//   POST /suggest {request}   Claude suggests 3 dishes (with recipes) from the pantry, recent meals and your request, e.g. "a pumpkin recipe".
//   POST /receipt {image: base64 JPEG}   Claude reads a grocery receipt photo: products, receipt lines, and pantry stock with expiry dates.
//   GET /stock    what is in the house, soonest-to-expire first;  POST /stock/used {id | name}   mark something used up.
//   POST /meal-idea {name}   save a meal idea (suggested until you cook it);  POST /meals/remove {id}   undo a logged meal.
//   POST /meal-plan/draft {request?}   Claude drafts the next 7 dinners around your calendar, pantry and what you haven't eaten lately. Nothing is saved.
//   POST /meal-plan/apply {meals:[{date,name,ingredients?}], shop?}   saves the dinners to the plan and (unless shop is false) adds the ingredients you don't have to the shopping list.
//   POST /meal-plan/shop   adds the missing ingredients for the dinners already planned in the next 7 days to the shopping list.
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
    if (url.pathname === "/shopping" && request.method === "GET") return handleShopping(env, allowedOrigin);
    if (request.method === "POST" && ["/shopping/add", "/shopping/update", "/shopping/remove", "/shopping/bought", "/shopping/clear", "/stock/remove", "/meal-idea/remove", "/cards/dismiss"].includes(url.pathname)) return handleListEdit(url.pathname, request, env, allowedOrigin);
    if (url.pathname === "/money" && request.method === "GET") return handleMoney(env, allowedOrigin, url.searchParams.get("period"));
    if (url.pathname === "/restock" && request.method === "GET") return handleRestock(env, allowedOrigin);
    if (url.pathname === "/money/setup" && request.method === "GET") return handleMoneySetup(env, allowedOrigin);
    if (request.method === "POST" && ["/money/import", "/money/budget", "/money/recategorize"].includes(url.pathname)) return handleMoneyWrite(url.pathname, request, env, allowedOrigin);
    if (url.pathname === "/suggest" && request.method === "POST") return handleSuggest(request, env, allowedOrigin);
    if (url.pathname === "/stock" && request.method === "GET") return handleStock(env, allowedOrigin);
    if (url.pathname === "/stock/used" && request.method === "POST") return handleStockUsed(request, env, allowedOrigin);
    if (url.pathname === "/receipt" && request.method === "POST") return handleReceipt(request, env, allowedOrigin);
    if (url.pathname === "/meals" && request.method === "GET") return handleMeals(env, allowedOrigin);
    if (request.method === "POST" && ["/meals", "/meals/remove", "/meal-plan", "/meal-plan/remove", "/meal-idea"].includes(url.pathname)) return handleMealWrite(url.pathname, request, env, allowedOrigin);
    if (request.method === "POST" && ["/meal-plan/draft", "/meal-plan/apply", "/meal-plan/shop"].includes(url.pathname)) return handlePlanTools(url.pathname, request, env, allowedOrigin);
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

const spanText = (d) => (d <= 60 ? `${d} days` : `${Math.round(d / 30)} months`);
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
  const [recent, hist, plan, recipes] = await Promise.all([
    sb(env, "food_meal?select=id,name,eaten_on&order=eaten_on.desc&limit=8"),
    sb(env, "food_meal?select=name,eaten_on&order=eaten_on.asc&limit=4000"),
    sb(env, `food_meal_plan?select=id,planned_for,name,status&status=eq.planned&planned_for=gte.${today}&order=planned_for.asc&limit=14`),
    sb(env, "food_recipe?select=id,name&limit=100"),
  ]);
  const planned = new Set(plan.map((p) => p.name.toLowerCase())), by = new Map();
  for (const m of hist) { const k = m.name.toLowerCase(), e = by.get(k) || { name: m.name, dates: new Set() }; e.name = m.name; e.dates.add(m.eaten_on); by.set(k, e); }
  // Suggest what you haven't had for a while, most overdue first: how long since, compared with how often you usually have it.
  const stale = [];
  for (const [k, e] of by) {
    const ds = [...e.dates].sort(), n = ds.length, since = daysBetween(today, ds[n - 1]), avg = n >= 2 ? daysBetween(ds[n - 1], ds[0]) / (n - 1) : null;
    if (planned.has(k) || since < 7 || since > 365) continue;
    stale.push({ name: e.name, days_since: since, usual: avg ? Math.round(avg) : null, times: n, score: avg ? since / avg : Math.min(since, 60) / 30 });      // one-off meals count for less than a regular that is overdue
  }
  stale.sort((a, b) => b.score - a.score);
  const ideas = recipes.filter((r) => !by.has(r.name.toLowerCase()) && !planned.has(r.name.toLowerCase())).map((r) => ({ name: r.name, days_since: null, idea: true }));
  return { recent: recent.map((m) => ({ ...m, days_since: daysBetween(today, m.eaten_on) })), gaps: [...stale.map(({ score, ...r }) => r), ...ideas].slice(0, 8), plan };
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

// ---- Meal plan -> shopping list: Claude drafts the week around the calendar, pantry and what you haven't eaten lately; what you don't have goes on the list ----
const PLAN_DAYS = 7;
const STAPLES = /^(salt|pepper|black pepper|water|ice|oil|olive oil|cooking oil|vegetable oil|cooking spray)$/i;
const wdayOf = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const localDateOf = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: HOME_TZ });
const localTimeOf = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: HOME_TZ, hour: "numeric", minute: "2-digit" });
const localHourOf = (iso) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso)); return +p.find((x) => x.type === "hour").value + +p.find((x) => x.type === "minute").value / 60; };
const strList = (a, n, len) => (Array.isArray(a) ? a : []).map((x) => String(x).trim().slice(0, len)).filter(Boolean).slice(0, n);

async function askClaudeJson(env, prompt, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: SUGGEST_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }) });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API error (${res.status}): ${data?.error?.message || "unknown"}`);
  const m = (data.content || []).map((c) => c.text || "").join("").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude didn't send a usable answer. Try again.");
  try { return JSON.parse(m[0]); } catch (e) { throw new Error("Claude's answer got cut off. Try again."); }
}

// "2 cups chopped Spinach (fresh), washed" -> "Spinach"
function cleanIngredient(s) {
  let t = String(s || "").replace(/\([^)]*\)/g, " ").replace(/,.*$/, "").trim().replace(/^(?:a|an|some|the)\s+/i, "");
  t = t.replace(/^[\d\s½¼¾⅓⅔\/.\-]+/, "");
  t = t.replace(/^(?:(?:cups?|tbsp|tsp|tablespoons?|teaspoons?|oz|ounces?|lbs?|pounds?|g|kg|ml|l|cans?|cloves?|bunch(?:es)?|packs?|pkgs?|slices?|pieces?|large|medium|small)\b\.?\s*)+(?:of\s+)?/i, "");
  t = t.replace(/^(?:(?:finely|roughly|thinly)\s+)?(?:(?:chopped|diced|minced|sliced|grated|shredded|crushed|fresh|ripe)\s+)+/i, "");
  return cleanItem(t);
}
const foodKey = (s) => String(s).toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim().replace(/(\w)ies\b/g, "$1y").replace(/(\w)oes\b/g, "$1o").replace(/(\w{2})s\b/g, "$1");
// Same food if the last words match ("whole milk" ~ "milk") and one name's words contain the other's. "pasta" is not "pasta sauce".
function sameFood(a, b) {
  if (!a || !b) return false; if (a === b) return true;
  const x = a.split(" "), y = b.split(" ");
  if (x[x.length - 1] !== y[y.length - 1]) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x]; return s.every((w) => l.includes(w));
}

async function draftWeek(env, b) {
  const today = todayStr(), dates = Array.from({ length: PLAN_DAYS }, (_, i) => addDay(today, i)), wish = String(b.request || "").trim().slice(0, 200);
  const soft = (p) => p.catch(() => null);
  const [meals, stock, events] = await Promise.all([loadMealData(env), soft(loadStock(env)), soft(loadEvents(env, PLAN_DAYS + 1, 50))]);
  const planned = new Map(meals.plan.filter((p) => dates.includes(p.planned_for)).map((p) => [p.planned_for, p])), free = dates.filter((d) => !planned.has(d));
  if (!free.length) return { days: [], kept: [...planned.values()], calendar: !!events, message: "Every night this week already has a dinner planned." };

  const dinnerBusy = new Map(), notes = new Map(dates.map((d) => [d, []]));      // code decides what counts as "busy at dinner"; Claude gets the facts
  for (const e of events || []) {
    if (e.allDay) { const d = String(e.start).slice(0, 10); if (notes.has(d)) notes.get(d).push(`all day: ${e.title}`); continue; }
    const d = localDateOf(e.start); if (!notes.has(d)) continue;
    const sh = localHourOf(e.start), eh = e.end && localDateOf(e.end) === d ? localHourOf(e.end) : 24;
    notes.get(d).push(`${localTimeOf(e.start)} ${e.title}`);
    if (sh < 20.5 && eh > 17) dinnerBusy.set(d, `${localTimeOf(e.start)} ${e.title}`);
  }
  const dayLine = (d) => `- ${wdayOf(d)} ${d}${d === today ? " (tonight)" : ""}: ${events ? (notes.get(d).join("; ") || "calendar is free") + (dinnerBusy.has(d) ? " [BUSY AT DINNER TIME]" : "") : "calendar unavailable"}`;
  const pantry = (stock || []).filter((s) => s.days_left === null || s.days_left >= 0).slice(0, 50).map((s) => `${s.name} (${s.days_left === null ? "?" : s.days_left}d)`).join(", ");
  const prompt = `You plan home-cooked dinners for two adults. Plan a dinner for each of these days, and only these days:
${free.map(dayLine).join("\n")}
${planned.size ? `Already planned (do not plan these days, and do not repeat these dishes): ${[...planned.values()].map((p) => `${wdayOf(p.planned_for)} ${p.planned_for}: ${p.name}`).join("; ")}.\n` : ""}In the pantry (soonest to expire first, days left): ${pantry || "unknown"}.
Eaten at home recently: ${meals.recent.map((m) => `${m.name} (${m.days_since} days ago)`).join(", ") || "nothing logged"}.
Not had in a while, good picks: ${meals.gaps.filter((g) => !g.idea).map((g) => `${g.name} (${g.days_since} days)`).join(", ") || "none"}.
Saved ideas to try: ${meals.gaps.filter((g) => g.idea).map((g) => g.name).join(", ") || "none"}.
${wish ? `Their wish for this week: ${JSON.stringify(wish)}.\n` : ""}Rules:
- On a day marked BUSY AT DINNER TIME, pick something that takes 25 minutes or less or can be made ahead. If that calendar entry is itself a meal out (dinner, restaurant, party), set name to null.
- Use pantry items that expire soon in the first days of the week.
- Prefer dishes they haven't had in a while and saved ideas, mixed with a few new ones. Don't repeat anything eaten in the last 7 days, and never plan the same dish twice. Vary the main ingredients.
- ingredients: plain item names only, no quantities and no brands, 3 to 10 per dish. Leave out salt, pepper, cooking oil and water.
Reply with ONLY this JSON, no markdown: {"days":[{"date":"YYYY-MM-DD","name":"short dish name or null","why":"one short sentence","time_min":number,"uses":["pantry items it uses"],"ingredients":["item"]}]}
Include exactly one entry per day listed above.`;
  const parsed = await askClaudeJson(env, prompt, 3500), got = new Map();
  for (const d of parsed.days || []) { const date = String(d.date || ""); if (free.includes(date) && !got.has(date)) got.set(date, d); }
  const days = free.map((date) => { const d = got.get(date) || {}, name = d.name ? String(d.name).trim().slice(0, 80) : "";
    return { date, name: name || null, why: String(d.why || "").slice(0, 200), time_min: Math.max(0, Math.min(600, Math.round(Number(d.time_min) || 0))), uses: strList(d.uses, 4, 40), ingredients: name ? strList(d.ingredients, 12, 60) : [], busy: dinnerBusy.get(date) || "" }; });
  return { days, kept: dates.filter((d) => planned.has(d)).map((d) => planned.get(d)), calendar: !!events, pantry: !!stock };
}

// Which of these dishes' ingredients are missing from the pantry? Put those on the shopping list. Dishes without a known ingredient list are looked up with Claude.
async function shopForMeals(env, meals) {
  const need = meals.filter((m) => !(m.ingredients || []).length);
  if (need.length) {
    const j = await askClaudeJson(env, `For two adults, list what to buy to cook each dish below. Plain item names only, no quantities and no brands, 3 to 10 per dish, leaving out salt, pepper, cooking oil and water.
Dishes: ${need.map((m) => JSON.stringify(m.name)).join(", ")}
Reply with ONLY this JSON, no markdown: {"meals":[{"name":"dish exactly as written above","ingredients":["item"]}]}`, 2500);
    const by = new Map((j.meals || []).map((x) => [String(x.name || "").toLowerCase(), strList(x.ingredients, 12, 60)]));
    need.forEach((m) => { m.ingredients = by.get(m.name.toLowerCase()) || []; });
  }
  const want = new Map();
  for (const m of meals) for (const ing of m.ingredients || []) { const n = cleanIngredient(ing); if (!n || STAPLES.test(n)) continue; const k = foodKey(n); if (k && ![...want.keys()].some((x) => sameFood(x, k))) want.set(k, n); }      // "Milk" and "Whole milk" from two dishes are one item
  const stock = (await loadStock(env)).filter((s) => s.days_left === null || s.days_left >= 0).map((s) => foodKey(s.name)), have = [], missing = [];
  for (const [k, n] of want) (stock.some((s) => sameFood(s, k)) ? have : missing).push(n);
  const r = missing.length ? await addToShopping(env, missing.slice(0, 60)) : { added: [], duplicates: [] };
  return { added: r.added, on_list: r.duplicates, have, dishes: meals.length };
}

async function handlePlanTools(path, request, env, allowedOrigin) {
  try {
    const b = await request.json().catch(() => ({})), today = todayStr(), isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
    if (path === "/meal-plan/draft") return jsonResponse(await draftWeek(env, b), 200, allowedOrigin);
    if (path === "/meal-plan/apply") {
      const meals = (Array.isArray(b.meals) ? b.meals : []).map((m) => ({ date: m.date, name: String(m.name || "").trim().slice(0, 80), ingredients: strList(m.ingredients, 12, 60) }))
        .filter((m) => m.name && isDate(m.date) && m.date >= today && m.date <= addDay(today, PLAN_DAYS - 1)).slice(0, PLAN_DAYS);
      if (!meals.length) throw new Error("There are no dinners to save.");
      for (const m of meals) await sb(env, "food_meal_plan?on_conflict=planned_for", { method: "POST", prefer: "resolution=merge-duplicates", body: { planned_for: m.date, name: m.name, status: "planned" } });
      lastCards = 0;
      const out = { ok: true, planned: meals.length };
      if (b.shop !== false) { try { Object.assign(out, await shopForMeals(env, meals)); } catch (e) { out.shop_error = e.message; } }      // the dinners are saved either way
      return jsonResponse(out, 200, allowedOrigin);
    }
    // /meal-plan/shop: the dinners already planned for the next 7 days
    const rows = await sb(env, `food_meal_plan?select=planned_for,name&status=eq.planned&planned_for=gte.${today}&planned_for=lte.${addDay(today, PLAN_DAYS - 1)}&order=planned_for.asc`);
    if (!rows.length) throw new Error("Nothing is planned for the next 7 days yet.");
    return jsonResponse({ ok: true, ...(await shopForMeals(env, rows.map((r) => ({ name: r.name })))) }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin);
  }
}

// Card refresh: turn the database's "worth your attention" feed into rows the tablet can read.
let lastCards = 0;
const MANAGED_KINDS = ["reminder", "stock", "item", "meal_gap", "meal_plan", "budget", "restock"];
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
    cards.push({ domain: "food", kind: "meal_gap", dedupe_key: g.name.toLowerCase(), headline: `${g.name}: not had in ${spanText(g.days_since)}`, body: "Plan it this week?", icon: "🍽️", priority: 40, refreshed_at: started }));
  try {      // things you buy regularly and haven't bought for a while
    (await loadRestock(env)).slice(0, 2).forEach((r) => cards.push({ domain: "food", kind: "restock", dedupe_key: r.name.toLowerCase(), headline: `Restock ${r.name}?`, body: `Last bought ${spanText(r.days_since)} ago${r.usual ? ` (usually every ${r.usual} days)` : ""}`, icon: "🛒", priority: 45, refreshed_at: started }));
  } catch (e) { /* no receipt history yet */ }
  try {      // a card when a category is close to or over its monthly budget (percentages only, so nothing private shows on the wall)
    const mo = await moneyData(env);
    mo.categories.filter((c) => c.budget && c.spent >= c.budget * 0.9).slice(0, 2).forEach((c) => cards.push({ domain: "money", kind: "budget", dedupe_key: c.name.toLowerCase(),
      headline: `${c.name} is ${c.spent >= c.budget ? "over" : "close to"} its budget (${Math.round((c.spent / c.budget) * 100)}%)`, body: mo.month, icon: "💰", priority: c.spent >= c.budget ? 75 : 55, refreshed_at: started }));
  } catch (e) { /* no finance data yet */ }
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

// ---- Restock suggestions: from receipt history, what you used to buy but haven't lately ----
async function loadRestock(env) {
  const today = todayStr();
  const [lines, rcpts, prods, stock] = await Promise.all([sb(env, "food_receipt_line?select=product_id,receipt_id&limit=8000"), sb(env, "food_receipt?select=id,purchased_at&limit=3000"),
    sb(env, "food_product?select=id,name&limit=3000"), sb(env, "food_stock?select=product_id&status=eq.in_stock&limit=1000")]);
  const rdate = new Map(rcpts.map((r) => [r.id, String(r.purchased_at).slice(0, 10)])), name = new Map(prods.map((p) => [p.id, p.name])), inStock = new Set(stock.map((s) => s.product_id)), onList = new Set();
  try { (await loadShopping(env)).filter((i) => i.status === "wanted").forEach((i) => onList.add(i.name.toLowerCase())); } catch (e) {}
  const dates = new Map();
  for (const l of lines) { const d = rdate.get(l.receipt_id); if (!d || !l.product_id) continue; if (!dates.has(l.product_id)) dates.set(l.product_id, new Set()); dates.get(l.product_id).add(d); }
  const out = [];
  for (const [pid, set] of dates) {
    const ds = [...set].sort(), n = ds.length, since = daysBetween(today, ds[n - 1]), avg = n >= 2 ? daysBetween(ds[n - 1], ds[0]) / (n - 1) : null, nm = name.get(pid);
    if (!nm || inStock.has(pid) || onList.has(nm.toLowerCase()) || since > 365) continue;
    if (avg ? since >= Math.max(7, avg * 1.3) : since >= 30) out.push({ name: nm, days_since: since, usual: avg ? Math.round(avg) : null, score: avg ? since / avg : Math.min(since, 60) / 30 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8).map(({ score, ...r }) => r);
}
async function handleRestock(env, allowedOrigin) {
  try { return jsonResponse({ items: await loadRestock(env) }, 200, allowedOrigin); }
  catch (err) { return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin); }
}

// ---- Shopping list: one open list, filled by voice or taps; delete/dismiss endpoints for other screens ----
const CAT_GUESS = [[/milk|cheese|yogurt|yoghurt|butter|egg|cream|ricotta|mozzarella|parmesan/i, "Dairy & eggs"], [/apple|banana|lemon|lime|orange|tomato|spinach|salad|lettuce|zucchini|cucumber|potato|onion|garlic|carrot|pepper|basil|herb|fruit|veg|mushroom|avocado|pumpkin/i, "Produce"],
  [/chicken|beef|pork|steak|sausage|ham|bacon|fish|salmon|tuna|shrimp|turkey/i, "Meat & fish"], [/bread|bagel|bun|roll|croissant|flour/i, "Bakery"], [/frozen|ice cream|pizza/i, "Frozen"],
  [/water|juice|wine|beer|coffee|tea|soda|cola/i, "Drinks"], [/paper|soap|detergent|shampoo|toilet|tissue|sponge|trash|bag/i, "Household"], [/pasta|rice|oil|sugar|salt|sauce|beans|cereal|nuts|honey|jam|spice/i, "Pantry"]];
const guessCategory = (n) => (CAT_GUESS.find(([re]) => re.test(n)) || [])[1] || null;
const cleanItem = (s) => { const t = String(s || "").replace(/^(?:some|a|an|the|more)\s+/i, "").replace(/[.!?]+$/, "").trim().slice(0, 60); return t ? t[0].toUpperCase() + t.slice(1) : ""; };
async function openList(env, create) {
  let [l] = await sb(env, "food_list?select=id&status=eq.open&limit=1");
  if (!l && create) [l] = await sb(env, "food_list", { method: "POST", prefer: "return=representation", body: { name: "Shopping list" } });
  return l || null;
}
async function loadShopping(env) {
  const l = await openList(env, false); if (!l) return [];
  const rows = await sb(env, `food_list_item?select=id,product_id,label,qty,status&list_id=eq.${l.id}&limit=200`), pids = [...new Set(rows.map((r) => r.product_id).filter(Boolean))];
  const [prods, cats] = await Promise.all([pids.length ? sb(env, `food_product?select=id,name,name_en,category_id&id=in.(${pids.join(",")})`) : [], sb(env, "food_category?select=id,name_en,emoji&limit=100")]);
  const pm = new Map(prods.map((p) => [p.id, p])), cm = new Map(cats.map((c) => [c.id, c]));
  return rows.map((r) => { const p = pm.get(r.product_id), c = p && cm.get(p.category_id);
    return { id: r.id, name: p ? p.name : r.label, name_en: p ? p.name_en || p.name : r.label, category: c ? c.name_en : "", emoji: c ? c.emoji : "", qty: r.qty, status: r.status }; })
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "wanted" ? -1 : 1));
}
async function handleShopping(env, allowedOrigin) {
  try { return jsonResponse({ items: await loadShopping(env) }, 200, allowedOrigin); }
  catch (err) { return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin); }
}
// Put these names on the open list: reuse a known product, create new ones in one batch, and skip what is already wanted.
async function addToShopping(env, names) {
  const l = await openList(env, true), items = await sb(env, `food_list_item?select=id,product_id,status&list_id=eq.${l.id}&limit=200`);
  const [prods, cats] = await Promise.all([sb(env, "food_product?select=id,name,name_en&limit=2000"), sb(env, "food_category?select=id,name_en&limit=100")]);
  const byName = new Map(); prods.forEach((p) => { byName.set(p.name.toLowerCase(), p); if (p.name_en) byName.set(p.name_en.toLowerCase(), p); });
  const unknown = [...new Map(names.filter((n) => !byName.has(n.toLowerCase())).map((n) => [n.toLowerCase(), n])).values()];
  if (unknown.length) {
    const made = await sb(env, "food_product", { method: "POST", prefer: "return=representation", body: unknown.map((n) => ({ name: n, name_en: n, category_id: cats.find((c) => c.name_en === guessCategory(n))?.id || null })) });
    unknown.forEach((n, i) => { if (made[i]) byName.set(n.toLowerCase(), made[i]); });
  }
  const wanted = new Set(items.filter((i) => i.status === "wanted").map((i) => i.product_id)), added = [], duplicates = [], rows = [];
  for (const n of names) {
    const p = byName.get(n.toLowerCase()); if (!p) continue;
    if (wanted.has(p.id)) { duplicates.push(n); continue; }
    wanted.add(p.id); added.push(n);
    const back = items.find((i) => i.product_id === p.id && i.status === "bought");      // bought before, needed again
    if (back) await sb(env, `food_list_item?id=eq.${back.id}`, { method: "PATCH", body: { status: "wanted" } }); else rows.push({ list_id: l.id, product_id: p.id, qty: 1, status: "wanted" });
  }
  if (rows.length) await sb(env, "food_list_item", { method: "POST", body: rows });
  return { added, duplicates };
}
async function handleListEdit(path, request, env, allowedOrigin) {
  try {
    const b = await request.json(), isId = (s) => /^[0-9a-f-]{36}$/i.test(s || ""), names = (Array.isArray(b.names) ? b.names : []).map(cleanItem).filter(Boolean).slice(0, 12);
    let out = { ok: true };
    if (path === "/stock/remove") { if (!isId(b.id)) throw new Error("Bad id."); await sb(env, `food_stock?id=eq.${b.id}`, { method: "DELETE" }); lastCards = 0; }
    else if (path === "/cards/dismiss") { if (!isId(b.id)) throw new Error("Bad id."); await sb(env, `core_card?id=eq.${b.id}`, { method: "PATCH", body: { expires_at: new Date().toISOString() } }); }   // stays hidden until the underlying reason clears
    else if (path === "/meal-idea/remove") {
      const n = String(b.name || "").trim().toLowerCase(), hit = (await sb(env, "food_recipe?select=id,name&limit=200")).find((r) => r.name.toLowerCase() === n);
      if (hit) await sb(env, `food_recipe?id=eq.${hit.id}`, { method: "DELETE" }); lastCards = 0;
    }
    else if (path === "/shopping/add") {
      if (!names.length) throw new Error("Tell me what to add.");
      out = { ok: true, ...(await addToShopping(env, names)) };
    }
    else if (path === "/shopping/update") {
      if (!isId(b.id) || !["wanted", "bought"].includes(b.status)) throw new Error("Bad request.");
      await sb(env, `food_list_item?id=eq.${b.id}`, { method: "PATCH", body: { status: b.status } });
    }
    else if (path === "/shopping/remove" || path === "/shopping/bought") {
      const list = await loadShopping(env), hits = [];
      if (isId(b.id)) { const it = list.find((i) => i.id === b.id); if (it) hits.push(it); }
      for (const n of names) {
        const k = n.toLowerCase().replace(/s$/, ""), it = list.find((i) => { const x = (i.name_en || i.name).toLowerCase(), y = i.name.toLowerCase(); return x.includes(k) || y.includes(k) || k.includes(x.replace(/s$/, "")); });
        if (!it) throw new Error(`I couldn't find “${n}” on the list.`); hits.push(it);
      }
      if (!hits.length) throw new Error("Nothing to change.");
      for (const it of hits) await sb(env, `food_list_item?id=eq.${it.id}`, path === "/shopping/remove" ? { method: "DELETE" } : { method: "PATCH", body: { status: "bought" } });
      out = { ok: true, matched: hits.map((h) => h.name) };
    }
    else if (path === "/shopping/clear") { const l = await openList(env, false); if (l) await sb(env, `food_list_item?list_id=eq.${l.id}&status=eq.bought`, { method: "DELETE" }); }
    return jsonResponse(out, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin);
  }
}

// ---- Money: bank CSV in, categories (history first, Claude for new merchants), budgets, and the month summary ----
const MONEY_MODEL = "claude-haiku-4-5-20251001";
const round2 = (n) => Math.round(n * 100) / 100;
const pad2w = (n) => String(n).padStart(2, "0");
function monthBounds(today) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7), day = +today.slice(8), py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1, pdim = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return { y, m, day, dim: new Date(Date.UTC(y, m, 0)).getUTCDate(), start: `${y}-${pad2w(m)}-01`, prevStart: `${py}-${pad2w(pm)}-01`, prevSame: `${py}-${pad2w(pm)}-${pad2w(Math.min(day, pdim))}` };
}
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthLabelOf = (y, m) => new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const shiftMonth = (y, m, d) => { const t = y * 12 + (m - 1) + d; return [Math.floor(t / 12), (t % 12) + 1]; };
async function moneyData(env, period = "this") {
  const today = todayStr(), b = monthBounds(today), ms = (y, m) => `${y}-${pad2w(m)}-01`, me = (y, m) => `${y}-${pad2w(m)}-${pad2w(lastDayOf(y, m))}`;
  let start, end, label, months = 1, cmp = null, day = b.day, days = b.dim;
  if (period === "last") { const [y, m] = shiftMonth(b.y, b.m, -1), [py, pm] = shiftMonth(b.y, b.m, -2); start = ms(y, m); end = me(y, m); label = monthLabelOf(y, m); cmp = [ms(py, pm), me(py, pm)]; day = days = lastDayOf(y, m); }
  else if (period === "3m") { const [y, m] = shiftMonth(b.y, b.m, -2); start = ms(y, m); end = today; months = 3; label = `${new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })} – ${monthLabelOf(b.y, b.m)}`; }
  else if (period === "year") { start = `${b.y}-01-01`; end = today; months = b.m; label = b.m === 1 ? monthLabelOf(b.y, 1) : `Jan – ${monthLabelOf(b.y, b.m)}`; cmp = [`${b.y - 1}-01-01`, `${b.y - 1}-${pad2w(b.m)}-${pad2w(Math.min(b.day, lastDayOf(b.y - 1, b.m)))}`]; }
  else { period = "this"; start = b.start; end = today; label = monthLabelOf(b.y, b.m); cmp = [b.prevStart, b.prevSame]; }
  const [cats, budgets, tx, prev, latest, earliest] = await Promise.all([
    sb(env, "money_category?select=id,name&limit=200"), sb(env, "money_budget?select=category_id,amount&limit=200"),
    sb(env, `money_transaction?select=posted_on,amount,merchant,category_id&posted_on=gte.${start}&posted_on=lte.${end}&limit=8000`),
    cmp ? sb(env, `money_transaction?select=amount,category_id&posted_on=gte.${cmp[0]}&posted_on=lte.${cmp[1]}&limit=8000`) : Promise.resolve(null),
    sb(env, "money_transaction?select=posted_on&order=posted_on.desc&limit=1"), sb(env, "money_transaction?select=posted_on&order=posted_on.asc&limit=1"),
  ]);
  const name = new Map(cats.map((c) => [c.id, c.name])), nm = (t) => (name.get(t.category_id) || "").toLowerCase();
  const isSpend = (t) => Number(t.amount) < 0 && nm(t) !== "transfers" && nm(t) !== "income";      // transfers and card payments are not spending
  const by = new Map(), merchants = new Map(); let spent = 0, income = 0;
  for (const t of tx) {
    const a = Number(t.amount); if (a > 0 && nm(t) === "income") income += a;
    if (!isSpend(t)) continue;
    spent -= a; const k = name.get(t.category_id) || "Other"; by.set(k, (by.get(k) || 0) - a); merchants.set(t.merchant || "?", (merchants.get(t.merchant || "?") || 0) - a);
  }
  const bud = new Map(budgets.map((x) => [name.get(x.category_id), Number(x.amount) * months])), through = latest[0]?.posted_on || null;
  let suggest = null;      // nothing this month but data exists: tell the tablet which period to open on
  if (!tx.length && through && period === "this") { const [ly, lm] = shiftMonth(b.y, b.m, -1), [ty, tm] = shiftMonth(b.y, b.m, -2); suggest = through >= ms(ly, lm) ? "last" : through >= ms(ty, tm) ? "3m" : null; }
  return { period, label, month: label, months, day, days, spent: round2(spent), income: round2(income), prev_spent: prev ? round2(prev.filter(isSpend).reduce((a, t) => a - Number(t.amount), 0)) : null,
    budget_total: round2([...bud.values()].reduce((a, x) => a + x, 0)), has_budgets: bud.size > 0, count: tx.length, data_from: earliest[0]?.posted_on || null, data_through: through, suggest_period: suggest,
    categories: [...new Set([...by.keys(), ...bud.keys()])].filter(Boolean).map((n) => ({ name: n, spent: round2(by.get(n) || 0), budget: bud.get(n) ?? null })).sort((a, b) => b.spent - a.spent),
    top: [...merchants].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([merchant, amount]) => ({ merchant, amount: round2(amount) })) };
}
async function handleMoney(env, allowedOrigin, period) {
  try { return jsonResponse(await moneyData(env, period || "this"), 200, allowedOrigin); }
  catch (err) { return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin); }
}
async function handleMoneySetup(env, allowedOrigin) {
  try {
    const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const [accounts, cats, budgets, tx] = await Promise.all([sb(env, "money_account?select=id,name,kind&limit=50"), sb(env, "money_category?select=id,name&order=name.asc&limit=200"),
      sb(env, "money_budget?select=category_id,amount&limit=200"), sb(env, `money_transaction?select=merchant,amount,category_id&posted_on=gte.${since}&limit=5000`)]);
    const cname = new Map(cats.map((c) => [c.id, c.name])), bud = new Map(budgets.map((x) => [x.category_id, Number(x.amount)])), by = new Map();
    for (const t of tx) { const k = t.merchant || "?", e = by.get(k) || { merchant: k, count: 0, total: 0, category: cname.get(t.category_id) || "" }; e.count++; e.total += Math.abs(Number(t.amount)); if (t.category_id) e.category = cname.get(t.category_id); by.set(k, e); }
    return jsonResponse({ accounts, categories: cats.map((c) => ({ id: c.id, name: c.name, budget: bud.get(c.id) ?? null })), merchants: [...by.values()].sort((a, b) => b.count - a.count).slice(0, 60).map((m) => ({ ...m, total: round2(m.total) })) }, 200, allowedOrigin);
  } catch (err) { return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin); }
}
function cleanMerchant(desc) {      // "POS DEBIT TRADER JOE'S #123 MINNEAPOLIS MN" -> "Trader Joe's"
  let s = String(desc || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:pos |debit card |card |checkcard |purchase |recurring |ach |online |sq \*|tst\* )+(?:debit |credit |purchase |payment )*/i, "").replace(/[#*]\s*\d+.*$/, "").replace(/\b\d{4,}\b.*$/, "").replace(/\s+[A-Za-z.'-]+\s+[A-Z]{2}\s*$/, "").replace(/\s+[A-Z]{2}\s*$/, "").replace(/\b\d+\b/g, "").replace(/\s+/g, " ").trim();      // store numbers and the trailing "CITY ST"
  const t = s.split(" ").slice(0, 4).join(" ").toLowerCase().replace(/[^a-z0-9&' .-]/g, "").trim() || String(desc || "").slice(0, 30).toLowerCase();
  return t.replace(/(^|\s)([a-z])/g, (m, sp, c) => sp + c.toUpperCase());      // capitalise word starts only, so "joe's" stays "Joe's"
}
async function categorizeMerchants(env, list, catNames) {      // [{key, sample, sign}] -> Map(key -> category name), asked 60 at a time
  const out = new Map(), lower = new Map(catNames.map((n) => [n.toLowerCase(), n]));
  for (let i = 0; i < list.length; i += 60) {
    const chunk = list.slice(i, i + 60);
    const prompt = `Assign each merchant to exactly one category from this list: ${catNames.join(", ")}.
Credit card payments, transfers between accounts, ATM withdrawals and cash advances are "Transfers". Paychecks, interest and other deposits are "Income". If nothing fits use "Other".
Merchants (key | example text from the bank | usually money in or out):
${chunk.map((c) => `${JSON.stringify(c.key)} | ${JSON.stringify(c.sample)} | ${c.sign}`).join("\n")}
Reply with ONLY a JSON object mapping each key to its category name.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MONEY_MODEL, max_tokens: 3000, messages: [{ role: "user", content: prompt }] }) });
    const data = await res.json(); if (!res.ok) throw new Error(`Claude API error (${res.status}): ${data?.error?.message || "unknown"}`);
    const m = (data.content || []).map((c) => c.text || "").join("").match(/\{[\s\S]*\}/); if (!m) continue;
    const j = JSON.parse(m[0]), nk = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, ""), byKey = new Map(Object.entries(j).map(([k, v]) => [nk(k), v]));
    for (const c of chunk) { const v = lower.get(String(j[c.key] ?? byKey.get(nk(c.key)) ?? "").toLowerCase()); if (v) out.set(c.key, v); }      // tolerate Claude changing a key's punctuation or case
  }
  return out;
}
async function handleMoneyWrite(path, request, env, allowedOrigin) {
  try {
    const b = await request.json(), cats = await sb(env, "money_category?select=id,name&limit=200");
    const catByName = (n) => cats.find((c) => c.name.toLowerCase() === String(n || "").toLowerCase());
    if (path === "/money/budget") {
      const c = cats.find((x) => x.id === b.category_id) || catByName(b.category); if (!c) throw new Error("Unknown category.");
      const amt = Number(b.amount);
      if (!(amt > 0)) await sb(env, `money_budget?category_id=eq.${c.id}`, { method: "DELETE" });
      else await sb(env, "money_budget?on_conflict=category_id", { method: "POST", prefer: "resolution=merge-duplicates", body: { category_id: c.id, amount: round2(amt) } });
      return jsonResponse({ ok: true }, 200, allowedOrigin);
    }
    if (path === "/money/recategorize") {
      const merchant = String(b.merchant || "").slice(0, 120), c = b.category ? catByName(b.category) : null; if (!merchant || (b.category && !c)) throw new Error("Need a merchant and a known category.");
      await sb(env, `money_transaction?merchant=eq.${encodeURIComponent(merchant)}`, { method: "PATCH", body: { category_id: c ? c.id : null } });
      return jsonResponse({ ok: true }, 200, allowedOrigin);
    }
    // ---- import ----
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 5000).map((r) => ({ date: String(r.date || ""), description: String(r.description || "").slice(0, 160), amount: Number(r.amount) }))
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.amount) && r.amount !== 0);
    if (!rows.length) throw new Error("No usable rows: each needs a date, a description and a non-zero amount.");
    const accName = String(b.account || "Main account").trim().slice(0, 60) || "Main account", kind = ["checking", "savings", "credit", "cash"].includes(b.kind) ? b.kind : "checking";
    let acc = (await sb(env, "money_account?select=id,name&limit=50")).find((a) => a.name.toLowerCase() === accName.toLowerCase());
    if (!acc) [acc] = await sb(env, "money_account", { method: "POST", prefer: "return=representation", body: { name: accName, kind } });
    // the same bank line imported twice must not double up: key = date | amount | text | which repeat of that line this is
    const seen = new Map(), items = rows.map((r) => { const k = `${r.date}|${r.amount.toFixed(2)}|${r.description.toLowerCase()}`, n = (seen.get(k) || 0) + 1; seen.set(k, n); return { ...r, merchant: cleanMerchant(r.description), external_id: `${k}|${n}` }; });
    const dates = items.map((i) => i.date).sort(), have = new Set((await sb(env, `money_transaction?select=external_id&account_id=eq.${acc.id}&posted_on=gte.${dates[0]}&posted_on=lte.${dates[dates.length - 1]}&limit=20000`)).map((x) => x.external_id));
    const fresh = items.filter((i) => !have.has(i.external_id));
    // categories: what you already assigned to the same merchant, then Claude for the rest
    const known = new Map((await sb(env, "money_transaction?select=merchant,category_id&limit=20000")).filter((x) => x.category_id).map((x) => [x.merchant, x.category_id]));
    const unknown = [...new Map(fresh.filter((i) => !known.has(i.merchant)).map((i) => [i.merchant, { key: i.merchant, sample: i.description, sign: i.amount > 0 ? "in" : "out" }])).values()];
    let viaClaude = 0, claudeError = "";
    if (unknown.length) {
      try { const got = await categorizeMerchants(env, unknown, cats.map((c) => c.name)); got.forEach((name, key) => { const c = catByName(name); if (c && name.toLowerCase() !== "other") { known.set(key, c.id); viaClaude++; } }); }
      catch (e) { claudeError = e.message; }
    }
    for (let i = 0; i < fresh.length; i += 500) await sb(env, "money_transaction", { method: "POST", body: fresh.slice(i, i + 500).map((r) => ({ account_id: acc.id, posted_on: r.date, amount: r.amount, merchant: r.merchant, category_id: known.get(r.merchant) || null, external_id: r.external_id })) });
    lastCards = 0;
    return jsonResponse({ ok: true, added: fresh.length, duplicates: items.length - fresh.length, categorized_by_claude: viaClaude, uncategorized: fresh.filter((r) => !known.get(r.merchant)).length, from: dates[0], to: dates[dates.length - 1], claude_error: claudeError }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: dbHint(err.message) }, 200, allowedOrigin);
  }
}

// ---- Kitchen suggestions: "suggest a pumpkin recipe", "something quick", "use up the spinach" ----
const SUGGEST_MODEL = "claude-haiku-4-5-20251001";
async function handleSuggest(request, env, allowedOrigin) {
  try {
    const ask = String((await request.json()).request || "").trim().slice(0, 200) || "something good for dinner tonight", today = todayStr();
    let recent = [], stock = [], ideas = [];
    try { [recent, stock, ideas] = await Promise.all([sb(env, "food_meal?select=name,eaten_on&order=eaten_on.desc&limit=20"), loadStock(env), sb(env, "food_recipe?select=name&limit=40")]); }
    catch (e) { /* suggestions still work without the database, just with less context */ }
    const prompt = `You are the kitchen assistant for two adults who cook dinner at home. They asked: ${JSON.stringify(ask)}
The request may come from speech recognition, so read it loosely: it may be a dish ("a pumpkin recipe"), an ingredient, a mood ("something light"), or a general question ("what should we cook").
In the pantry (soonest to expire first, days left): ${stock.slice(0, 40).map((i) => `${i.name} (${i.days_left === null ? "?" : i.days_left}d)`).join(", ") || "unknown"}.
Eaten at home recently: ${recent.map((m) => `${m.name} (${daysBetween(today, m.eaten_on)} days ago)`).join(", ") || "nothing logged"}.
Saved ideas: ${ideas.map((r) => r.name).join(", ") || "none"}.
Reply with ONLY this JSON, no markdown: {"suggestions":[{"name":"short dish name","why":"one short sentence on why it fits","time_min":number,"uses":["pantry items it uses"],"ingredients":["quantity and item", up to 10],"steps":["short step", 3 to 6 steps]}]}
Give exactly 3 different suggestions that fit the request. Prefer using pantry items that expire soon. Don't repeat what they ate in the last 4 days unless they ask for it. Keep ingredients and steps brief and practical.`;
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: SUGGEST_MODEL, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }) });
    const data = await res.json();
    if (!res.ok) throw new Error(`Claude API error (${res.status}): ${data?.error?.message || "unknown"}`);
    const m = (data.content || []).map((c) => c.text || "").join("").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("I couldn't come up with suggestions. Try asking again.");
    const strs = (a, n, len) => (Array.isArray(a) ? a : []).map((x) => String(x).trim().slice(0, len)).filter(Boolean).slice(0, n);
    const suggestions = (JSON.parse(m[0]).suggestions || []).slice(0, 3).map((s) => ({ name: String(s.name || "").trim().slice(0, 80), why: String(s.why || "").slice(0, 200),
      time_min: Math.max(0, Math.min(600, Math.round(Number(s.time_min) || 0))), uses: strs(s.uses, 6, 40), ingredients: strs(s.ingredients, 12, 80), steps: strs(s.steps, 8, 220) })).filter((s) => s.name);
    if (!suggestions.length) throw new Error("I couldn't come up with suggestions. Try asking again.");
    return jsonResponse({ suggestions }, 200, allowedOrigin);
  } catch (err) {
    return jsonResponse({ error: true, message: err.message }, 200, allowedOrigin);
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
    try {
      const l = await openList(env, false), ids = [...new Set(items.map((i) => byName.get(i.name.toLowerCase())?.id).filter(Boolean))];
      if (l && ids.length) await sb(env, `food_list_item?list_id=eq.${l.id}&status=eq.wanted&product_id=in.(${ids.join(",")})`, { method: "PATCH", body: { status: "bought" } });
    } catch (e) { /* the list is optional */ }
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

async function loadEvents(env, days = 14, max = 20) {
  const tok = await googleToken(env);
  const now = new Date();
  const q = new URLSearchParams({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + days * 864e5).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: String(max) });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calId(env)}/events?${q}`, { headers: { Authorization: `Bearer ${tok}` } });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || res.status);
  return (j.items || []).filter((e) => e.status !== "cancelled")
    .map((e) => ({ id: e.id, title: e.summary || "(no title)", start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, allDay: !!e.start?.date, location: e.location || "" }));
}
async function handleEvents(env, allowedOrigin) {
  try {
    return jsonResponse({ events: await loadEvents(env, 14, 20) }, 200, allowedOrigin);
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
  const avoid = (new URL(request.url).searchParams.get("avoid") || "").split("|").map((s) => s.trim().slice(0, 60)).filter(Boolean).slice(0, 30);
  const age = Date.now() - eatCache.at;
  const hasDismissed = !!eatCache.body && eatCache.body.places.some((p) => avoid.includes(p.name));      // a place you dismissed is in the saved picks: make new ones
  if (eatCache.body && ((!fresh && age < EAT_TTL) || (fresh && age < EAT_MIN_GAP && !hasDismissed))) {
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
    (avoid.length ? `Do not suggest any of these places, the household dismissed them: ${avoid.join(", ")}. ` : "") +
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
