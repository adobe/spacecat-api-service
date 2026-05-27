# Multi-GitHub-Destination Web Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify each inbound GitHub webhook to a destination from its signed metadata and carry a non-secret `target_id` to the worker. Add a `GITHUB_TARGETS` registry (a JSON env var of `{id, match, appSlug, webhookSecretEnvVar}`). When it is configured, the HMAC handler parses the signed body, pre-filters non-github.com hosts (skip), classifies by `enterprise.slug` to a single candidate target, selects that target's webhook secret, and verifies HMAC **once** - attaching `target_id` + per-target `appSlug` to the auth profile. The controller puts `target_id` on the SQS payload and uses the per-target `appSlug` for trigger rules. When `GITHUB_TARGETS` is **unset**, the handler behaves exactly as today (single `GITHUB_WEBHOOK_SECRET`, no `target_id`).

**Architecture:** A new pure module `github-targets.js` holds the registry parse/validate + the classify truth table. The HMAC handler gains a registry path alongside a byte-for-byte-unchanged legacy path; the branch is chosen by whether `GITHUB_TARGETS` is set. Classification reads only the **signed** body (`enterprise.slug`, host of `repository.html_url`) - parsing before verifying is safe because a forged body merely selects a candidate whose secret it cannot forge, so the single HMAC check fails (401). The `target_id` and resolved `appSlug` flow handler -> controller via the `AuthInfo` profile (`context.attributes.authInfo.getProfile()`), the established pattern in this codebase. The secret boundary is preserved: the web tier holds only webhook secrets (named indirectly via `webhookSecretEnvVar`); app keys + PATs stay worker-only; only the non-secret `target_id` rides SQS.

**Tech Stack:** Node.js ESM, mocha + chai + sinon + esmock, c8. `@adobe/spacecat-shared-http-utils` `AuthInfo` / `AbstractHandler`. Tests: `npm test` (full); `npx mocha --reporter spec test/<file>` (targeted - picks up `test/setup-env.js` from the package.json `mocha` block).

**Source of truth:** ADR "Support Multiple GitHub Destinations in the Review Orchestrator" - https://github.com/adobe/mysticat-architecture/blob/main/platform/decisions/support-multiple-github-destinations.md (merged in PR #94). This plan is **migration step 1 (web half) + the step-2 registry cutover**. It depends on the worker plan (`mysticat-github-service/docs/plans/2026-05-27-multi-github-destination-worker.md`) landing first: the worker must already accept (and fall back without) `target_id` before the web tier emits it.

---

## Background: why this is correct (read once)

- **Only the body is HMAC-signed.** The classifier reads `enterprise.slug` (top-level; present when the org belongs to an enterprise account) and the host of `repository.html_url`, both from the signed body. The `X-GitHub-Enterprise-*` headers are unsigned and are **not** used.
- **Classify-then-verify-once is O(1) and safe.** Pick the single candidate target from metadata, then verify HMAC against that one secret. A forged body selects a candidate whose secret the attacker cannot forge -> verification fails -> 401. No trial-verify loop.
- **Truth table (ADR), in `classify`:**
  - host **positively** non-github.com (e.g. a `git.corp.adobe.com` GHES host) -> **skip + log, NO HMAC**. This pre-filter is handler-level, outside the registry. Do **not** add a "verify against all secrets" path for skipped requests.
  - `enterprise.slug` in an entry's `enterpriseSlug[]` -> that entry (e.g. `ghec`).
  - otherwise -> the `default: true` entry (`github-public`, the github.com catch-all, MUST be last).
- **A null/unknown host falls through to the catch-all, NOT to skip.** Non-PR events (notably the app-install `ping`) carry no `repository.html_url`, so host is `null`. Today those are HMAC-verified and the controller 204s them (unmapped event). Skipping a null host would 401 the ping handshake (red Xs in "Recent Deliveries"). So skip applies only to a **positively-identified** non-github.com host; `null` host is treated as github.com and hits the catch-all (verified against `GITHUB_WEBHOOK_SECRET`).
- **Returning `null` from `checkAuth` is the reject mechanism.** No handler authenticating -> 401. HMAC mismatch already returns `null` today; skip and classify-miss reuse it. This is intentional: a non-2xx is a visible failed delivery, never a silently-swallowed 204.
- **Web-side fallback mirrors the worker's flat-key fallback.** `GITHUB_TARGETS` unset -> verify against `GITHUB_WEBHOOK_SECRET` exactly as today and emit **no** `target_id`; the worker then resolves its flat keys. This keeps the new code a no-op until `GITHUB_TARGETS` is set, makes the rollout order-independent, and keeps every existing test green unchanged.
- **`AbstractHandler.log(message, level)` takes only two args** and interpolates `message` into the log line. The body is untrusted, so never interpolate body-derived values (host, slug) into a log message (log-injection). Use static messages.

## File Structure

All changes are in `spacecat-api-service`.

