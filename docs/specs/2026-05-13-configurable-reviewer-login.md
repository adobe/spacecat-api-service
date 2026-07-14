# Configurable Reviewer Login for GitHub Webhook Trigger

- **Date:** 2026-05-13
- **Author:** Alexandru Ciobanasu
- **Status:** Draft
- **Jira:** SITES-42733
- **Target repo:** `adobe/spacecat-api-service`

## Context

The Mysticat GitHub Service posts AI-powered PR reviews to GitHub. The identity that appears as the reviewer is determined by which credentials the worker uses. Currently the worker uses a Personal Access Token (PAT) stored in Vault; the review is posted as whoever owns that PAT.

During initial setup the PAT belonged to an individual engineer, so reviews appeared under their personal account. Going forward the PAT will belong to a **Generic User Account** (`aighagent@adobe.com`) — a shared, non-personal identity managed via CyberArk.

The webhook trigger rule in `spacecat-api-service` currently gates on `requested_reviewer.login === "${GITHUB_APP_SLUG}[bot]"`. Since `aighagent` is a plain GitHub user (not a GitHub App bot), this check will never match and no reviews will be triggered.

This spec covers making the reviewer login configurable via a new env var so the trigger rule can match either a bot account or a plain user account without code changes per deployment.

## Scope

### In scope

- New optional env var `GITHUB_REVIEWER_LOGIN` — used directly when set; falls back to `${GITHUB_APP_SLUG}[bot]` when absent (backward compatibility)
- Update `getSkipReason` in `src/utils/github-trigger-rules.js` to use the resolved login
- Unit tests covering both code paths

### Out of scope

- Changes to the worker (`mysticat-github-service`) — idempotency check update is a separate PR in that repo
- Vault or infrastructure changes — `GITHUB_REVIEWER_LOGIN` is wired as an env var via existing Vault/ECS mechanisms
- Per-repo configuration (`.github/mysticat.yml`) — deferred to Phase 3 as before

## Design

### New env var: `GITHUB_REVIEWER_LOGIN`

| Property | Value |
|---|---|
| Name | `GITHUB_REVIEWER_LOGIN` |
| Required | No |
| Default | `${GITHUB_APP_SLUG}[bot]` |
| Example (bot) | `mysticat-bot-dev[bot]` (implicit via `GITHUB_APP_SLUG=mysticat-bot-dev`) |
| Example (user) | `aighagent` |

When `GITHUB_REVIEWER_LOGIN` is set it takes full precedence — `GITHUB_APP_SLUG` is still required (security gate in controller) but is not used for the reviewer check when `GITHUB_REVIEWER_LOGIN` is set.

### Behaviour change in `getSkipReason`

```
Before: reviewer !== `${appSlug}[bot]`
After:  reviewer !== (env.GITHUB_REVIEWER_LOGIN?.trim() || `${appSlug}[bot]`)
```

The skip reason message is updated to show the resolved login, not the raw slug.

### Deployment

For `aighagent` setup: add `GITHUB_REVIEWER_LOGIN=aighagent` to Vault at `dx_mysticat/{env}/api-service`. No other changes needed.

For existing GitHub App bot deployments: omit `GITHUB_REVIEWER_LOGIN` entirely — the `[bot]` suffix is still appended automatically.

## Validation Gates

- `npm test` passes with no changes to existing test expectations for the `[bot]` default path
- New tests explicitly cover the `GITHUB_REVIEWER_LOGIN` override path
- `npm run lint` clean
