// OTC Funnel API — a tiny self-hosted, read-only proxy that exposes ONLY your
// OnlyChat (OTC) Telegram funnel to a partner. Your OnlyChat token/login stays
// in .env on your machine; the partner only ever gets a PARTNER_API_KEY that
// hits /funnel/*. No message bodies, notes, phones, or mutations are exposed.
//
// One instance can serve MANY creators of the SAME OnlyChat account (same org):
// configure ONLYCHAT_CREATOR_IDS and pick one per call with ?creator=<id>.
// Omitting it falls back to the first configured creator (backward compatible).
//
//   npm install && cp .env.example .env  (fill it) && npm start
//
// See README.md for the full contract and security model.

import express from "express";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const {
  PORT = 8787,
  PARTNER_API_KEYS = "",
  ONLYCHAT_ORG_ID,
  ONLYCHAT_CREATOR_IDS,        // comma-separated list of creator CUIDs (preferred)
  ONLYCHAT_CREATOR_ID,         // legacy single-creator alias (still honored)
  ONLYCHAT_CREATORS,           // optional friendly labels: "emy:cuid1,lina:cuid2"
  ONLYCHAT_TOKEN,
  ONLYCHAT_EMAIL,
  ONLYCHAT_PASSWORD,
  UPSTREAM_CACHE_TTL_MS = 60000,
  MAX_BACKFILL_PER_CALL = 40,
  EXPOSE_MESSAGES = "false", // opt-in: when "true", /funnel/fans/:id/messages returns message text
  EXPOSE_REVENUE = "false",  // opt-in: when "true", /funnel/revenue returns per-fan star totals
} = process.env;

// OnlyChat migrated (June 2026): the old telegram-api.only-chat.ai host is dead.
// The Telegram funnel data now lives under api.app.only-chat.ai/telegram-bridge.
const TG = "https://api.app.only-chat.ai/telegram-bridge";
const API = "https://api.app.only-chat.ai";
const SECRET = "Banane-Bleue-88"; // required header on the auth host (api.app.*)
const keys = new Set(PARTNER_API_KEYS.split(",").map((s) => s.trim()).filter(Boolean));

// ── creator allowlist ───────────────────────────────────────────────────────────
// Resolve the set of creators this instance is allowed to serve. ONLYCHAT_CREATORS
// ("label:id,...") supplies labels; ONLYCHAT_CREATOR_IDS / the legacy single
// ONLYCHAT_CREATOR_ID supply the rest. First entry is the default for ?creator=.
function parseCreators() {
  const out = [];
  const seen = new Set();
  const add = (id, label) => {
    id = (id || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: (label || id).trim() });
  };
  for (const pair of (ONLYCHAT_CREATORS || "").split(",")) {
    if (!pair.trim()) continue;
    const [a, b] = pair.split(":").map((s) => (s || "").trim());
    if (b) add(b, a); else add(a); // "label:id" or bare "id"
  }
  for (const id of (ONLYCHAT_CREATOR_IDS || "").split(",")) add(id);
  add(ONLYCHAT_CREATOR_ID); // legacy alias
  return out;
}
const creators = parseCreators();
const creatorIds = new Set(creators.map((c) => c.id));
const defaultCreator = creators[0]?.id;

if (!ONLYCHAT_ORG_ID || !defaultCreator)
  throw new Error("Set ONLYCHAT_ORG_ID and ONLYCHAT_CREATOR_IDS (or legacy ONLYCHAT_CREATOR_ID) in .env");
if (!keys.size) throw new Error("Set PARTNER_API_KEYS in .env (openssl rand -hex 32)");
if (!ONLYCHAT_TOKEN && !(ONLYCHAT_EMAIL && ONLYCHAT_PASSWORD))
  throw new Error("Set ONLYCHAT_TOKEN (Mode A) or ONLYCHAT_EMAIL+ONLYCHAT_PASSWORD (Mode B)");

// Resolve & validate ?creator= against the allowlist; default to the first
// configured creator. Returns null (and writes a 400) on an unknown creator so a
// partner can never pump arbitrary creator IDs of the org through the proxy.
function pickCreator(req, res) {
  const q = (req.query.creator || "").trim();
  if (!q) return defaultCreator;
  if (!creatorIds.has(q)) {
    res.status(400).json({ error: "unknown_creator", detail: "creator not in configured allowlist" });
    return null;
  }
  return q;
}