- **Create** `src/support/github-targets.js` - the registry: `parseTargets(env)` (parse + validate `GITHUB_TARGETS`, returns `null` in legacy mode), `classify({ host, enterpriseSlug }, targets)` (truth table), `extractClassificationMetadata(rawBody)` (safe JSON parse -> `{ host, enterpriseSlug }` or `null`). Pure, dependency-free.
- **Modify** `src/support/github-webhook-hmac-handler.js` - add the registry path (classify, select secret, verify once, attach `target_id`/`app_slug`); keep the legacy path unchanged; factor the body read + size-cap into a private helper used by both.
- **Modify** `src/utils/github-trigger-rules.js` - `getSkipReason(data, action, env, appSlug = env.GITHUB_APP_SLUG)`: `appSlug` becomes a defaulted 4th param (no signature break for the existing 3-arg callers).
- **Modify** `src/controllers/webhooks.js` - read `target_id`/`app_slug` from the auth profile; resolve `appSlug = profileAppSlug || env.GITHUB_APP_SLUG`; turn the `GITHUB_APP_SLUG` config check into "no app slug resolved"; pass `appSlug` to `getSkipReason`; add `target_id` to the SQS payload when present.
- **Create** `test/support/github-targets.test.js`.
- **Modify** `test/support/github-webhook-hmac-handler.test.js`, `test/controllers/webhooks.test.js`, `test/utils/github-trigger-rules.test.js`.

---

## Task 1: `github-targets.js` registry + classifier (pure)

**Files:**
- Create: `src/support/github-targets.js`
- Test: `test/support/github-targets.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/support/github-targets.test.js`:

```js
/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect } from 'chai';
import { parseTargets, classify, extractClassificationMetadata } from '../../src/support/github-targets.js';

const VALID_TARGETS = JSON.stringify([
  { id: 'ghec', match: { enterpriseSlug: ['adobe-prd'] }, appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET_GHEC' },
  { id: 'github-public', match: { default: true }, appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET' },
]);

describe('github-targets parseTargets', () => {
  it('returns null when GITHUB_TARGETS is unset (legacy mode signal)', () => {
    expect(parseTargets({})).to.be.null;
  });

  it('parses a valid registry into an ordered array', () => {
    const targets = parseTargets({ GITHUB_TARGETS: VALID_TARGETS });
    expect(targets).to.have.length(2);
    expect(targets[0].id).to.equal('ghec');
    expect(targets[1].id).to.equal('github-public');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTargets({ GITHUB_TARGETS: 'not json' })).to.throw('not valid JSON');
  });

  it('throws when not a non-empty array', () => {
    expect(() => parseTargets({ GITHUB_TARGETS: '{}' })).to.throw('non-empty JSON array');
    expect(() => parseTargets({ GITHUB_TARGETS: '[]' })).to.throw('non-empty JSON array');
  });

  it('throws on duplicate ids', () => {
    const dup = JSON.stringify([
      { id: 'x', match: { enterpriseSlug: ['a'] }, appSlug: 's', webhookSecretEnvVar: 'V' },
      { id: 'x', match: { default: true }, appSlug: 's', webhookSecretEnvVar: 'W' },
    ]);
    expect(() => parseTargets({ GITHUB_TARGETS: dup })).to.throw('duplicate id');
  });

  it('throws when an entry is missing appSlug or webhookSecretEnvVar', () => {
    const noSlug = JSON.stringify([{ id: 'github-public', match: { default: true }, webhookSecretEnvVar: 'V' }]);
    expect(() => parseTargets({ GITHUB_TARGETS: noSlug })).to.throw('appSlug');
    const noSecret = JSON.stringify([{ id: 'github-public', match: { default: true }, appSlug: 's' }]);
    expect(() => parseTargets({ GITHUB_TARGETS: noSecret })).to.throw('webhookSecretEnvVar');
  });

  it('throws when an entry has neither default nor a non-empty enterpriseSlug', () => {
    const bad = JSON.stringify([{ id: 'x', match: {}, appSlug: 's', webhookSecretEnvVar: 'V' }]);
    expect(() => parseTargets({ GITHUB_TARGETS: bad })).to.throw('match.default');
  });

  it('throws when the default entry is not last', () => {
    const defaultFirst = JSON.stringify([
      { id: 'github-public', match: { default: true }, appSlug: 's', webhookSecretEnvVar: 'V' },
      { id: 'ghec', match: { enterpriseSlug: ['a'] }, appSlug: 's', webhookSecretEnvVar: 'W' },
    ]);
    expect(() => parseTargets({ GITHUB_TARGETS: defaultFirst })).to.throw('must be last');
  });

  it('throws when there is not exactly one default', () => {
    const noDefault = JSON.stringify([{ id: 'ghec', match: { enterpriseSlug: ['a'] }, appSlug: 's', webhookSecretEnvVar: 'V' }]);
    expect(() => parseTargets({ GITHUB_TARGETS: noDefault })).to.throw('exactly one');
  });
});

describe('github-targets extractClassificationMetadata', () => {
  it('returns null for non-JSON', () => {
    expect(extractClassificationMetadata('not json')).to.be.null;
  });

  it('extracts host and enterpriseSlug from a github.com enterprise body', () => {
    const body = JSON.stringify({
      enterprise: { slug: 'adobe-prd' },
      repository: { html_url: 'https://github.com/Adobe-AEM-Sites/aem-sites-architecture' },
    });
    expect(extractClassificationMetadata(body)).to.deep.equal({ host: 'github.com', enterpriseSlug: 'adobe-prd' });
  });

  it('returns host=null when repository.html_url is absent (e.g. ping)', () => {
    const body = JSON.stringify({ zen: 'Keep it simple', hook_id: 1 });
    expect(extractClassificationMetadata(body)).to.deep.equal({ host: null, enterpriseSlug: null });
  });

  it('returns host of a non-github.com html_url', () => {
    const body = JSON.stringify({ repository: { html_url: 'https://git.corp.adobe.com/experience-platform/mystique' } });
    expect(extractClassificationMetadata(body).host).to.equal('git.corp.adobe.com');
  });
});

describe('github-targets classify', () => {
  const targets = parseTargets({ GITHUB_TARGETS: VALID_TARGETS });

  it('skips a positively non-github.com host', () => {
    expect(classify({ host: 'git.corp.adobe.com', enterpriseSlug: null }, targets)).to.deep.equal({ skip: true });
  });

  it('routes an EMU enterprise slug to ghec', () => {
    expect(classify({ host: 'github.com', enterpriseSlug: 'adobe-prd' }, targets).id).to.equal('ghec');
  });

  it('routes a github.com body with no enterprise to github-public (catch-all)', () => {
    expect(classify({ host: 'github.com', enterpriseSlug: null }, targets).id).to.equal('github-public');
  });

  it('routes a github.com body with a NON-EMU enterprise slug to github-public', () => {
    expect(classify({ host: 'github.com', enterpriseSlug: 'some-other-enterprise' }, targets).id).to.equal('github-public');
  });

  it('routes a null host (ping / no repository) to github-public, NOT skip', () => {
    expect(classify({ host: null, enterpriseSlug: null }, targets).id).to.equal('github-public');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx mocha --reporter spec test/support/github-targets.test.js`
