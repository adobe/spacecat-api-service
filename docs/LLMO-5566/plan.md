---
ticket: LLMO-5566
repo: adobe/spacecat-api-service
branch: feature/LLMO-5566-cloudfront-log-delivery-assume-role
generated: 2026-06-26
---

# Implementation Plan: Automate CloudFront CDN Log Delivery with AssumeRole Setup (LLMO-5566)

## Problem Statement

SpaceCat's LLM Optimizer needs CDN access logs from customers' CloudFront distributions to power
traffic-analysis features. Previously there was no automated way to configure CloudWatch Logs
cross-account delivery from the customer's AWS account into Adobe's cdn-logs S3 bucket. Customers
also needed a guided wizard to wire up the prerequisite CloudFront configuration (origins, cache
behaviors, Lambda@Edge routing function).

## Solution Overview

Two parallel workstreams:

1. **CloudFront Edge Optimize Wizard** (15 endpoints) — an LLMO-admin-facing step-by-step wizard
   that connects to the customer's AWS account via an assumed-role (STS AssumeRole) and configures
   CloudFront distributions for edge optimization. Each step is a discrete, idempotent POST endpoint.

2. **CDN Log Delivery** (1 endpoint) — `POST /sites/:siteId/llmo/cdn-log-delivery` uses the same
   connector role to create a CloudWatch Logs delivery-source in the customer's account and link it
   to Adobe's cross-account delivery-destination, enabling automatic CDN access-log forwarding.

Both workstreams are gated by `isLLMOAdministrator()` and categorized as `INTERNAL_ROUTES` in the
FACS hybrid permission model (not surfaced on the external customer FACS API).

## Key Files Changed vs main

| File | Change |
|------|--------|
| `src/controllers/llmo/llmo.js` | +811 lines — 15 wizard endpoints + 1 CDN log delivery endpoint |
| `src/support/edge-optimize.js` | +1346 lines — CloudFront SDK operations (AssumeRole, origins, behaviors, Lambda@Edge) |
| `src/support/cdn-log-delivery.js` | +178 lines — CloudWatch Logs delivery-source + delivery creation |
| `src/routes/index.js` | +16 routes (15 wizard + cdn-log-delivery) |
| `src/routes/facs-capabilities.js` | +18 lines — routes registered in INTERNAL_ROUTES |
| `src/routes/required-capabilities.js` | +16 lines — routes registered in INTERNAL_ROUTES (S2S system) |
| `docs/openapi/llmo-api.yaml` | +1089 lines — full OpenAPI spec for all 16 new endpoints |
| `test/controllers/llmo/llmo.test.js` | +1595 lines — unit tests for all endpoints |
| `test/support/edge-optimize.test.js` | +1421 lines — unit tests for edge-optimize support layer |
| `test/support/cdn-log-delivery.test.js` | +182 lines — unit tests for CDN log delivery support |
| `test/e2e/llmo-cdn-log-delivery.e2e.js` | +476 lines — 4-tier e2e test suite |

## Auth and Permission Model

- All 16 endpoints require a valid SpaceCat session (JWT, IMS, or API key)
- `gateEdgeOptimizeWizard()` in `llmo.js` enforces: site must exist + user has site access +
  `isLLMOAdministrator()` flag
- Routes are in `INTERNAL_ROUTES` (not `PRODUCTS_ROUTES`) — they are not part of the external
  FACS customer permission surface

## E2E Test Strategy

Four tiers based on credential availability:

- **Tier 1** (always run): Input validation — 400 for missing/invalid body fields
- **Tier 2** (always run): Auth gate — 403 when called with a non-LLMO-admin API key
- **Tier 3** (LLMO_ADMIN_API_KEY required): Response shape — soft-fail AWS calls return
  `{connected: false}` / `{checks: [{name, ok}]}`
- **Tier 4** (LLMO_ADMIN_API_KEY + TEST_AWS_ACCOUNT_ID + TEST_EXTERNAL_ID + TEST_DISTRIBUTION_ID):
  Full AWS integration — real AssumeRole + distributions/origins/behaviors listing +
  cdn-log-delivery idempotency

## Acceptance Criteria

- All 15 wizard endpoints + cdn-log-delivery reachable at correct paths
- All routes properly gated by `isLLMOAdministrator()`
- CDN log delivery is idempotent (returns `{alreadyExisted: true}` on repeat calls)
- FACS coverage invariant passes (`test/routes/facs-capabilities.test.js` — 26/26)
- Unit tests pass (`npm test`)
- OpenAPI spec validates (`npm run docs:lint`)