// ── arrival cache (immutable per fan) — persisted so restarts keep the warm-up ──
// Keyed by `${creatorId}:${fanId}` so creators never share/clobber arrivals.
const CACHE_FILE = new URL("./.arrivals.json", import.meta.url);
let arrivals = {};
try {
  if (existsSync(CACHE_FILE)) arrivals = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
} catch { /* start empty */ }
let saveTimer = null;
const saveArrivals = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeFileSync(CACHE_FILE, JSON.stringify(arrivals)); } catch { /* best-effort */ }
  }, 500);
};
const akey = (cid, fanId) => `${cid}:${fanId}`;

// ── upstream auth: Mode A static token, or Mode B login + JWT cache/refresh ─────
let jwt = { token: ONLYCHAT_TOKEN || null, exp: 0 };
async function token() {
  if (ONLYCHAT_TOKEN) return ONLYCHAT_TOKEN;
  if (jwt.token && Date.now() < jwt.exp) return jwt.token;
  const r = await fetch(`${API}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Only-Chat-Secret": SECRET },
    body: JSON.stringify({ email: ONLYCHAT_EMAIL, password: ONLYCHAT_PASSWORD }),
  });
  if (!r.ok) throw new Error(`signin ${r.status}`);
  const j = await r.json();
  jwt = { token: j.accessToken || j.token, exp: Date.now() + 25 * 60_000 }; // refresh before 30min
  if (!jwt.token) throw new Error("signin: no token in response");
  return jwt.token;
}
async function tg(path, retry = true) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${TG}${path}${sep}organizationId=${ONLYCHAT_ORG_ID}`, {
    headers: { Authorization: `Bearer ${await token()}`, "x-client": "only-chat" },
  });
  if (r.status === 401 && retry && !ONLYCHAT_TOKEN) { jwt.exp = 0; return tg(path, false); }
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

// ── short-lived memory cache so a partner can't drive OnlyChat traffic ──────────
const mem = new Map();
async function cached(key, fn) {
  const hit = mem.get(key);
  if (hit && Date.now() < hit.exp) return hit.val;
  const val = await fn();
  mem.set(key, { val, exp: Date.now() + Number(UPSTREAM_CACHE_TTL_MS) });
  return val;
}

// ── upstream reads ──────────────────────────────────────────────────────────────
async function fetchAllFans(cid) {
  return cached(`fans:${cid}`, async () => {
    const all = [];
    let page = 0, total = Infinity;
    while (all.length < total) {
      const j = await tg(`/creator/${cid}/follows?pageIndex=${page}&pageSize=200&search=`);
      total = j.totalCount ?? (j.data ? j.data.length : 0);
      const batch = j.data || [];
      all.push(...batch);
      if (batch.length === 0) break;
      page++;
    }
    return { fans: all, totalCount: Number.isFinite(total) ? total : all.length };
  });
}

// Walk a fan's messages newest-first to derive: total count, fan-sent count, and
// the EARLIEST createdAt (≈ arrival — the fan row is created on first message).
// Bodies are read but never returned.
async function fanMessageStats(cid, fanId) {
  let page = 0, total = 0, fanSent = 0, earliest = null;
  for (;;) {
    const j = await tg(`/creator/${cid}/follows/fan/${fanId}/messages?pageIndex=${page}&pageSize=20`);
    total = j.paginatedMessages?.totalCount ?? total;
    const data = j.paginatedMessages?.data || [];
    for (const m of data) {
      if (m.role === "fan") fanSent++;
      if (!earliest || m.createdAt < earliest) earliest = m.createdAt;
    }
    if (data.length < 20) break;
    if (++page > 100) break; // safety: ~2000 messages
  }
  return { total, fanSent, arrived_at: earliest };
}

// arrived_at is immutable → cache forever. fanSent (for "replied") is snapshotted
// alongside it; good enough for funnel analytics (a fan rarely un-replies).
async function ensureArrival(cid, fanId) {
  const k = akey(cid, fanId);
  if (arrivals[k]) return arrivals[k];
  const s = await fanMessageStats(cid, fanId);
  arrivals[k] = { arrived_at: s.arrived_at, fanSent: s.fanSent };
  saveArrivals();
  return arrivals[k];
}

const inWindow = (iso, since) => iso && new Date(iso).getTime() >= since;

// Normalize a message/phrase for opener matching: trim + casefold + collapse
// internal whitespace. Mirrors the partner's match-time normalization. Emojis are
// preserved (phrases carry them and they boost rarity).
const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

// The fan's EARLIEST message (the opener) — text + timestamp. Walks the thread to
// the end keeping the oldest. Bodies are read here but only the matched phrase
// (which the partner already supplied) ever leaves this server. Used by /match.
async function firstMessage(cid, fanId) {
  let page = 0, earliest = null;
  for (;;) {
    const j = await tg(`/creator/${cid}/follows/fan/${fanId}/messages?pageIndex=${page}&pageSize=20`);
    const data = j.paginatedMessages?.data || [];
    for (const m of data) {
      if (!earliest || m.createdAt < earliest.createdAt)
        earliest = { text: m.text, createdAt: m.createdAt, role: m.role };
    }
    if (data.length < 20) break;
    if (++page > 100) break; // safety: ~2000 messages
  }
  return earliest;
}

// ── partner auth ────────────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const k = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!keys.has(k)) return res.status(401).json({ error: "unauthorized" });
  next();
};