Expected: FAIL - `Cannot find module '../../src/support/github-targets.js'`.

- [ ] **Step 3: Implement `github-targets.js`**

Create `src/support/github-targets.js`:

```js
/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// GitHub destination registry + classifier. The web tier classifies each
// inbound webhook to a destination ("target") from the SIGNED body, so the
// worker can select per-destination credentials by a non-secret target_id.
// Secrets are NOT in this registry: webhookSecretEnvVar names the env var that
// carries the secret (injected from the deploy secret store).

/**
 * Parse + validate the GITHUB_TARGETS env var.
 * @param {object} env - context.env
 * @returns {Array|null} ordered target array, or null when GITHUB_TARGETS is
 *   unset (legacy single-secret mode).
 * @throws {Error} when GITHUB_TARGETS is set but structurally invalid.
 */
export function parseTargets(env) {
  const raw = env?.GITHUB_TARGETS;
  if (!raw) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`GITHUB_TARGETS is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('GITHUB_TARGETS must be a non-empty JSON array');
  }
  const ids = new Set();
  parsed.forEach((t, i) => {
    if (!t || typeof t.id !== 'string' || !t.id) {
      throw new Error(`GITHUB_TARGETS[${i}] is missing a string "id"`);
    }
    if (ids.has(t.id)) {
      throw new Error(`GITHUB_TARGETS has duplicate id "${t.id}"`);
    }
    ids.add(t.id);
    if (typeof t.appSlug !== 'string' || !t.appSlug) {
      throw new Error(`GITHUB_TARGETS["${t.id}"] is missing a string "appSlug"`);
    }
    if (typeof t.webhookSecretEnvVar !== 'string' || !t.webhookSecretEnvVar) {
      throw new Error(`GITHUB_TARGETS["${t.id}"] is missing a string "webhookSecretEnvVar"`);
    }
    const isDefault = t.match?.default === true;
    const hasSlugs = Array.isArray(t.match?.enterpriseSlug) && t.match.enterpriseSlug.length > 0;
    if (!isDefault && !hasSlugs) {
      throw new Error(`GITHUB_TARGETS["${t.id}"] needs match.default:true or a non-empty match.enterpriseSlug[]`);
    }
    if (isDefault && i !== parsed.length - 1) {
      throw new Error(`GITHUB_TARGETS default entry "${t.id}" must be last`);
    }
  });
  const defaults = parsed.filter((t) => t.match?.default === true);
  if (defaults.length !== 1) {
    throw new Error(`GITHUB_TARGETS must have exactly one match.default:true entry (found ${defaults.length})`);
  }
  return parsed;
}

function hostOf(htmlUrl) {
  if (typeof htmlUrl !== 'string') {
    return null;
  }
  try {
    return new URL(htmlUrl).host;
  } catch {
    return null;
  }
}

/**
 * Extract the classification signals from the raw (signed) webhook body.
 * @param {string} rawBody
 * @returns {{host: (string|null), enterpriseSlug: (string|null)}|null} null when
 *   the body is not valid JSON.
 */
