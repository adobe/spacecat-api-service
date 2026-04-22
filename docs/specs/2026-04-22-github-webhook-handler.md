# GitHub Webhook Handler for Mysticat GitHub Service

- **Date:** 2026-04-22
- **Author:** Alexandru Ciobanasu
- **Status:** Draft
- **Jira:** SITES-42733
- **Target repo:** `adobe/spacecat-api-service`

## Context

The Mysticat GitHub Service is a GitHub App that orchestrates AI skills against GitHub events (starting with automated PR review). The service follows a webhook -> SQS -> Dispatcher -> ECS worker architecture. The infrastructure (SQS queues, Dispatcher Lambda, ECS cluster, DynamoDB idempotency table) is being built in [spacecat-infrastructure#469](https://github.com/adobe/spacecat-infrastructure/pull/469). The worker application code lives in [mysticat-github-service](https://github.com/adobe/mysticat-github-service).

This spec covers the missing piece: the `POST /webhooks/github` endpoint in spacecat-api-service that receives GitHub webhook events, validates the HMAC signature, applies trigger rules, and enqueues jobs to SQS.

### Specifications (authoritative)

- **Main spec** -- [Mysticat GitHub Service: Review Orchestrator](https://github.com/adobe/mysticat-architecture/blob/main/platform/ops/review-orchestrator.md)
- **Infrastructure spec** -- [Mysticat GitHub Service: Infrastructure Design](https://github.com/adobe/mysticat-architecture/blob/main/platform/ops/review-orchestrator-infrastructure.md)
- **Infrastructure PR** -- [spacecat-infrastructure#469](https://github.com/adobe/spacecat-infrastructure/pull/469)
- **Worker implementation** -- [mysticat-github-service](https://github.com/adobe/mysticat-github-service)

## Scope

### In scope

- OpenAPI contract for `POST /webhooks/github` (Phase 1 deliverable)
- HMAC-SHA256 webhook signature verification
- Trigger rules applied from webhook payload only (no GitHub API calls)
- SQS job enqueue to `mysticat-github-service-jobs` queue
- Unit tests
- OpenAPI spec validation (`npm run docs:lint`)

### Out of scope

- Per-repo configuration reading (`.github/mysticat.yml`) -- requires GitHub API access the handler does not have
- Auto-trigger events (`opened`, `ready_for_review`) -- deferred until config reading is implemented
- Deduplication -- owned by the worker via DynamoDB conditional write
- Integration tests -- no data access layer interaction
- Infrastructure changes -- covered in a separate spec for spacecat-infrastructure

## Implementation Phases

This is a single PR with two phases. Phase 1 is pushed first for team review of the API contract before proceeding to Phase 2.

### Phase 1: OpenAPI Contract

Define the API contract in `docs/openapi/` and validate with `npm run docs:lint`.

**New file:** `docs/openapi/webhooks-api.yaml`

```yaml
github-webhook:
  post:
    tags:
      - webhooks
    summary: Receive GitHub App webhook events
    description: |
      HMAC-SHA256 authenticated endpoint for receiving GitHub App webhook events.
      Validates the webhook signature, applies trigger rules, and enqueues
      accepted events to the Mysticat GitHub Service jobs queue.

      This endpoint bypasses the standard authentication middleware.
      Authentication is performed via GitHub's HMAC-SHA256 webhook signature
      in the X-Hub-Signature-256 header.

      Trigger rules are applied from the webhook payload only (no GitHub API
      calls). On-demand triggers (review_requested, labeled) are accepted.
      Auto-trigger events (opened, ready_for_review) return 204 until
      per-repo configuration support is implemented.
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

**Addition to `docs/openapi/api.yaml` tags:**

```yaml
- name: webhooks
  description: GitHub App webhook endpoints
```

**Validation gate:** `npm run docs:lint` passes.

### Phase 2: Implementation

After Phase 1 is reviewed and approved, implement the handler following the api-service's "Adding a New Endpoint" checklist from CLAUDE.md.

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
import { accepted, noContent, badRequest, unauthorized, internalServerError } from '@adobe/spacecat-shared-http-utils';
import { wrap } from '@adobe/spacecat-shared-utils';

function WebhooksController(context) {
  const { sqs, log, env } = context;

  const processGitHubWebhook = wrap(async (ctx) => {
    const event = ctx.headers?.['x-github-event'];
    const deliveryId = ctx.headers?.['x-github-delivery'];
    const { data } = ctx;

    // Validate required payload fields
    if (!data?.action || !data?.installation?.id) {
      return badRequest('Missing required payload fields');
    }

    // Only handle pull_request events
    if (event !== 'pull_request') {
      log.info(`Skipping non-pull_request event: ${event}`, { deliveryId });
      return noContent();
    }

    const action = data.action;
    const pr = data.pull_request;

    // Apply trigger rules
    const skipReason = getSkipReason(data, action, env);
    if (skipReason) {
      log.info(`Skipping: ${skipReason}`, { deliveryId, action });
      return noContent();
    }

    // Build and enqueue job payload
    const jobPayload = {
      owner: data.repository.owner.login,
      repo: data.repository.name,
      event_type: 'pull_request',
      event_action: action,
      event_ref: String(pr.number),
      installation_id: String(data.installation.id),
      job_type: 'pr-review',
      workspace_repos: [
        'adobe/mysticat-architecture',
        'adobe/mysticat-ai-native-guidelines',
        'Adobe-AEM-Sites/aem-sites-architecture',
      ],
      retry_count: 0,
    };

    const queueUrl = env.MYSTICAT_JOBS_QUEUE_URL;
    await sqs.sendMessage(queueUrl, jobPayload);

    log.info(`Enqueued pr-review job for ${jobPayload.owner}/${jobPayload.repo}#${pr.number}`, {
      deliveryId,
      action,
    });

    return accepted({ status: 'accepted' });
  })
    .with(errorHandler)
    .with(hmacAuth, { secretEnvVar: 'GITHUB_WEBHOOK_SECRET' });

  return { processGitHubWebhook };
}
```

#### HMAC Verification Wrapper

Defined in `src/controllers/webhooks.js` (or extracted to `src/support/hmac-auth.js` if reuse is needed):

```javascript
import crypto from 'crypto';

