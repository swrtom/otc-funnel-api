// OTC Funnel API — a tiny self-hosted, read-only proxy that exposes ONLY your
// OnlyChat (OTC) Telegram funnel to a partner. Your OnlyChat token/login stays
// in .env on your machine; the partner only ever gets a PARTNER_API_KEY that
// hits /funnel/*. No message bodies, notes, phones, or mutations are exposed.
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
  ONLYCHAT_CREATOR_ID,
  ONLYCHAT_TOKEN,
  ONLYCHAT_EMAIL,
  ONLYCHAT_PASSWORD,
  UPSTREAM_CACHE_TTL_MS = 60000,
  MAX_BACKFILL_PER_CALL = 40,
} = process.env;

const TG = "https://telegram-api.only-chat.ai";
const API = "https://api.app.only-chat.ai";
const SECRET = "Banane-Bleue-88"; // required header on the auth host (api.app.*)
const cid = ONLYCHAT_CREATOR_ID;
const keys = new Set(PARTNER_API_KEYS.split(",").map((s) => s.trim()).filter(Boolean));

if (!ONLYCHAT_ORG_ID || !cid) throw new Error("Set ONLYCHAT_ORG_ID and ONLYCHAT_CREATOR_ID in .env");
if (!keys.size) throw new Error("Set PARTNER_API_KEYS in .env (openssl rand -hex 32)");
if (!ONLYCHAT_TOKEN && !(ONLYCHAT_EMAIL && ONLYCHAT_PASSWORD))
  throw new Error("Set ONLYCHAT_TOKEN (Mode A) or ONLYCHAT_EMAIL+ONLYCHAT_PASSWORD (Mode B)");

// ── arrival cache (immutable per fan) — persisted so restarts keep the warm-up ──
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
async function fetchAllFans() {
  return cached("fans", async () => {
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
async function fanMessageStats(fanId) {
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
async function ensureArrival(fanId) {
  if (arrivals[fanId]) return arrivals[fanId];
  const s = await fanMessageStats(fanId);
  arrivals[fanId] = { arrived_at: s.arrived_at, fanSent: s.fanSent };
  saveArrivals();
  return arrivals[fanId];
}

const inWindow = (iso, since) => iso && new Date(iso).getTime() >= since;

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

// Aggregate funnel. Cheap fields come straight from /follows; arrival-based fields
// (arrived_in_window, replied, arrivals_by_day) read the warm arrival cache and
// backfill up to MAX_BACKFILL_PER_CALL uncached fans per call, so accuracy climbs
// over the first few calls then stays exact.
app.get("/funnel/summary", auth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
    const since = Date.now() - days * 86_400_000;
    const { fans, totalCount } = await fetchAllFans();

    let budget = Number(MAX_BACKFILL_PER_CALL);
    for (const f of fans) {
      if (!arrivals[f.id] && budget > 0) { await ensureArrival(f.id); budget--; }
    }

    const arrivalsByDay = {};
    let arrived = 0, replied = 0, active = 0, ai = 0;
    for (const f of fans) {
      if (f.aiEnabled) ai++;
      if (inWindow(f.lastInteractionAt, since)) active++;
      const a = arrivals[f.id];
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
      arrival_coverage: `${fans.filter((f) => arrivals[f.id]).length}/${fans.length}`,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: "upstream", detail: String(e.message || e) });
  }
});

// Per-fan funnel fields only (no message text, no note, no phone). Message counts
// + arrival are fetched for the requested page (bounded by ?size).
app.get("/funnel/fans", auth, async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const size = Math.max(1, Math.min(200, parseInt(req.query.size) || 50));
    const { fans, totalCount } = await fetchAllFans();
    const slice = fans
      .slice()
      .sort((a, b) => String(b.lastInteractionAt).localeCompare(String(a.lastInteractionAt)))
      .slice(page * size, page * size + size);

    const data = [];
    for (const f of slice) {
      const stats = await fanMessageStats(f.id); // fresh counts for this page
      if (!arrivals[f.id]) { arrivals[f.id] = { arrived_at: stats.arrived_at, fanSent: stats.fanSent }; saveArrivals(); }
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
    res.json({ data, total_count: totalCount, page, size });
  } catch (e) {
    res.status(502).json({ error: "upstream", detail: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`OTC Funnel API listening on :${PORT}`));