export function extractClassificationMetadata(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const enterpriseSlug = typeof payload.enterprise?.slug === 'string' ? payload.enterprise.slug : null;
  return { host: hostOf(payload.repository?.html_url), enterpriseSlug };
}

/**
 * Classify webhook metadata to a target, or signal skip.
 * @param {{host: (string|null), enterpriseSlug: (string|null)}} meta
 * @param {Array} targets - validated registry (default entry last)
 * @returns {object|{skip: true}} the matched target, or { skip: true }
 */
export function classify(meta, targets) {
  const { host, enterpriseSlug } = meta;
  // A positively-identified non-github.com host (e.g. a GHES host) has no
  // in-scope target. A null/unknown host (ping / no repository) falls through
  // to the github.com catch-all.
  if (host !== null && host !== 'github.com') {
    return { skip: true };
  }
  const match = targets.find((t) => t.match?.default === true
    || (enterpriseSlug
        && Array.isArray(t.match?.enterpriseSlug)
        && t.match.enterpriseSlug.includes(enterpriseSlug)));
  return match || { skip: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx mocha --reporter spec test/support/github-targets.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/support/github-targets.js test/support/github-targets.test.js
git commit -m "feat(webhooks): add GitHub destination registry + classifier"
```

---

## Task 2: HMAC handler registry path (classify -> select secret -> verify once)

**Files:**
- Modify: `src/support/github-webhook-hmac-handler.js`
- Test: `test/support/github-webhook-hmac-handler.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/support/github-webhook-hmac-handler.test.js` (inside the top-level `describe`, after the existing tests):

```js
  describe('GITHUB_TARGETS registry path', () => {
    const ghecSecret = 'ghec-webhook-secret';
    const TARGETS = JSON.stringify([
      { id: 'ghec', match: { enterpriseSlug: ['adobe-prd'] }, appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET_GHEC' },
      { id: 'github-public', match: { default: true }, appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET' },
    ]);
    const publicBody = JSON.stringify({ action: 'review_requested', installation: { id: 1 }, repository: { html_url: 'https://github.com/adobe/spacecat-api-service' } });
    const ghecBody = JSON.stringify({ action: 'review_requested', installation: { id: 1 }, enterprise: { slug: 'adobe-prd' }, repository: { html_url: 'https://github.com/Adobe-AEM-Sites/aem-sites-architecture' } });
    const ghesBody = JSON.stringify({ action: 'review_requested', installation: { id: 1 }, repository: { html_url: 'https://git.corp.adobe.com/experience-platform/mystique' } });
    const pingBody = JSON.stringify({ zen: 'Keep it simple', hook_id: 1 });

    function registryContext(extraEnv = {}) {
      return makeContext({
        env: {
          GITHUB_TARGETS: TARGETS,
          GITHUB_WEBHOOK_SECRET: secret,
          GITHUB_WEBHOOK_SECRET_GHEC: ghecSecret,
          ...extraEnv,
        },
      });
    }

    it('authenticates a github.com (default) webhook and attaches target_id github-public', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(publicBody, secret) }, publicBody);
      const result = await handler.checkAuth(request, registryContext());
      expect(result).to.not.be.null;
      expect(result.type).to.equal('github_webhook');
      expect(result.getProfile().target_id).to.equal('github-public');
      expect(result.getProfile().app_slug).to.equal('mysticat-bot');
    });

    it('authenticates a GHEC webhook against the per-target secret and attaches target_id ghec', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(ghecBody, ghecSecret) }, ghecBody);
      const result = await handler.checkAuth(request, registryContext());
      expect(result).to.not.be.null;
      expect(result.getProfile().target_id).to.equal('ghec');
    });

    it('rejects a GHEC body signed with the github-public secret (wrong secret)', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(ghecBody, secret) }, ghecBody);
      const result = await handler.checkAuth(request, registryContext());
      expect(result).to.be.null;
      expect(mockLog.warn.calledWithMatch('HMAC signature mismatch')).to.be.true;
    });

    it('skips (null) a non-github.com host without computing HMAC', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(ghesBody, secret) }, ghesBody);
      const result = await handler.checkAuth(request, registryContext());
      expect(result).to.be.null;
      expect(mockLog.warn.calledWithMatch('Skipping webhook')).to.be.true;
    });

    it('treats a ping (no repository -> null host) as github-public, not skip', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(pingBody, secret) }, pingBody);
      const result = await handler.checkAuth(request, registryContext());
      expect(result).to.not.be.null;
      expect(result.getProfile().target_id).to.equal('github-public');
    });

    it('returns null + error on malformed GITHUB_TARGETS', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(publicBody, secret) }, publicBody);
      const result = await handler.checkAuth(request, registryContext({ GITHUB_TARGETS: 'not json' }));
      expect(result).to.be.null;
      expect(mockLog.error.calledWithMatch('Invalid GITHUB_TARGETS')).to.be.true;
    });

    it('returns null + error when the selected target secret env var is unset', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(ghecBody, ghecSecret) }, ghecBody);
      const result = await handler.checkAuth(request, registryContext({ GITHUB_WEBHOOK_SECRET_GHEC: undefined }));
      expect(result).to.be.null;
      expect(mockLog.error.calledWithMatch('misconfigured=true')).to.be.true;
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx mocha --reporter spec test/support/github-webhook-hmac-handler.test.js`
Expected: the new `registry path` cases FAIL (no `target_id` on the profile; non-github host is currently HMAC-verified, not skipped). The pre-existing cases still PASS.

- [ ] **Step 3: Implement the registry path (replace the file body)**

Replace the entire contents of `src/support/github-webhook-hmac-handler.js` with:

```js
/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import crypto from 'crypto';
import AbstractHandler from '@adobe/spacecat-shared-http-utils/src/auth/handlers/abstract.js';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { parseTargets, classify, extractClassificationMetadata } from './github-targets.js';

