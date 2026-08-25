---
ticket: LLMO-5566
repo: adobe/spacecat-api-service
branch: feature/LLMO-5566-cloudfront-log-delivery-assume-role
generated: 2026-06-26
revised: 2026-06-30
---

# Implementation Plan: CloudFront CDN Log Delivery (LLMO-5566)

> **Revised 2026-06-30.** `main` PR #2682 shipped the CloudFront onboarding wizard
> (`LlmoCloudFrontController`, `cdn-onboard/cloudfront/*`) while this branch was open, making this
> branch's parallel `edge-optimize/*` wizard redundant. This branch was reset onto `main` and
> rebuilt around the only net-new slice: **CloudWatch CDN log delivery**. The wizard endpoints and
> the org-scoped-externalId model from the original plan were dropped (main's per-session UUID
> externalId model wins).

## Problem Statement

SpaceCat's LLM Optimizer needs CDN access logs from customers' CloudFront distributions. There was
no automated way to configure cross-account CloudWatch Logs delivery from the customer's AWS account
into Adobe's `cdn-logs` S3 bucket. main's CloudFront onboarding wizard wires routing but does not
set up log delivery.

## Solution Overview

Add two endpoints to the existing `LlmoCloudFrontController`, reusing its connector-role flow:

1. `POST /sites/:siteId/llmo/cdn-onboard/cloudfront/log-delivery` — enable access-log forwarding for
   a single distribution (idempotent).
2. `POST /sites/:siteId/llmo/cdn-onboard/cloudfront/log-rescan` — idempotently enable forwarding for
   all distributions in the account (bounded concurrency), for recovery/re-scan.

The assume-role `externalId` is main's client-supplied per-session UUID
(`validateCloudfrontCredentials`). The delivery destination + source names are **org-scoped**,
derived server-side from the site's IMS org id (independent of the externalId). Both endpoints are
gated by `isLLMOAdministrator()` and registered in `INTERNAL_ROUTES` (not on the external FACS
surface).

## Key Files Changed vs main

| File | Change |
|------|--------|
| `src/controllers/llmo/llmo-cloudfront.js` | +2 methods: `enableCdnLogDelivery`, `rescanCdnLogDelivery` |
| `src/support/cdn-log-delivery.js` | CloudWatch Logs delivery-source + delivery creation (paginated, idempotent) |
| `src/routes/index.js` | +2 routes (`log-delivery`, `log-rescan`) |
| `src/routes/facs-capabilities.js`, `src/routes/required-capabilities.js` | register the 2 routes in INTERNAL_ROUTES |
| `docs/openapi/api.yaml`, `docs/openapi/llmo-api.yaml` | OpenAPI for the 2 endpoints |
| `package.json` | + `@aws-sdk/client-cloudwatch-logs` |
| `test/controllers/llmo/llmo-cloudfront.test.js` | unit tests for both endpoints |
| `test/support/cdn-log-delivery.test.js` | unit tests for the support module |

## Design Notes

- **No local `edge-optimize.js`** — the rescan lists distributions via tokowaka's
  `CloudFrontEdgeClient.listDistributions()`, already used by sibling endpoints.
- **Bounded concurrency** — rescan runs `createCdnLogDelivery` in batches of
  `CDN_LOG_RESCAN_CONCURRENCY` (5) to avoid CloudWatch Logs per-account throttling.
- **Error handling** — server misconfig (missing `CDN_LOG_DELIVERY_DEST_ACCOUNT_ID`) → 500;
  actionable AWS errors surface as 4xx via `mutationErrorResponse` (consistent with sibling
  endpoints); per-distribution failures report the AWS error *category* only (no raw messages/ARNs).

## Runtime Dependency (follow-up)

For log delivery to succeed, the connector role created by main's bootstrap CloudFormation template
(`customer-bootstrap-role.yaml`, S3-hosted) must grant `logs:PutDeliverySource`,
`logs:CreateDelivery`, `logs:GetDeliverySource`, `logs:DescribeDeliveries`. If main's template
predates log delivery, that template (and its `Metadata.AdobeLLMOptimizerPermissions` block) must be
updated — tracked separately from this code change.

## Acceptance Criteria

- Both endpoints reachable at the documented paths and gated by `isLLMOAdministrator()`
- Log delivery is idempotent (`{ alreadyExisted: true }` on repeat)
- Rescan respects the concurrency cap and never aborts on a single distribution failure
- Unit tests pass (`npm test`); OpenAPI validates (`npm run docs:lint`); route snapshot updated
