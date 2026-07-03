# AI Marketing Consultant Brief — POC Notes

> **POC only — not for production.** Local demo of a GEO strategic brief generated
> **live** by the Adobe Marketing Agent, surfaced in the project-elmo-ui AI Marketing
> Consultant. Do not merge to `main`; revert the UI/local overrides before real use.

## What it does

Clicking **Generate Strategic Brief** in the consultant UI calls a local endpoint that
feeds the gathered Lovesac data (LLM Optimizer / Sites Optimizer / Semrush) to the real
**Adobe Marketing Agent**, which synthesizes findings + recommendations and returns them
in the UI's `{ briefSlides, briefSections }` shape.

- **Data = input** (the real Lovesac numbers we supply).
- **Findings, prioritization, wording, recommendations = the live agent's output.**

## Architecture / flow

```
UI (localhost:3000)  ──POST /sites/:siteId/marketing-consultant/brief──▶  backend (localhost:3002)
                                                                           │  build grounding prompt
                                                                           ▼
                                            Adobe Marketing Agent MCP (https://aep-ai-ama.adobe.io/mcp)
                                                                           │  synthesize brief
                                                                           ▼
                                       { briefSlides, briefSections, source:"live" } ──▶ rendered in UI
```

Confirmed live values: endpoint `https://aep-ai-ama.adobe.io/mcp`, tool
`adobe-marketing-agent-mcp-widget`, auth = an Adobe **IMS access token** (`client_id: exc_app`).
The MCP `tools/call` response nests the message JSON at
`result._meta['openai.com/widget'].resource.text` (parsed in `ama-client.js`).

## Backend (this repo — branch `poc/marketing-agent-brief`)

New files:
- `src/controllers/marketing-consultant.js` — endpoint controller
- `src/support/marketing-agent/ama-client.js` — minimal MCP client (initialize → tools/call, JSON+SSE)
- `src/support/marketing-agent/context-builder.js` — POC Lovesac data + prompt
- `src/support/marketing-agent/brief-adapter.js` — agent text → briefSlides/briefSections
- wired in `src/index.js` + `src/routes/index.js`; capability `site:read`

Run (Node 24):
```bash
nvm use 24
npm start          # serves http://localhost:3002
```

Local `.env` (gitignored) needs — start from `.env.example`, then add/override:
```
AMA_IMS_TOKEN=<Adobe IMS access token, exc_app; ~24h TTL>   # for the agent hop
AUTH_PUBLIC_KEY_B64=<ES256 SPKI pubkey base64>              # to verify caller JWTs (or use SKIP_AUTH)
POSTGREST_URL=http://localhost:9999                          # dummy; endpoint doesn't hit the DB
IMS_HOST / IMS_CLIENT_ID / IMS_CLIENT_CODE / IMS_CLIENT_SECRET = dummy
SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED / SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL = dummy
SCRAPE_JOB_CONFIGURATION / IMPORT_CONFIGURATION / API_KEY_CONFIGURATION = valid JSON (see .env.example)
ENABLE_CORS=true
CORS_ALLOWED_ORIGINS=https://localhost:3000
SKIP_AUTH=true      # LOCAL ONLY — bypasses caller auth; refuses to run in Lambda
```

Get an IMS token: from an authenticated experience.adobe.com session, DevTools → Network →
copy the `Authorization: Bearer …` from a `platform.adobe.io` / `aep-ai-ama` request.

## UI (project-elmo-ui — branch `coworker-integration`)

Run:
```bash
npm run dev:localapi   # serves https://localhost:3000
```

POC overrides (gitignored / revert before real use):
- `config/.env.local`: `IMS_ENV=prod` and `SPACECAT_URL=` (empty) → app + data + login use
  **prod**, so every page renders (no local DB needed).
- `src/api/marketingConsultantApi.ts`: `POC_LOCAL_BRIEF_BASE='http://localhost:3002'` →
  routes **only** the brief call to the local backend.

Key idea: **the whole app runs against prod; only the brief call goes to the local
live-agent backend** — sidesteps the local-database requirement.

Open:
```
https://localhost:3000/org/<orgId>/insights/ai-consultant-strategic
```
Log in (prod) → **Generate Strategic Brief** → live brief renders. Network shows
`POST http://localhost:3002/…/marketing-consultant/brief` → `200`, `source:"live"`.

## Verify it's a real live call

- Backend opens a live TLS connection to `aep-ai-ama.adobe.io` during the call.
- The Adobe endpoint requires a valid token: bad → `401`, real → `200`.
- `generatedAt` and wording change every call (not cached).
- Falsify: set `AMA_IMS_TOKEN` to garbage → brief returns `500` (agent 401). Restore → `200`.

Quick curl (SKIP_AUTH on, no token needed):
```bash
curl -sS -X POST \
  http://localhost:3002/sites/<any-uuid>/marketing-consultant/brief \
  -H "Content-Type: application/json" -d '{}' | jq -r '.briefSections[0].contentMarkdown'
```

## Caveats

- POC scope: brief only. Data Intelligence / Execution stay mocked.
- The POC context is static Lovesac data regardless of `siteId`.
- `.env` coverage excludes the POC files (see `.nycrc.json`); `c8 all:false`.
- IMS token expires (~24h) — refresh when the brief starts returning `500`.