const SIGNATURE_PATTERN = /^sha256=[a-f0-9]{64}$/;
const WEBHOOK_PATH_PATTERN = /^\/?webhooks\//;
// Real GitHub webhook payloads are typically under 100 KB; GitHub caps at 25 MB.
// Reject larger bodies before HMAC computation to prevent pre-auth resource exhaustion.
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

// Timing-safe HMAC compare. Both buffers are 71 chars ("sha256=" + 64 hex):
// SIGNATURE_PATTERN guaranteed the input length and the HMAC hex is fixed-length,
// so timingSafeEqual will not throw on a length mismatch.
function verifySignature(signature, rawBody, secret) {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

class GitHubWebhookHmacHandler extends AbstractHandler {
  constructor(log) {
    super('github-webhook-hmac', log);
  }

  // Read the raw body and enforce the 1 MiB cap. Returns the raw string, or null
  // (already logged) on empty / oversized. Two-tier: a Content-Length precheck
  // (honest-client-only; attacker can omit the header) then the post-read byte
  // length (the real enforcement). request.text() returns the cached body.
  async readBodyWithLimits(request) {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      this.log(`Payload too large: ${contentLength} bytes`, 'warn');
      return null;
    }
    const rawBody = await request.text();
    if (!rawBody) {
      this.log('Empty request body for webhook', 'warn');
      return null;
    }
    const byteLength = Buffer.byteLength(rawBody, 'utf8');
    if (byteLength > MAX_BODY_BYTES) {
      this.log(`Payload too large after read: ${byteLength} bytes`, 'warn');
      return null;
    }
    return rawBody;
  }

  async checkAuth(request, context) {
    // Path-scoped: only handle /webhooks/* routes. Tolerate suffix with or
    // without leading slash (production sets it with leading slash).
    if (!WEBHOOK_PATH_PATTERN.test(context.pathInfo?.suffix || '')) {
      return null;
    }

    const signature = request.headers.get('x-hub-signature-256');
    // Not a GitHub webhook request -- let other handlers try
    if (!signature) {
      return null;
    }
    // Validate signature format FIRST: structural check, no I/O, no config.
    // Runs before any secret/registry work to prevent error-log amplification on
    // pre-auth malformed requests, and before timingSafeEqual to avoid a throw.
    if (!SIGNATURE_PATTERN.test(signature)) {
      this.log('Malformed X-Hub-Signature-256 header', 'warn');
      return null;
    }

    const targetsRaw = context.env?.GITHUB_TARGETS;

    // ---- Legacy path: no registry configured -> today's exact behaviour ----
    // Single GITHUB_WEBHOOK_SECRET, no target_id. The secret presence is checked
    // BEFORE reading the body, preserving the early-bail.
    if (!targetsRaw) {
      const secret = context.env?.GITHUB_WEBHOOK_SECRET;
      if (!secret) {
        this.log('GITHUB_WEBHOOK_SECRET not configured (misconfigured=true)', 'error');
        return null;
      }
      const rawBody = await this.readBodyWithLimits(request);
      if (rawBody === null) {
        return null;
      }
      if (!verifySignature(signature, rawBody, secret)) {
        this.log('HMAC signature mismatch', 'warn');
        return null;
      }
      return new AuthInfo()
        .withAuthenticated(true)
        .withProfile({ user_id: 'github-webhook' })
        .withType('github_webhook');
    }

    // ---- Registry path: classify from the SIGNED body, select the candidate ----
    // target's secret, verify HMAC once. Parsing before verifying is safe: a
    // forged body just selects a candidate whose secret it cannot forge.
    let targets;
    try {
      targets = parseTargets(context.env);
    } catch (e) {
      // Malformed registry is a misconfiguration; null -> 401 (visible failed
      // delivery), matching the missing-secret handling above.
      this.log(`Invalid GITHUB_TARGETS config (misconfigured=true): ${e.message}`, 'error');
      return null;
    }
    const rawBody = await this.readBodyWithLimits(request);
    if (rawBody === null) {
      return null;
    }
    const meta = extractClassificationMetadata(rawBody);
    if (meta === null) {
      this.log('Webhook body is not valid JSON', 'warn');
      return null;
    }
    const result = classify(meta, targets);
    // host not an in-scope GitHub destination (e.g. a GHES host): skip + log, NO
    // HMAC. The body is untrusted, so do not interpolate meta.host into the log.
    if (result.skip) {
      this.log('Skipping webhook: host is not an in-scope GitHub destination', 'warn');
      return null;
    }
    const secret = context.env?.[result.webhookSecretEnvVar];
    if (!secret) {
      this.log(`Webhook secret for target ${result.id} not configured (misconfigured=true)`, 'error');
      return null;
    }
    if (!verifySignature(signature, rawBody, secret)) {
      this.log('HMAC signature mismatch', 'warn');
      return null;
    }
    return new AuthInfo()
      .withAuthenticated(true)
      .withProfile({ user_id: 'github-webhook', target_id: result.id, app_slug: result.appSlug })
      .withType('github_webhook');
  }
}