function hmacAuth(fn, opts) {
  return async (context) => {
    const signature = context.headers?.['x-hub-signature-256'];
    const secret = context.env[opts.secretEnvVar];

    if (!signature || !secret) {
      return unauthorized('Invalid signature');
    }

    // Access raw body for HMAC computation
    const rawBody = context.rawBody || JSON.stringify(context.data);
    const expected = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex')}`;

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return unauthorized('Invalid signature');
    }

    return fn(context);
  };
}
```

**Raw body access:** The handler needs the raw (unparsed) request body for HMAC verification. API Gateway HTTP API with `payload_format_version = "2.0"` provides the raw body. Need to verify how the `bodyData` middleware handles this -- if it only provides parsed `context.data`, we may need to preserve `context.rawBody` from the Lambda event before parsing. This is a Phase 2 implementation detail to investigate.

#### Trigger Rules

```javascript
function getSkipReason(data, action, env) {
  const pr = data.pull_request;
  const appSlug = env.GITHUB_APP_SLUG || 'mysticat';

  // Unsupported actions (auto-triggers deferred)
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

  // Only review_requested and labeled are supported
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

#### Error Handler Wrapper

```javascript
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
```

#### Authentication Bypass

The `/webhooks/github` route must bypass the standard auth middleware (JWT, IMS, API key). HMAC verification replaces standard auth. This needs to be handled in `src/index.js` where the auth middleware is applied -- either by adding the path to an auth bypass list or by handling it before the auth middleware runs.

#### Environment Variables

| Variable | Purpose | Source |
|----------|---------|--------|
| `GITHUB_WEBHOOK_SECRET` | HMAC-SHA256 verification | Populated from Secrets Manager (sourced from Vault) |
| `MYSTICAT_JOBS_QUEUE_URL` | SQS queue URL for job enqueue | Infrastructure module output |
| `GITHUB_APP_SLUG` | App login for reviewer match (default: `mysticat`) | Environment variable or hardcoded |

#### Unit Tests

**New file:** `test/controllers/webhooks.test.js`

Test cases:

**HMAC validation:**
- Valid signature passes through to handler
- Invalid signature returns 401
- Missing signature header returns 401
- Missing webhook secret env var returns 401
- Timing-safe comparison (no timing oracle)

**Trigger rules:**
- `pull_request.review_requested` with Mysticat as reviewer -> 202
- `pull_request.review_requested` with different reviewer -> 204
- `pull_request.labeled` with `mysticat:review-requested` -> 202
- `pull_request.labeled` with different label -> 204
- `pull_request.opened` -> 204 (auto-trigger not supported)
- `pull_request.ready_for_review` -> 204 (auto-trigger not supported)
- `pull_request.closed` -> 204 (unsupported action)
- Non-pull_request event (e.g. `issues`) -> 204
- Draft PR -> 204
- Bot sender -> 204
- Non-default branch -> 204

**SQS enqueue:**
- Job payload structure matches spec (owner, repo, event_type, event_action, event_ref, installation_id, job_type, workspace_repos, retry_count)
- `sqs.sendMessage` called with correct queue URL
- SQS failure returns 500

**Payload validation:**
- Missing `action` field returns 400
- Missing `installation.id` returns 400

#### Validation Gates

- `npm run docs:lint` passes (Phase 1)
- `npm run docs:build` succeeds (Phase 2)
- `npm test` passes (Phase 2)
- `npm run lint` passes (Phase 2)

## Open Questions

### Per-repo configuration ownership

The architecture spec places trigger rules and per-repo config reading (`.github/mysticat.yml`) in the "web tier" (this handler). The infrastructure spec simplified the Dispatcher to a thin SQS-to-RunTask bridge with no GitHub API access. The worker is also deliberately simple -- it runs what it's told.

Currently, per-repo configuration (auto-trigger opt-in, skip rule overrides, `disabled` kill switch, skill routing) is **unowned** -- neither the handler, the Dispatcher, nor the worker reads `.github/mysticat.yml`.

For Phase 1, the handler applies default skip rules from the webhook payload (draft, bot, non-default branch). Per-repo config, kill switch, and auto-triggers are deferred. When implemented, this will likely require either:
- Giving the handler a way to read config (cached GitHub API access or config registry)
- Adding a pre-flight step in the worker before running the skill
- A separate config-reading service

This should be resolved before Phase 3 (high-volume repos) of the rollout plan.

## Infrastructure Dependencies

The following infrastructure changes are required before this handler can function. These are tracked in a separate spec at `spacecat-infrastructure/docs/plans/`:

1. **SQS policy update** -- Add `mysticat-github-service-jobs` queue ARN to `api_lambda_sqs_policy` in `modules/iam/policies.tf`
2. **Environment variables** -- Add `GITHUB_WEBHOOK_SECRET` and `MYSTICAT_JOBS_QUEUE_URL` to the api-service Lambda configuration
3. **Feature flag** -- Enable `enable_github_webhook_route = true` in the API Gateway module after the handler is deployed
