# OTC Funnel API

A tiny, self-hosted, **read-only** proxy that exposes **only your OnlyChat (OTC) Telegram
funnel** to a partner — **without** giving them your OnlyChat login, your bearer token, or your
fans' conversations.

You run it. Your OnlyChat credentials stay in `.env` on your machine. The partner gets one
**`PARTNER_API_KEY`** that can only read `/funnel/*`. Revoke the key → access gone, your OTC
account untouched.

```
 OnlyChat  ◀──your creds──▶  OTC Funnel API (this)  ◀──partner API key──▶  Partner
                              read-only · scoped · no msg bodies/notes/PII
```

## Install

Requires Node ≥ 18.

```bash
git clone <this-repo> && cd otc-funnel-api
npm install
cp .env.example .env      # then fill it in (see below)
npm start                 # http://localhost:8787
```

### Configure `.env`

| Var | What |
|---|---|
| `PARTNER_API_KEYS` | Key(s) you give partners. `openssl rand -hex 32`. Comma-separate for several. |
| `ONLYCHAT_ORG_ID` | Your org CUID — from `GET /organization/me` or the SPA URL. |
| `ONLYCHAT_CREATOR_IDS` | One **or many** creator CUIDs of the same account, comma-separated. The partner picks one per call with `?creator=<id>`; omitting it uses the first. (Legacy `ONLYCHAT_CREATOR_ID` is still honored for a single creator.) |
| `ONLYCHAT_CREATORS` | *(optional)* Friendly labels surfaced by `/funnel/creators` — `emy:cuid_aaa,lina:cuid_bbb`. |
| **Mode A** `ONLYCHAT_TOKEN` | Bearer token sniffed from DevTools on `app.only-chat.ai`. Simplest. ⚠️ Can rotate — re-sniff if you start getting 401s. |
| **Mode B** `ONLYCHAT_EMAIL` + `ONLYCHAT_PASSWORD` | Recommended. Leave `ONLYCHAT_TOKEN` empty; the service logs in, caches the ~30-min JWT, and auto-refreshes. Survives token rotation. |

## Endpoints (what the partner can call)

All require `Authorization: Bearer <PARTNER_API_KEY>`.

**Multiple creators:** one instance serves every creator listed in `ONLYCHAT_CREATOR_IDS`.
Add `?creator=<id>` to any `/funnel/*` data endpoint to target one; omit it to hit the first
configured creator. An unknown id returns `400 unknown_creator` (only configured ids are allowed).

### `GET /funnel/creators`
Lists the creators this instance serves, so the partner knows which `?creator=` values are valid.
```json
{
  "default": "cuid_aaa",
  "creators": [ { "id": "cuid_aaa", "label": "emy" }, { "id": "cuid_bbb", "label": "lina" } ]
}
```

### `GET /funnel/summary?days=30&creator=<id>`
```json
{
  "creator": "cuid_aaa",
  "window_days": 30,
  "totals": { "fans": 812, "arrived_in_window": 134, "active_in_window": 410, "replied": 356, "ai_enabled": 790 },
  "arrivals_by_day": [ { "date": "2026-06-01", "count": 7 } ],
  "arrival_coverage": "812/812",
  "generated_at": "2026-06-16T16:00:00Z"
}
```

### `GET /funnel/fans?days=30&page=0&size=50&creator=<id>`
```json
{
  "creator": "cuid_aaa",
  "data": [
    {
      "fan_id": "cmolsfo9p…", "telegram_fan_id": "6610147988",
      "name": "dripwave 💧", "username": "Dripwave88",
      "arrived_at": "2026-04-30T17:55:00Z", "last_interaction_at": "2026-04-30T17:59:50Z",
      "ai_enabled": true, "tags": ["vip"],
      "messages_sent": 0, "messages_total": 3,
      "script_progress": { "sent": 0, "total": 3 }
    }
  ],
  "total_count": 812, "page": 0, "size": 50
}
```