export default GitHubWebhookHmacHandler;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx mocha --reporter spec test/support/github-webhook-hmac-handler.test.js`
Expected: PASS - the new registry cases AND every pre-existing case (the legacy path is byte-for-byte unchanged behaviourally).

- [ ] **Step 5: Commit**

```bash
git add src/support/github-webhook-hmac-handler.js test/support/github-webhook-hmac-handler.test.js
git commit -m "feat(webhooks): classify destination + verify per-target secret in HMAC handler"
```

---

## Task 3: per-target `appSlug` in trigger rules

**Files:**
- Modify: `src/utils/github-trigger-rules.js:31-35`
- Test: `test/utils/github-trigger-rules.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/utils/github-trigger-rules.test.js` (inside the existing top-level `describe`):

```js
  it('uses the explicit appSlug arg over env.GITHUB_APP_SLUG when provided', () => {
    // A ghec target whose appSlug differs from env.GITHUB_APP_SLUG: the explicit
    // arg must form the expected bot reviewer login.
    const data = {
      pull_request: { draft: false, base: { ref: 'main' } },
      requested_reviewer: { login: 'ghec-bot[bot]' },
      repository: { default_branch: 'main' },
      sender: { type: 'User' },
    };
    const env = { GITHUB_APP_SLUG: 'mysticat' };
    // Without the override, expected reviewer is mysticat[bot] -> would skip.
    expect(getSkipReason(data, 'review_requested', env)).to.match(/is not mysticat\[bot\]/);
    // With the override, expected reviewer is ghec-bot[bot] -> matches -> null.
    expect(getSkipReason(data, 'review_requested', env, 'ghec-bot')).to.be.null;
  });
```

(Ensure `getSkipReason` is imported in this file - it already is for the existing tests.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha --reporter spec test/utils/github-trigger-rules.test.js`
Expected: FAIL on the override case - `getSkipReason` ignores the 4th arg today and uses `env.GITHUB_APP_SLUG` (`mysticat`), so the `ghec-bot[bot]` reviewer does not match and it returns a skip reason instead of `null`.

- [ ] **Step 3: Implement the defaulted param**

In `src/utils/github-trigger-rules.js`, change the signature and drop the internal `appSlug` lookup:

```js
export function getSkipReason(data, action, env, appSlug = env.GITHUB_APP_SLUG) {
  const pr = data.pull_request;
  // appSlug is resolved by the caller: the per-target appSlug in registry mode,
  // else env.GITHUB_APP_SLUG (the default). Used to form the expected bot
  // reviewer login. Defaulting keeps existing 3-arg callers unchanged.
```

Delete the old line:

```js
  const appSlug = env.GITHUB_APP_SLUG;
```

Update the JSDoc to document the new param:

```js
 * @param {object} env - Environment variables
 * @param {string} [appSlug] - Allowed-bot slug; defaults to env.GITHUB_APP_SLUG
 * @returns {string|null} Skip reason or null
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx mocha --reporter spec test/utils/github-trigger-rules.test.js`
Expected: PASS - the new override test passes and every existing 3-arg test still passes (the default reproduces today's behaviour).

- [ ] **Step 5: Commit**

```bash
git add src/utils/github-trigger-rules.js test/utils/github-trigger-rules.test.js
git commit -m "feat(webhooks): accept per-target appSlug in getSkipReason"
```

---

## Task 4: controller emits `target_id` + uses per-target `appSlug`

**Files:**
- Modify: `src/controllers/webhooks.js:88-116,142-143,204-216`
- Test: `test/controllers/webhooks.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/controllers/webhooks.test.js` (inside the top-level `describe`):

```js
  describe('multi-destination target_id', () => {
    function ghecAuthContext() {
      // Mirrors what the HMAC handler attaches in registry mode.
      return {
        ...validContext,
        attributes: {
          authInfo: { getProfile: () => ({ user_id: 'github-webhook', target_id: 'ghec', app_slug: 'mysticat-bot' }) },
        },
        data: {
          ...validContext.data,
          requested_reviewer: { login: 'mysticat-bot[bot]' },
        },
      };
    }

    it('adds target_id from the auth profile to the SQS payload', async () => {
      const response = await controller.processGitHubWebhook(ghecAuthContext());
      expect(response.status).to.equal(202);
      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload.target_id).to.equal('ghec');
    });

    it('uses the per-target app_slug for the reviewer check (mysticat-bot[bot])', async () => {
      // env.GITHUB_APP_SLUG is 'mysticat', but the profile app_slug is
      // 'mysticat-bot'; the requested reviewer mysticat-bot[bot] must match and
      // the job must enqueue (not skip).
      const response = await controller.processGitHubWebhook(ghecAuthContext());
      expect(response.status).to.equal(202);
      expect(mockSqs.sendMessage.calledOnce).to.be.true;
    });

    it('omits target_id when no auth profile target_id is present (legacy)', async () => {
      const response = await controller.processGitHubWebhook(validContext);
      expect(response.status).to.equal(202);
      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload).to.not.have.property('target_id');
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx mocha --reporter spec test/controllers/webhooks.test.js`
Expected: the `adds target_id` and per-target `app_slug` cases FAIL - the controller does not read the profile, does not emit `target_id`, and gates the reviewer on `env.GITHUB_APP_SLUG` (`mysticat`), so `mysticat-bot[bot]` would be skipped, not enqueued. The `omits target_id` legacy case PASSES.

- [ ] **Step 3: Implement the controller changes**

In `src/controllers/webhooks.js`, at the start of the `processGitHubWebhook` body, after reading `event`/`deliveryId`/`data`, add the profile read:

```js
    const event = ctx.pathInfo?.headers?.['x-github-event'];
    const deliveryId = ctx.pathInfo?.headers?.['x-github-delivery'];
    const { data } = ctx;

    // Destination resolved by the HMAC handler (registry mode). Legacy mode has
    // no profile target_id/app_slug -> fall back to env.GITHUB_APP_SLUG and emit
    // no target_id (worker then resolves its flat keys).
    const profile = ctx.attributes?.authInfo?.getProfile?.() || {};
    const targetId = profile.target_id;
    const appSlug = profile.app_slug || env.GITHUB_APP_SLUG;
```

Replace the `GITHUB_APP_SLUG` config check:

```js
    if (!env.GITHUB_APP_SLUG) {
      log.error('GITHUB_APP_SLUG not configured', { deliveryId });
      return internalServerError('GITHUB_APP_SLUG not configured');
    }
```

with:

```js
    // Security-relevant: which bot can trigger automated runs. In registry mode
    // this comes from the target's appSlug; in legacy mode from env. A missing
    // value must be a 5xx (GitHub retries) rather than a 204 (delivery lost).
    if (!appSlug) {
      log.error('No app slug resolved (GITHUB_APP_SLUG unset and no target app_slug)', { deliveryId });
      return internalServerError('app slug not configured');
    }
```

Pass `appSlug` to `getSkipReason`:

```js
    const skipReason = getSkipReason(data, action, env, appSlug);
```

Add `target_id` to the job payload (only when present, so legacy messages are byte-identical):

```js
    const jobPayload = {
      owner: data.repository.owner.login,
      repo: data.repository.name,
      event_type: event,
      event_action: action,
      event_ref: String(pr.number),
      installation_id: String(data.installation.id),
      delivery_id: deliveryId,
      job_type: jobType,
      workspace_repos: workspaceRepos,
      retry_count: 0,
      ...(targetId ? { target_id: targetId } : {}),
      ...(observability ? { observability } : {}),
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx mocha --reporter spec test/controllers/webhooks.test.js`
Expected: PASS - new target_id cases pass; all pre-existing cases pass (no `attributes` -> empty profile -> `appSlug = env.GITHUB_APP_SLUG = 'mysticat'`, no `target_id`).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/webhooks.js test/controllers/webhooks.test.js
git commit -m "feat(webhooks): carry target_id to SQS and use per-target appSlug"
```

---

## Final validation gate (run before opening the PR)

- [ ] **Lint:** `npm run lint` - PASS.
- [ ] **Full suite:** `npm test` - PASS, no new skips. Mirrors CI.
- [ ] **Legacy path untouched behaviourally:** the pre-existing `github-webhook-hmac-handler.test.js`, `webhooks.test.js`, and `github-trigger-rules.test.js` cases all pass without edits to their existing assertions (only additive new cases). Confirms the `GITHUB_TARGETS`-unset path is a no-op refactor.
- [ ] **Secret boundary:** `git grep -n "app_private_key\|github_pat\|installation/.*access_tokens" src/` returns nothing in `spacecat-api-service` - the web tier never handles app keys or PATs.

---

## Migration, Secrets & Rollout

This plan is the web half of **migration step 1** plus the **step-2 registry cutover** of the ADR's additive-then-cutover path. Cross-repo ordering (the hard constraint): the worker plan's Vault `targets["github-public"]` + worker deploy must land **before** this web tier emits `target_id="github-public"`.

### New env vars

| Var | Secret? | Scope | Set when |
|-----|---------|-------|----------|
| `GITHUB_TARGETS` | No (JSON registry) | All envs | Step 2 (registry cutover) |
| `GITHUB_WEBHOOK_SECRET_GHEC` | **Yes** | Envs serving GHEC | GHEC cutover only |

`GITHUB_WEBHOOK_SECRET` and `GITHUB_APP_SLUG` are unchanged. All of these are injected through the existing secret store via `npm run deploy-secrets` (`hedy --aws-update-secrets --params-file=secrets/secrets.env`, the same store that already provides `GITHUB_WEBHOOK_SECRET` / `GITHUB_APP_SLUG`). `GITHUB_TARGETS` is non-secret but rides the same channel.

### Rollout sequence

1. **Deploy code with `GITHUB_TARGETS` unset (all envs).** Legacy path: no behaviour change, no `target_id`. **Validation:** trigger a dev PR review - it posts; inspect the SQS message (or the `Enqueued webhook job` log) and confirm **no** `target_id`; existing skip/auth behaviour unchanged.
2. **Set `GITHUB_TARGETS` (per env), `github-public` only.** Precondition: the worker's Vault `targets["github-public"]` exists in that env (worker plan). Value:
   ```json
   [{ "id": "github-public", "match": { "default": true }, "appSlug": "mysticat", "webhookSecretEnvVar": "GITHUB_WEBHOOK_SECRET" }]
   ```
   (Use the env's real `GITHUB_APP_SLUG` value as `appSlug` - e.g. `mysticat-bot-dev` in dev.) Deploy / update secrets. **Validation:** trigger a dev PR review; confirm the SQS message now carries `target_id: "github-public"`; confirm the review still posts (worker resolves `targets["github-public"]`); watch the **skip-and-log rate and per-target auth-failure rate** (ADR success metric) - both flat.
3. **GHEC cutover (gated, separate change).** Preconditions (ADR): the EMU enterprise slug is known; the `ghec` app + PAT + webhook secret are provisioned (worker Vault `targets["ghec"]` added; `GITHUB_WEBHOOK_SECRET_GHEC` set). Insert the `ghec` rule **ahead of** the catch-all:
   ```json
   [
     { "id": "ghec", "match": { "enterpriseSlug": ["<EMU-enterprise-slug>"] }, "appSlug": "mysticat-bot", "webhookSecretEnvVar": "GITHUB_WEBHOOK_SECRET_GHEC" },
     { "id": "github-public", "match": { "default": true }, "appSlug": "mysticat", "webhookSecretEnvVar": "GITHUB_WEBHOOK_SECRET" }
   ]
   ```
   **Validation:** a PR in a GHEC EMU org is reviewed under the ghec identity; a github-public PR is unaffected.

### Validation: GITHUB_TARGETS ↔ worker Vault pairing

The web tier validates only its **own** registry structure (`parseTargets`). It cannot see the worker's Vault `targets` (secret boundary). The pairing - every `GITHUB_TARGETS` id has a complete worker `targets[id]` - is enforced **operationally** (a migration checklist item: add the worker Vault entry before adding the `GITHUB_TARGETS` rule) and **at runtime** (the worker raises `PermanentError` "No complete credentials for target_id" and the per-target auth-failure alert fires - ADR pre-mortem mitigation). Add a dev smoke test after any registry change: confirm a PR for each configured target gets reviewed.

### Rollback

Within the window, rolling back `GITHUB_TARGETS` (unset it) returns the handler to the legacy path - no `target_id` emitted - and the worker's flat-key fallback still resolves in-flight messages. Safe.

---

## Self-Review

- **Spec coverage (ADR Next Step 1 + classifier/schema + step 1-2 migration):** registry parse/validate + classify truth table incl. host pre-filter and null-host catch-all (Task 1); classify-then-verify-once with per-target secret + `target_id`/`app_slug` on the profile + legacy fallback (Task 2); per-target `appSlug` (Tasks 3-4); `target_id` on SQS (Task 4); secret injection + ordering + validation (Migration). Covered.
- **Type consistency:** the registry entry shape `{ id, match:{ default | enterpriseSlug[] }, appSlug, webhookSecretEnvVar }` is identical across `parseTargets`, `classify`, the handler (`result.id`, `result.appSlug`, `result.webhookSecretEnvVar`), and all fixtures. The profile shape `{ user_id, target_id, app_slug }` set in Task 2 is exactly what Task 4 reads (`profile.target_id`, `profile.app_slug`). `getSkipReason(data, action, env, appSlug)` (Task 3) is called with `appSlug` in Task 4.
- **No placeholders:** every step has runnable code and exact `npx mocha` / `npm` commands with expected outcomes. `<EMU-enterprise-slug>` appears only in the gated GHEC migration step, where the ADR designates it a cutover precondition (not a code value).
- **Additivity guard:** `GITHUB_TARGETS` unset -> legacy path; all existing tests pass without edits to their assertions (Task 2/3/4 Step 4 + final gate). The ping/null-host case (Task 1 + Task 2) prevents an install-handshake regression.