// ── routes ───────────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.get("/health", (_q, r) => r.json({ ok: true }));

// The creators this instance serves. The partner reads this to learn which
// ?creator= values are valid (and their friendly labels).
app.get("/funnel/creators", auth, (_q, res) => {
  res.json({
    default: defaultCreator,
    creators: creators.map((c) => ({ id: c.id, label: c.label })),
  });
});

// Aggregate funnel. Cheap fields come straight from /follows; arrival-based fields
// (arrived_in_window, replied, arrivals_by_day) read the warm arrival cache and
// backfill up to MAX_BACKFILL_PER_CALL uncached fans per call, so accuracy climbs
// over the first few calls then stays exact.
app.get("/funnel/summary", auth, async (req, res) => {
  const cid = pickCreator(req, res);
  if (!cid) return;
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
    const since = Date.now() - days * 86_400_000;
    const { fans, totalCount } = await fetchAllFans(cid);

    let budget = Number(MAX_BACKFILL_PER_CALL);
    for (const f of fans) {
      if (!arrivals[akey(cid, f.id)] && budget > 0) { await ensureArrival(cid, f.id); budget--; }
    }

    const arrivalsByDay = {};
    let arrived = 0, replied = 0, active = 0, ai = 0;
    for (const f of fans) {
      if (f.aiEnabled) ai++;
      if (inWindow(f.lastInteractionAt, since)) active++;
      const a = arrivals[akey(cid, f.id)];
      if (a) {
        if (a.fanSent > 0) replied++;
        if (inWindow(a.arrived_at, since)) {
          arrived++;
          const day = a.arrived_at.slice(0, 10);
          arrivalsByDay[day] = (arrivalsByDay[day] || 0) + 1;
        }
      }
    }

    res.json({
      creator: cid,
      window_days: days,
      totals: {
        fans: totalCount,
        arrived_in_window: arrived,
        active_in_window: active,
        replied,
        ai_enabled: ai,
      },
      arrivals_by_day: Object.entries(arrivalsByDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count })),
      arrival_coverage: `${fans.filter((f) => arrivals[akey(cid, f.id)]).length}/${fans.length}`,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: "upstream", detail: String(e.message || e) });
  }
});

// Per-fan funnel fields only (no message text, no note, no phone). Message counts
// + arrival are fetched for the requested page (bounded by ?size).
app.get("/funnel/fans", auth, async (req, res) => {
  const cid = pickCreator(req, res);
  if (!cid) return;
  try {
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const size = Math.max(1, Math.min(200, parseInt(req.query.size) || 50));
    const { fans, totalCount } = await fetchAllFans(cid);
    const slice = fans
      .slice()
      .sort((a, b) => String(b.lastInteractionAt).localeCompare(String(a.lastInteractionAt)))
      .slice(page * size, page * size + size);

    const data = [];
    for (const f of slice) {
      const stats = await fanMessageStats(cid, f.id); // fresh counts for this page
      if (!arrivals[akey(cid, f.id)]) { arrivals[akey(cid, f.id)] = { arrived_at: stats.arrived_at, fanSent: stats.fanSent }; saveArrivals(); }
      data.push({
        fan_id: f.id,
        telegram_fan_id: f.telegramFanId,
        name: f.name,
        username: f.username ?? null,
        arrived_at: stats.arrived_at,
        last_interaction_at: f.lastInteractionAt,
        ai_enabled: !!f.aiEnabled,
        tags: (f.tags || []).map((t) => (typeof t === "string" ? t : t.name)).filter(Boolean),
        messages_sent: stats.fanSent,
        messages_total: stats.total,
        script_progress: f.scriptProgress ?? null,
      });
    }
    res.json({ creator: cid, data, total_count: totalCount, page, size });
  } catch (e) {
    res.status(502).json({ error: "upstream", detail: String(e.message || e) });
  }
});