### `GET /funnel/match?phrases=<list>&days=7&creator=<id>`
Opener-phrase attribution **without exposing any message text**. The partner posts the phrase
pool they pre-filled into deep links (`?phrases=`, newline- or comma-separated); the proxy compares
each recently-arrived fan's *first* message against it **inside this server** and returns only
`fan_id ↔ phrase`. Lets the partner join a click to a fan without ever reading a DM. Always on
(it leaks no message bodies).
```json
{
  "creator": "…",
  "matches": [
    { "fan_id": "…", "telegram_fan_id": "…", "name": "…", "phrase": "lily 😊", "arrived_at": "2026-04-30T17:59:50Z" }
  ],
  "generated_at": "2026-06-30T12:00:00Z"
}
```

### `GET /funnel/revenue?creator=<id>` — **opt-in**
Per-fan star totals (the only money data the proxy surfaces), so the partner can fire revenue
events on a delta. **Disabled by default** (403) — the OnlyChat owner enables it with
`EXPOSE_REVENUE=true`. Still no message bodies / notes / phones.
```json
{
  "creator": "…",
  "data": [ { "fan_id": "…", "telegram_fan_id": "…", "total_stars": 120, "last_interaction_at": "2026-04-30T17:59:50Z" } ],
  "total_count": 1
}
```

### `GET /funnel/fans/:fanId/messages?page=0&size=20&creator=<id>` — **opt-in**
Conversation transcript for one fan, newest-first. **Disabled by default** (403) — the OnlyChat
owner enables it by setting `EXPOSE_MESSAGES=true` in `.env`, since DMs are the most sensitive data.
```json
{
  "fan": { "id": "…", "name": "…", "telegramFanId": "…" },
  "total_count": 3, "page": 0, "size": 20,
  "data": [
    { "id": "…", "text": "lily. u? 😊", "role": "creator", "ai_generated": true, "media_count": 0, "created_at": "2026-04-30T17:59:50Z" }
  ]
}
```

### `GET /health` → `{ "ok": true }` (no auth)

**Off by default** (owner opts in): conversation transcripts (`EXPOSE_MESSAGES=true`), per-fan
star totals (`EXPOSE_REVENUE=true`).
**Never exposed:** fan notes/personalInfo, phone numbers, your OnlyChat token, org/billing
endpoints, and any write/mutation. Widening further is a deliberate code change.

## How it works (and its limits)

- OnlyChat has **no arrival timestamp** and **no webhook**. Arrival is derived as the earliest
  message `createdAt` per fan (the fan row is created on first message), cached permanently in
  `.arrivals.json`. New fans/activity are picked up by polling — call `/summary` on a schedule.
- `/summary` warms the arrival cache up to `MAX_BACKFILL_PER_CALL` fans per call, so
  `arrived_in_window` / `replied` / `arrivals_by_day` reach full accuracy after the first few
  calls (`arrival_coverage` tells you where it's at), then stay exact.
- Upstream reads are memory-cached for `UPSTREAM_CACHE_TTL_MS` (60s default) so a partner
  hammering you can't hammer OnlyChat.
- **No purchases** on the Telegram side — OnlyChat doesn't expose monetization for TG fans.

## Expose it to the partner

- **Cloudflare Tunnel** (zero open ports): `cloudflared tunnel --url http://localhost:8787`
- or a small VPS behind HTTPS (Caddy/nginx).

Give the partner the **URL** + their **`PARTNER_API_KEY`**. Done.

## Security

- `.env` and `.arrivals.json` are git-ignored — never commit them, never send them.
- Prefer Mode B so a rotated OnlyChat token self-heals.
- Read-only by design; one key per partner; rotate by editing `.env` and restarting.
- HTTPS whenever it's reachable from the internet.

---

> The OnlyChat API is **undocumented / reverse-engineered**. Endpoints can change without
> notice; if something starts failing, re-capture from the browser before assuming a bug.
> MIT licensed — use at your own risk.
