# GitHub Webhook Handler for Mysticat GitHub Service

- **Date:** 2026-04-22
- **Author:** Alexandru Ciobanasu
- **Status:** Draft
- **Jira:** SITES-42733
- **Target repo:** `adobe/spacecat-api-service`

## Context

The Mysticat GitHub Service is a GitHub App that orchestrates AI skills against GitHub events (starting with automated PR review). The service follows a webhook -> SQS -> Dispatcher -> ECS worker architecture. The infrastructure (SQS queues, Dispatcher Lambda, ECS cluster, DynamoDB idempotency table) is being built in [spacecat-infrastructure#469](https://github.com/adobe/spacecat-infrastructure/pull/469). The worker application code lives in [mysticat-github-service](https://github.com/adobe/mysticat-github-service).

This spec covers the `POST /webhooks/github` endpoint in spacecat-api-service that receives GitHub webhook events, validates the HMAC signature, applies trigger rules, and enqueues jobs to SQS.

### Specifications (authoritative)

- **Main spec** -- [Mysticat GitHub Service: Review Orchestrator](https://github.com/adobe/mysticat-architecture/blob/main/platform/ops/review-orchestrator.md)
- **Infrastructure spec** -- [Mysticat GitHub Service: Infrastructure Design](https://github.com/adobe/mysticat-architecture/blob/main/platform/ops/review-orchestrator-infrastructure.md)
- **Infrastructure PR** -- [spacecat-infrastructure#469](https://github.com/adobe/spacecat-infrastructure/pull/469)
- **Worker implementation** -- [mysticat-github-service](https://github.com/adobe/mysticat-github-service)

## Scope

### In scope

- OpenAPI contract for `POST /webhooks/github` (Phase 1 deliverable)
- HMAC-SHA256 webhook signature verification via custom auth handler
- Trigger rules applied from webhook payload only (Phase 2 -- no GitHub API calls)
- SQS job enqueue to `mysticat-github-service-jobs` queue
- Unit tests
- OpenAPI spec validation (`npm run docs:lint`)

### Out of scope

- Per-repo configuration reading (`.github/mysticat.yml`) -- deferred to Phase 3 (see Resolved Decisions)
- Auto-trigger events (`opened`, `ready_for_review`) -- deferred to Phase 3 (requires config reading)
- Deduplication -- owned by the worker via DynamoDB conditional write. Note: the parent architecture spec ([review-orchestrator.md](https://github.com/adobe/mysticat-architecture/blob/main/platform/ops/review-orchestrator.md), Section: Deduplication) still describes web-tier dedup via Check Run query. The infrastructure spec ([review-orchestrator-infrastructure.md](https://github.com/adobe/mysticat-architecture/blob/main/platform/ops/review-orchestrator-infrastructure.md), Section: Architecture Spec Amendments, item 4) explicitly removed this in favor of worker-level DynamoDB conditional write, citing TOCTOU race. The parent spec will be reconciled in a follow-up amendment.
- Integration tests -- no data access layer interaction
- Infrastructure changes -- covered in a separate spec at `spacecat-infrastructure/docs/plans/2026-04-22-github-webhook-infra-wiring.md`

## Implementation Phases

This is a single PR with phased implementation. Phase 1 is pushed first for team review of the API contract. Phase 2 implements the on-demand handler. Phase 3 (separate PR) adds config-aware behavior.

### Phase 1: OpenAPI Contract

Define the API contract in `docs/openapi/` and validate with `npm run docs:lint`.

**New file:** `docs/openapi/webhooks-api.yaml`

```yaml
github-webhook:
  post:
    tags:
      - hooks
    summary: Receive GitHub App webhook events
    description: |
      HMAC-SHA256 authenticated endpoint for receiving GitHub App webhook events.
      Validates the webhook signature, applies trigger rules, and enqueues
      accepted events to the Mysticat GitHub Service jobs queue.

      Authentication is performed via GitHub's HMAC-SHA256 webhook signature
      in the X-Hub-Signature-256 header, using a custom auth handler that
      plugs into the existing authHandlers array (not the standard JWT/IMS/API key flow).

      Trigger rules are applied from the webhook payload only (no GitHub API
      calls). On-demand triggers (review_requested, labeled) are accepted.
      Auto-trigger events (opened, ready_for_review) return 204 until
      per-repo configuration support is implemented in Phase 3.

      Supported events: pull_request. All other subscribed events (issue_comment)
      return 204 silently.
    operationId: processGitHubWebhook
    parameters:
      - name: X-Hub-Signature-256
        in: header
        required: true
        description: HMAC-SHA256 signature of the request body (format sha256=<hex>)
        schema:
          type: string
      - name: X-GitHub-Event
        in: header
        required: true
        description: GitHub event type (e.g. pull_request)
        schema:
          type: string
      - name: X-GitHub-Delivery
        in: header
        required: false
        description: Unique delivery GUID for tracing
        schema:
          type: string
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            description: GitHub webhook payload (schema owned by GitHub, not validated beyond required fields)
    responses:
      '202':
        description: Event accepted and enqueued for processing
        content:
          application/json:
            schema:
              $ref: './schemas.yaml#/WebhookAccepted'
      '204':
        description: Valid event but skipped (unsupported action, draft PR, bot author, etc.)
      '400':
        $ref: './responses.yaml#/400'
      '401':
        description: Invalid or missing HMAC signature
        content:
          application/json:
            schema:
              $ref: './schemas.yaml#/WebhookUnauthorized'
      '500':
        $ref: './responses.yaml#/500'
    security: []
```

**Additions to `docs/openapi/schemas.yaml`:**

```yaml
WebhookAccepted:
  type: object
  properties:
    status:
      type: string
      enum: [accepted]
  required: [status]

WebhookUnauthorized:
  type: object
  properties:
    message:
      type: string
  required: [message]
```

**Addition to `docs/openapi/api.yaml` paths:**

```yaml
/webhooks/github:
  $ref: './webhooks-api.yaml#/github-webhook'
```

Note: reuses the existing `hooks` tag (described as "Webhooks for receiving events" in `api.yaml`). No new tag needed.

**Validation gate:** `npm run docs:lint` passes.

### Phase 2: On-Demand Handler Implementation

After Phase 1 is reviewed and approved, implement the handler following the api-service's "Adding a New Endpoint" checklist from CLAUDE.md. This phase covers on-demand triggers only (`review_requested`, `labeled`). No GitHub API calls, no config reading.

#### HMAC Auth Handler

**New file:** `src/support/github-webhook-hmac-handler.js`

Custom auth handler extending `AbstractHandler` from `@adobe/spacecat-shared-http-utils`, plugged into the existing `authHandlers` array in `src/index.js` alongside `JwtHandler`, `AdobeImsHandler`, `ScopedApiKeyHandler`, `LegacyApiKeyHandler`, and `SkipAuthHandler`.

```javascript
import crypto from 'crypto';
import AbstractHandler from '@adobe/spacecat-shared-http-utils/src/auth/handlers/abstract.js';
import { AuthInfo } from '@adobe/spacecat-shared-http-utils';

const SIGNATURE_PATTERN = /^sha256=[a-f0-9]{64}$/;

class GitHubWebhookHmacHandler extends AbstractHandler {
  constructor(log) {
    super('github-webhook-hmac', log);
  }

  async checkAuth(request, context) {
    // Path-scoped: only handle /webhooks/* routes
    if (!context.pathInfo?.suffix?.startsWith('webhooks/')) {
      return null;
    }

    const signature = request.headers.get('x-hub-signature-256');

    // Not a GitHub webhook request -- let other handlers try
    if (!signature) {
      return null;
    }

    const secret = context.env?.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      this.log.error('GITHUB_WEBHOOK_SECRET not configured');
      return null;
    }

    // Validate signature format before timingSafeEqual (prevents throw on length mismatch)
    if (!SIGNATURE_PATTERN.test(signature)) {
      this.log.warn('Malformed X-Hub-Signature-256 header');
      return null;
    }

    // Read raw body from request. Note: bodyData middleware runs BEFORE
    // authWrapper in the .with() chain (last .with() = outermost = runs first),
    // so bodyData has already consumed the stream and set context.data.
    // request.text() returns the cached body via @adobe/helix-universal's
    // Request implementation. Verify this caching behavior before Phase 2
    // implementation (see Implementation Note below).
    const rawBody = await request.text();
    if (!rawBody) {
      this.log.warn('Empty request body for webhook');
      return null;
    }

    // Compute expected HMAC
    const expected = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')}`;

    // Timing-safe comparison (both are guaranteed 71 chars: "sha256=" + 64 hex)
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      this.log.warn('HMAC signature mismatch');
      return null;
    }

    // Stash raw body on context for controller use (e.g. logging, debugging).
    // context.data is already set by bodyData middleware; no need to parse again.
    context.rawBody = rawBody;

    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({ user_id: 'github-webhook' })
      .withType('github_webhook');
  }
}

export default GitHubWebhookHmacHandler;
```

**Key design points:**

- Path-scoped via `context.pathInfo.suffix` check -- only activates for `/webhooks/*` routes, preventing false matches on non-webhook requests that happen to carry an `X-Hub-Signature-256` header.
- `bodyData` middleware runs BEFORE `authWrapper` in the execution order (last `.with()` = outermost = runs first). The handler reads the body via `request.text()`, which returns the cached body from `@adobe/helix-universal`'s Request implementation. `context.data` is already populated by `bodyData`.
- Returns `null` (not a 401 response) on auth failure, so other auth handlers get a chance for non-webhook paths. The `authWrapper` returns 401 only if ALL handlers return null.
- Format validation (`SIGNATURE_PATTERN`) prevents `timingSafeEqual` from throwing on length mismatch or non-hex input.

**Implementation note (verify before Phase 2):** The handler relies on `request.text()` returning the cached body after `bodyData` has consumed the stream. This appears to work (precedent: `src/controllers/llmo/llmo.js` reads `context.request.arrayBuffer()` after `bodyData`), but is undocumented `@adobe/helix-universal` behavior. Before Phase 2 implementation, verify one of:
- (a) `request.text()` returns the cached body after `bodyData` consumption (read `@adobe/helix-universal`'s Request implementation), OR
- (b) Add a `rawBodyCapture` wrapper between `bodyData` and `authWrapper` in the `.with()` chain as insurance, OR
- (c) Reorder `authWrapper` after `bodyData` in the chain (check other auth handlers aren't affected).

**Registration in `src/index.js`:**

```javascript
const wrappedMain = wrap(run)
  .with(authWrapper, {
    authHandlers: [
      SkipAuthHandler,
      GitHubWebhookHmacHandler,  // <-- add here
      JwtHandler,
      AdobeImsHandler,
      ScopedApiKeyHandler,
      LegacyApiKeyHandler,
    ],
  })
```

#### Route Definition

**File:** `src/routes/index.js`

```javascript
'POST /webhooks/github': webhooksController.processGitHubWebhook,
```

#### Controller Wiring

**File:** `src/index.js`

Add `WebhooksController` instantiation alongside other controllers, and include it in the `getRouteHandlers()` call.

#### Controller

**New file:** `src/controllers/webhooks.js`

Factory function pattern, following the existing `hooks.js` controller:

```javascript
import { accepted, noContent, badRequest, internalServerError } from '@adobe/spacecat-shared-http-utils';
import wrap from '@adobe/helix-shared-wrap';
import { getSkipReason, EVENT_JOB_MAP } from '../utils/github-trigger-rules.js';

function WebhooksController(context) {
  const { sqs, log, env } = context;

  const processGitHubWebhook = wrap(async (ctx) => {
    const event = ctx.headers?.['x-github-event'];
    const deliveryId = ctx.headers?.['x-github-delivery'];
    const { data } = ctx;

    // Validate required payload fields
    if (!data?.action) {
      return badRequest('Missing required field: action');
    }
    if (!data?.installation?.id) {
      return badRequest('Missing required field: installation.id');
    }

    // Check event-to-job-type mapping
    const jobType = EVENT_JOB_MAP[event];
    if (!jobType) {
      log.info(`Skipping unmapped event: ${event}`, { deliveryId });
      return noContent();
    }

    const action = data.action;
    const pr = data.pull_request;

    // Apply trigger rules
    const skipReason = getSkipReason(data, action, env);
    if (skipReason) {
      log.info(`Skipping: ${skipReason}`, {
        deliveryId,
        event,
        action,
        owner: data.repository?.owner?.login,
        repo: data.repository?.name,
        prNumber: pr?.number,
      });
      return noContent();
    }

    // Build and enqueue job payload
    const jobPayload = {
      owner: data.repository.owner.login,
      repo: data.repository.name,
      event_type: event,
      event_action: action,
      event_ref: String(pr.number),
      installation_id: String(data.installation.id),
      delivery_id: deliveryId,
      job_type: jobType,
      workspace_repos: [
        'adobe/mysticat-architecture',
        'adobe/mysticat-ai-native-guidelines',
        'Adobe-AEM-Sites/aem-sites-architecture',
      ],
      retry_count: 0,
    };

    const queueUrl = env.MYSTICAT_GITHUB_JOBS_QUEUE_URL;
    await sqs.sendMessage(queueUrl, jobPayload);

    log.info(`Enqueued ${jobType} job`, {
      deliveryId,
      event,
      action,
      owner: jobPayload.owner,
      repo: jobPayload.repo,
      prNumber: pr.number,
      installationId: jobPayload.installation_id,
    });

    return accepted({ status: 'accepted' });
  })
    .with(errorHandler);

  return { processGitHubWebhook };
}

function errorHandler(fn) {
  return async (context) => {
    try {
      return await fn(context);
    } catch (e) {
      context.log.error('GitHub webhook handler error', e);
      return internalServerError('Internal error');
    }
  };
}

export default WebhooksController;
```

Note: no `.with(hmacAuth)` on the controller -- HMAC verification is handled by `GitHubWebhookHmacHandler` in the auth handler stack.

#### Event-to-Job-Type Mapping

**New file:** `src/utils/github-trigger-rules.js`

The parent architecture spec maintains a mapping of events to skills. This is captured as a named constant for extensibility:

```javascript
/**
 * Maps GitHub event types to job types for the Mysticat GitHub Service.
 * Today: pull_request -> pr-review.
 * Future: issues -> triage-issue, push -> changelog, etc.
 */
export const EVENT_JOB_MAP = {
  pull_request: 'pr-review',
};
```

#### Trigger Rules

**File:** `src/utils/github-trigger-rules.js`

Pure function, extracted for reusability and testability:

```javascript
export function getSkipReason(data, action, env) {
  const pr = data.pull_request;
  const appSlug = env.GITHUB_APP_SLUG || 'mysticat';

  // Unsupported actions (auto-triggers deferred to Phase 3)
  if (action === 'opened' || action === 'ready_for_review') {
    return `auto-trigger not yet supported: ${action}`;
  }

  // Invite-based trigger: reviewer must be the app
  if (action === 'review_requested') {
    const reviewer = data.requested_reviewer?.login;
    if (reviewer !== `${appSlug}[bot]`) {
      return `reviewer ${reviewer} is not ${appSlug}`;
    }
  }

  // Label-based trigger: label must match
  if (action === 'labeled') {
    const label = data.label?.name;
    if (label !== 'mysticat:review-requested') {
      return `label ${label} does not match trigger`;
    }
  }

  // Only review_requested and labeled are supported in Phase 2
  if (action !== 'review_requested' && action !== 'labeled') {
    return `unsupported action: ${action}`;
  }

  // Skip rules (defensive, even for on-demand triggers)
  if (pr?.draft) {
    return 'draft PR';
  }

  if (data.sender?.type === 'Bot') {
    return 'bot sender';
  }

  if (pr?.base?.ref !== data.repository?.default_branch) {
    return `non-default branch: ${pr?.base?.ref}`;
  }

  return null;
}
```

#### Environment Variables

| Variable | Purpose | Source |
|----------|---------|--------|
| `GITHUB_WEBHOOK_SECRET` | HMAC-SHA256 verification | Vault (`dx_mysticat/{env}/mysticat-github-service` key `github_app_webhook_secret`), delivered via Secrets Manager |
| `MYSTICAT_GITHUB_JOBS_QUEUE_URL` | SQS queue URL for job enqueue | Infrastructure module output (`module.mysticat_github_service.work_queue_url`) |
| `GITHUB_APP_SLUG` | App login for reviewer match (default: `mysticat`) | Environment variable or hardcoded |

#### Unit Tests

**New file:** `test/controllers/webhooks.test.js`

Test cases:

**HMAC auth handler (`test/support/github-webhook-hmac-handler.test.js`):**
- Valid signature returns AuthInfo with type `github_webhook`
- Invalid signature returns null (falls through to other handlers)
- Missing `X-Hub-Signature-256` header returns null
- Missing `GITHUB_WEBHOOK_SECRET` env var returns null
- `X-Hub-Signature-256` missing `sha256=` prefix returns null, not throw
- `X-Hub-Signature-256` wrong byte length returns null, not throw
- Empty request body returns null, not throw
- Signature computed over `JSON.stringify(data)` does NOT match signature over raw bytes (proves raw body capture works)
- Non-webhook path (`pathInfo.suffix` not starting with `webhooks/`) returns null without checking signature
- Stashes `context.rawBody` on success

**Trigger rules (`test/utils/github-trigger-rules.test.js`):**
- `pull_request.review_requested` with Mysticat as reviewer -> null (no skip)
- `pull_request.review_requested` with different reviewer -> skip reason
- `pull_request.labeled` with `mysticat:review-requested` -> null (no skip)
- `pull_request.labeled` with different label -> skip reason
- `pull_request.opened` -> skip reason (auto-trigger not supported)
- `pull_request.ready_for_review` -> skip reason (auto-trigger not supported)
- `pull_request.closed` -> skip reason (unsupported action)
- Draft PR -> skip reason
- Bot sender -> skip reason
- Non-default branch -> skip reason

**Controller (`test/controllers/webhooks.test.js`):**
- `pull_request.review_requested` with valid payload -> 202
- Non-pull_request event (e.g. `issues`) -> 204
- Missing `action` field returns 400 with field name in message
- Missing `installation.id` returns 400 with field name in message
- Job payload structure matches spec (owner, repo, event_type, event_action, event_ref, installation_id, delivery_id, job_type, workspace_repos, retry_count)
- `sqs.sendMessage` called with correct queue URL (`MYSTICAT_GITHUB_JOBS_QUEUE_URL`)
- `X-GitHub-Delivery` propagated to job payload as `delivery_id`
- SQS failure returns 500

#### Observability

**Structured log keys** (consistent across all log calls):

| Key | Present in | Purpose |
|-----|-----------|---------|
| `deliveryId` | All log lines | Cross-service tracing (GitHub delivery GUID) |
| `event` | Skip and enqueue logs | GitHub event type |
| `action` | Skip and enqueue logs | GitHub event action |
| `owner` | Skip and enqueue logs | Repository owner |
| `repo` | Skip and enqueue logs | Repository name |
| `prNumber` | Skip and enqueue logs | PR number |
| `skipReason` | Skip logs (in message) | Why the event was skipped |
| `installationId` | Enqueue logs | GitHub App installation ID |

Future: add CloudWatch custom metrics (accepted/skipped/rejected/5xx counts by action) when the observability module is extended for this service.

#### Validation Gates

- `npm run docs:lint` passes (Phase 1)
- `npm run docs:build` succeeds (Phase 2)
- `npm test` passes (Phase 2)
- `npm run lint` passes (Phase 2)

### Phase 3: Config-Aware Handler (separate PR)

This phase adds per-repo configuration reading, auto-triggers, and the `disabled` kill switch. Separate PR, separate spec.

**Scope:**
- Installation-token minting in the handler (using `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_ID` from Vault)
- Two-tier config cache: in-Lambda memory + DynamoDB table, invalidated on `push` events that touch `.github/mysticat.yml`, plus a 10-30 minute TTL safety net
- Auto-trigger support: `opened`, `ready_for_review` events accepted when repo config has `on_open: true` / `on_ready_for_review: true`
- Per-repo skip rule overrides (e.g. `skip_bots: false`)
- `disabled: true` kill switch -> 204
- Skill routing (`review.skill` config field)
- `workspace_repos` becomes centralized default with per-repo override (replacing the hardcoded list)
- `push` event subscription for config cache invalidation

**Additional environment variables (Phase 3):**

| Variable | Purpose | Source |
|----------|---------|--------|
| `GITHUB_APP_PRIVATE_KEY` | JWT generation for installation token minting | Vault (`dx_mysticat/{env}/mysticat-github-service`) via Secrets Manager |
| `GITHUB_APP_ID` | App ID for JWT generation | Vault (same path) via Secrets Manager |
| `MYSTICAT_CONFIG_CACHE_TABLE` | DynamoDB table name for config cache | Infrastructure module output |

**Additional infrastructure dependencies (Phase 3):**
- DynamoDB config-cache table (new resource in `spacecat-infrastructure`)

**Operational failure modes to address in Phase 3 spec:**
- Cache stampede: N concurrent cold-Lambda invocations all miss cache simultaneously and race to fetch config from GitHub
- DynamoDB provisioning: on-demand vs provisioned for the config cache table
- Installation-token caching: tokens are valid for 1 hour; sharing across concurrent Lambda invocations within the same container
- YAML parse errors in `.github/mysticat.yml`: behavior on malformed config (fall back to centralized defaults + post warning comment on PR)

## Resolved Decisions

### Per-repo configuration ownership

The handler owns per-repo config reading. The config is read from `.github/mysticat.yml` via GitHub API (using installation tokens minted from the app's private key), with a two-tier cache (in-Lambda memory + DynamoDB) invalidated on `push` events that touch the config file, plus a 10-30 minute TTL safety net.

This is deferred to Phase 3 to keep Phase 2 safe and shippable (on-demand triggers only, no auto-triggers, no config reading). Phase 2 uses hardcoded defaults. Phase 3 adds the config-aware behavior.

### Event allow-list

Today only `pull_request` is handled via the `EVENT_JOB_MAP` constant. All other subscribed events (`issue_comment`) return 204 silently. As the app grows (`push` for Phase 3 config invalidation, `issues` for triage), entries are added to `EVENT_JOB_MAP`.

## Infrastructure Dependencies

The following infrastructure changes are required before this handler can function. These are tracked in a separate spec at `spacecat-infrastructure/docs/plans/2026-04-22-github-webhook-infra-wiring.md`:

1. **SQS policy update** -- Add `mysticat-github-service-jobs` queue ARN to `api_lambda_sqs_policy` in `modules/iam/policies.tf`
2. **Environment variables** -- Add `GITHUB_WEBHOOK_SECRET`, `MYSTICAT_GITHUB_JOBS_QUEUE_URL`, and `GITHUB_APP_SLUG` to the api-service Lambda configuration
3. **Feature flag** -- Enable `enable_github_webhook_route = true` in the API Gateway module after the handler is deployed

Phase 3 additions:
4. **DynamoDB config-cache table** -- New table for per-repo config caching
5. **Additional secrets** -- `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_ID` from Vault via Secrets Manager