// Opener-phrase attribution WITHOUT exposing messages. The partner posts the
// active phrase pool (?phrases=, newline/comma-separated); we compare each
// recently-arrived fan's earliest message against it and return ONLY fan_id ->
// phrase (+ arrival). Message bodies never leave this box — this is what lets a
// self-hosted bridge creator attribute clicks to real fans the same way the
// onlychat_tracking matcher does for native creators. Always on (it leaks no DMs).
app.get("/funnel/match", auth, async (req, res) => {
  const cid = pickCreator(req, res);
  if (!cid) return;
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days) || 7));
    const since = Date.now() - days * 86_400_000;
    const wanted = new Set(
      String(req.query.phrases || "").split(/[\n,]/).map(norm).filter(Boolean)
    );
    if (!wanted.size) return res.json({ creator: cid, matches: [] });

    const { fans } = await fetchAllFans(cid);
    const matches = [];
    let budget = Number(MAX_BACKFILL_PER_CALL);
    for (const f of fans) {
      if (!inWindow(f.lastInteractionAt, since)) continue; // skip stale fans
      const first = await firstMessage(cid, f.id);
      if (!first || !inWindow(first.createdAt, since)) continue; // arrived outside window
      const phrase = norm(first.text);
      if (wanted.has(phrase)) {
        matches.push({
          fan_id: f.id,
          telegram_fan_id: f.telegramFanId,
          name: f.name,
          phrase,
          arrived_at: first.createdAt,
        });
      }
      if (--budget <= 0) break; // bound upstream reads per call
    }
    res.json({ creator: cid, matches, generated_at: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: "upstream", detail: String(e.message || e) });
  }
});

// Per-fan revenue (star totals). Opt-in via EXPOSE_REVENUE=true — it's the only
// money data the proxy surfaces, so it's off by default to keep the funnel-only
// posture for partners who don't want to share revenue. When on, a bridge creator
// can fire the same Meta Purchase CAPI (on star deltas) as a native one. Still no
// message bodies / notes / phones.
app.get("/funnel/revenue", auth, async (req, res) => {
  if (String(EXPOSE_REVENUE).toLowerCase() !== "true") {
    return res.status(403).json({
      error: "revenue_disabled",
      detail: "Revenue is off. The OnlyChat owner must set EXPOSE_REVENUE=true.",
    });
  }
  const cid = pickCreator(req, res);
  if (!cid) return;
  try {
    const { fans, totalCount } = await fetchAllFans(cid);
    res.json({
      creator: cid,
      data: fans.map((f) => ({
        fan_id: f.id,
        telegram_fan_id: f.telegramFanId,
        total_stars: Number(f.totalStars || 0),
        last_interaction_at: f.lastInteractionAt,
      })),
      total_count: totalCount,
    });
  } catch (e) {
    res.status(502).json({ error: "upstream", detail: String(e.message || e) });
  }
});

// Conversation transcripts for ONE fan. Off by default — the owner opts in with
// EXPOSE_MESSAGES=true, since this is the most sensitive data (fans' private DMs).
app.get("/funnel/fans/:fanId/messages", auth, async (req, res) => {
  if (String(EXPOSE_MESSAGES).toLowerCase() !== "true") {
    return res.status(403).json({
      error: "messages_disabled",
      detail: "Conversation access is off. The OnlyChat owner must set EXPOSE_MESSAGES=true.",
    });
  }
  const cid = pickCreator(req, res);
  if (!cid) return;
  try {
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const size = Math.max(1, Math.min(100, parseInt(req.query.size) || 20));
    const j = await tg(`/creator/${cid}/follows/fan/${req.params.fanId}/messages?pageIndex=${page}&pageSize=${size}`);
    const pm = j.paginatedMessages || {};
    res.json({
      creator: cid,
      fan: j.fan ?? null,
      total_count: pm.totalCount ?? 0,
      page,
      size,
      // newest-first, mirroring upstream
      data: (pm.data || []).map((m) => ({
        id: m.id,
        text: m.text ?? null,
        role: m.role, // "creator" | "fan"
        ai_generated: !!m.aiGenerated,
        media_count: m.mediaCount ?? 0,
        created_at: m.createdAt,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: "upstream", detail: String(e.message || e) });
  }
});

app.listen(PORT, () =>
  console.log(`OTC Funnel API listening on :${PORT} — serving ${creators.length} creator(s)`)
);
