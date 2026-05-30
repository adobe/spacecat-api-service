I have everything I need. Key findings to ground the plan:

- The ESLint config uses `@adobe/eslint-config-helix` (airbnb-based). `for...of` over `Object.entries(...)` is used freely in `src/support/` (e.g. `audit-target-urls-validation.js:141`, `ephemeral-run-service.js:499`), and `Object.entries(...).forEach(...)` is also common (`customer-config-mapper.js`). The airbnb `no-restricted-syntax` rule does flag bare `for...in`/`for...of` in some helix presets, so to be safe I'll use `Object.entries(...).forEach(...)` / `.find(...)` / `.filter(...)` (functional style, definitely lint-clean and matching the existing `classify`/`parseTargets` style which uses `.forEach`/`.find`/`.filter`).
- The `default:true` "exactly one" validation in legacy `parseTargets` uses `.filter(...).length`. I'll mirror that.
- Test command for a single file: `npx mocha test/path -g 'pattern'`. Full suite: `npm test`. Lint: `npm run lint`.
- The handler imports `parseTargets, classify, extractClassificationMetadata` from `./github-targets.js`. I'll add `parseDestinations` and `classifyDestination` to the same module and import them.

The plan is complete in my analysis. Here is the deliverable.

---

# Consolidated Destinations Registry (Web Tier, Phase 1 — Dual-Read) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dual-read path to the web tier so it can classify inbound GitHub webhooks from a single consolidated `GITHUB_DESTINATIONS` registry (a JSON-string object keyed by `target_id`, with inline `webhook_secret` and `reviewer_login` in snake_case), while leaving the existing `GITHUB_TARGETS` array path fully intact as the fallback when `GITHUB_DESTINATIONS` is unset. No behaviour change while Vault holds only the legacy shape; the legacy path is removed by a separate later cleanup PR (out of scope here).

**Architecture:** The web tier classifies each signed webhook to a destination ("target") in `GitHubWebhookHmacHandler.checkAuth`, selects that destination's webhook secret, and verifies HMAC once before attaching identity to the auth profile, which `WebhooksController` then reads. Today the handler reads `GITHUB_TARGETS` (an ordered array; `parseTargets` validates `appSlug` + `webhookSecretEnvVar` indirection + per-entry `reviewerLogin`) and `classify` evaluates it default-last. This change adds two new functions to the same `github-targets.js` module — `parseDestinations(env)` (parses/validates the keyed `GITHUB_DESTINATIONS` object) and `classifyDestination(meta, destinations)` (match-type-priority: enterprise entries before the single `default:true` entry) — and a new branch at the top of `checkAuth`: when `GITHUB_DESTINATIONS` is set, classify on it, select the matched entry's **inline** `webhook_secret`, HMAC-verify once, and attach `{ target_id, reviewer_login }` to the profile. When `GITHUB_DESTINATIONS` is absent, control flows into the unchanged `GITHUB_TARGETS` / legacy-`GITHUB_WEBHOOK_SECRET` branches exactly as today. `WebhooksController` already resolves `reviewerLogin = profile.reviewer_login || env.GITHUB_REVIEWER_LOGIN`; on the new path the profile always carries `reviewer_login`, so the global fallback is naturally bypassed, while the legacy path keeps it. The SQS payload `target_id` plumbing is untouched (it already reads `profile.target_id`). `getSkipReason` is not modified — it already accepts `reviewerLogin` as its 5th param.

**Tech Stack:** Node.js >=24 (ESM), Mocha 11 (`--parallel`, config inline in `package.json`), Chai 6 `expect`, Sinon 22 (sandboxes), `esmock` for module mocks, c8 coverage, ESLint 9 (`@adobe/eslint-config-helix`). `npm test` runs `c8 --skip-full mocha --parallel --timeout 10000 -i -g 'Post-Deploy' --spec=test/**/*.test.js --ignore=test/it/**`.

**Spec:** mysticat-architecture/platform/decisions/consolidated-destinations-registry.md (ADR; supersedes per-target-reviewer-login.md and amends the schema sections of support-multiple-github-destinations.md / #94). This PR implements **Phase 1 — Web dual-read only** (ADR Migration step 1; Validation Phase 1 — Code). The cleanup PR (removing `GITHUB_TARGETS`/`webhookSecretEnvVar`/`appSlug`/globals + the `${appSlug}[bot]` fallback), the Vault backfill (ops), the worker tier, and `api_host` are all explicitly out of scope.

**Plan location:** docs/plans/2026-05-30-consolidated-destinations-registry-web.md

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/support/github-targets.js` | modify | Add `parseDestinations(env)` — reads `env.GITHUB_DESTINATIONS`, JSON-parses to an object keyed by `target_id`, validates each entry (`target_id` key charset; `match` is exactly one of `default:true` or a non-empty `enterprise_slug` string array; exactly one `default:true` entry in the registry; non-empty `webhook_secret`; `reviewer_login` charset/length), returns `null` when unset. Add `classifyDestination(meta, destinations)` — host pre-filter unchanged, then enterprise-slug match, then the single `default:true` entry, else `{ skip: true }`. Leave `parseTargets`/`classify`/`extractClassificationMetadata`/`hostOf` unchanged. |
| `test/support/github-targets.test.js` | modify | Add `describe('github-targets parseDestinations', ...)` (valid parse; null when unset; invalid JSON; not-an-object; bad `target_id` key; `match` both/neither; zero/>1 `default`; empty `webhook_secret`; missing/bad/too-long `reviewer_login`) and `describe('github-targets classifyDestination', ...)` (non-github.com host -> skip; EMU slug -> ghec; plain github.com no-enterprise -> default; non-matching enterprise -> default; null host/ping -> default). |
| `src/support/github-webhook-hmac-handler.js` | modify | Import `parseDestinations, classifyDestination`. Add a `GITHUB_DESTINATIONS`-present branch at the top of the registry section of `checkAuth`: parse (malformed -> `error` log + null), read body, extract metadata, classify, skip on `{ skip: true }`, select `result.webhook_secret` (missing -> `error` log + null), verify HMAC once, attach `{ user_id, target_id, reviewer_login }`. Fall through to the unchanged `GITHUB_TARGETS` / legacy branches when `GITHUB_DESTINATIONS` is absent. |
| `test/support/github-webhook-hmac-handler.test.js` | modify | Add `describe('GITHUB_DESTINATIONS registry path', ...)` mirroring the existing `GITHUB_TARGETS registry path` block: default/github-public auth + `target_id`; ghec auth against inline `webhook_secret` + `target_id`; `reviewer_login` attached for ghec AND for the default entry (required now, so always present); wrong-secret -> null + mismatch warn; non-github.com host -> null + skip warn (no HMAC); ping -> github-public; malformed config -> null + error; missing inline secret is not possible (covered by parse-time validation, asserted in parser tests instead); non-JSON body -> warn; empty body -> warn. Add one precedence test: `GITHUB_DESTINATIONS` wins when BOTH it and `GITHUB_TARGETS` are set. |
| `src/controllers/webhooks.js` | none | No change. Already resolves `reviewerLogin = profile.reviewer_login || env.GITHUB_REVIEWER_LOGIN` and plumbs `profile.target_id` into the SQS payload. On the new path the profile carries `reviewer_login`, so the fallback is bypassed; the legacy path keeps it. Confirm by reading (no edit). |
| `test/controllers/webhooks.test.js` | modify | Add one test in the existing `describe('multi-destination target_id', ...)` block proving a profile shaped by the `GITHUB_DESTINATIONS` path (carrying `target_id` + `reviewer_login`, and **no** `app_slug` because the new path attaches none) still enqueues with `target_id` and gates on `reviewer_login` — using `env.GITHUB_APP_SLUG` for the controller's app-slug requirement. |
| `src/utils/github-trigger-rules.js` | none | No change. `getSkipReason` already takes `reviewerLogin` as its 5th param. Confirm by reading (no edit). |

> Iteration style note for the implementer: match the existing module's functional style (`.forEach`, `.find`, `.filter` as in `parseTargets`/`classify`). For the keyed object use `Object.entries(obj).forEach(([targetId, entry]) => ...)` for validation and `Object.entries(obj).find(...)` / `.filter(...)` for classification and the single-default check — this mirrors `src/support/customer-config-mapper.js` and keeps `@adobe/eslint-config-helix` clean (no bare `for...in`).

---

### Task 1: `parseDestinations` parses and validates the keyed `GITHUB_DESTINATIONS` object

Add a new exported `parseDestinations(env)` function to `src/support/github-targets.js`, alongside (not replacing) `parseTargets`. It reads `env.GITHUB_DESTINATIONS`, returns `null` when unset (legacy-mode signal, same contract as `parseTargets`), JSON-parses to a plain object keyed by `target_id`, and validates every entry plus the registry-level "exactly one default" invariant. Validation rules come verbatim from the ADR "Schema Detail / Web": each entry's `match` is exactly one of `{ default: true }` or `{ enterprise_slug: [non-empty strings] }` (both or neither throws); the registry has exactly one `default:true` entry (zero or >1 throws); `webhook_secret` is a non-empty string; `reviewer_login` is a non-empty string matching `^[A-Za-z0-9][A-Za-z0-9_-]*(\[bot\])?$`, max 64; the `target_id` key matches `^[a-z][a-z0-9-]{0,63}$`. Reuse the throw-message style and the regexes already present in `parseTargets`.

**Files:**
- `src/support/github-targets.js` (add `parseDestinations` after `parseTargets`, before `hostOf` around line 102)
- `test/support/github-targets.test.js` (add a new `describe('github-targets parseDestinations', ...)` block after the existing `describe('github-targets parseTargets reviewerLogin', ...)` block, around line 169)

Steps:

- [ ] **Step 1: Write failing tests for `parseDestinations`.**
  Add a top-level fixture near the existing `VALID_TARGETS` (top of `test/support/github-targets.test.js`, after line 23), and import `parseDestinations` and `classifyDestination` from the module. Update the import line at the top of the file:
  ```js
  import {
    parseTargets, classify, extractClassificationMetadata, parseDestinations, classifyDestination,
  } from '../../src/support/github-targets.js';
  ```
  Add the fixture:
  ```js
  const VALID_DESTINATIONS = JSON.stringify({
    ghec: { match: { enterprise_slug: ['adobe-prd'] }, webhook_secret: 'whsec-ghec', reviewer_login: 'emu_reviewer' },
    'github-public': { match: { default: true }, webhook_secret: 'whsec-public', reviewer_login: 'MysticatBot' },
  });
  ```
  Add this `describe` block immediately after the `describe('github-targets parseTargets reviewerLogin', ...)` block closes (before `describe('github-targets extractClassificationMetadata', ...)`):
  ```js
  describe('github-targets parseDestinations', () => {
    it('returns null when GITHUB_DESTINATIONS is unset (legacy mode signal)', () => {
      expect(parseDestinations({})).to.be.null;
    });

    it('parses a valid registry into a keyed object', () => {
      const dests = parseDestinations({ GITHUB_DESTINATIONS: VALID_DESTINATIONS });
      expect(dests).to.have.all.keys('ghec', 'github-public');
      expect(dests.ghec.webhook_secret).to.equal('whsec-ghec');
      expect(dests.ghec.reviewer_login).to.equal('emu_reviewer');
      expect(dests['github-public'].match).to.deep.equal({ default: true });
    });

    it('throws on invalid JSON', () => {
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: 'not json' })).to.throw('not valid JSON');
    });

    it('throws when not a plain object (array)', () => {
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: '[]' })).to.throw('must be a non-empty JSON object');
    });

    it('throws when the object is empty', () => {
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: '{}' })).to.throw('must be a non-empty JSON object');
    });

    it('throws when a target_id key is not a valid worker target_id', () => {
      const bad = JSON.stringify({
        GitHub_Public: { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('target_id');
    });

    it('throws when an entry has both default and enterprise_slug', () => {
      const bad = JSON.stringify({
        x: { match: { default: true, enterprise_slug: ['a'] }, webhook_secret: 's', reviewer_login: 'r' },
        'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('exactly one');
    });

    it('throws when an entry has neither default nor a non-empty enterprise_slug', () => {
      const bad = JSON.stringify({
        x: { match: {}, webhook_secret: 's', reviewer_login: 'r' },
        'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('exactly one');
    });

    it('throws when enterprise_slug contains non-string entries', () => {
      const bad = JSON.stringify({
        ghec: { match: { enterprise_slug: [123, null] }, webhook_secret: 's', reviewer_login: 'r' },
        'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('strings');
    });

    it('throws when there is not exactly one default entry (zero)', () => {
      const noDefault = JSON.stringify({
        ghec: { match: { enterprise_slug: ['a'] }, webhook_secret: 's', reviewer_login: 'r' },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: noDefault })).to.throw('exactly one');
    });

    it('throws when there is more than one default entry', () => {
      const twoDefaults = JSON.stringify({
        a: { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
        b: { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: twoDefaults })).to.throw('exactly one');
    });

    it('throws when webhook_secret is missing or empty', () => {
      const bad = JSON.stringify({
        'github-public': { match: { default: true }, webhook_secret: '', reviewer_login: 'r' },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('webhook_secret');
    });

    it('throws when reviewer_login is missing', () => {
      const bad = JSON.stringify({
        'github-public': { match: { default: true }, webhook_secret: 's' },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('reviewer_login');
    });

    it('throws when reviewer_login has an invalid charset', () => {
      const bad = JSON.stringify({
        'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'bad login!' },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('reviewer_login');
    });

    it('throws when reviewer_login exceeds 64 chars', () => {
      const bad = JSON.stringify({
        'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'a'.repeat(65) },
      });
      expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('reviewer_login');
    });

    it('accepts a slug[bot] reviewer_login', () => {
      const ok = JSON.stringify({
        'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'some-app[bot]' },
      });
      const dests = parseDestinations({ GITHUB_DESTINATIONS: ok });
      expect(dests['github-public'].reviewer_login).to.equal('some-app[bot]');
    });
  });
  ```

- [ ] **Step 2: Run the new tests, expect FAIL.**
  ```bash
  npx mocha test/support/github-targets.test.js -g 'parseDestinations'
  ```
  Expected: failure at load/collection — `parseDestinations` is `undefined` (not yet exported), so every `it` throws `TypeError: parseDestinations is not a function`. RED.

- [ ] **Step 3: Implement `parseDestinations`.**
  In `src/support/github-targets.js`, add the following function immediately after `parseTargets` returns (after line 101, before `function hostOf`):
  ```js
  /**
   * Parse + validate the GITHUB_DESTINATIONS env var (the consolidated registry).
   * A keyed object by target_id; each entry is { match, webhook_secret,
   * reviewer_login } with snake_case keys. The webhook secret is INLINE (no
   * webhookSecretEnvVar indirection). Loaded at runtime from Vault into
   * context.env (secret-bearing — do not log the value).
   * @param {object} env - context.env
   * @returns {object|null} the keyed destinations object, or null when
   *   GITHUB_DESTINATIONS is unset (legacy GITHUB_TARGETS mode).
   * @throws {Error} when GITHUB_DESTINATIONS is set but structurally invalid.
   */
  export function parseDestinations(env) {
    const raw = env?.GITHUB_DESTINATIONS;
    if (!raw) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`GITHUB_DESTINATIONS is not valid JSON: ${e.message}`);
    }
    // A keyed object (not the legacy ordered array). Reject arrays and
    // non-objects explicitly so a misformatted value fails loudly at parse.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
      throw new Error('GITHUB_DESTINATIONS must be a non-empty JSON object keyed by target_id');
    }
    Object.entries(parsed).forEach(([targetId, entry]) => {
      // The key IS the worker's SQS target_id; enforce the worker's charset so a
      // bad id fails loudly at parse and stays a bounded value where it is logged.
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(targetId)) {
        throw new Error(`GITHUB_DESTINATIONS key "${targetId}" must match ^[a-z][a-z0-9-]{0,63}$ (it becomes the worker target_id)`);
      }
      if (!entry || typeof entry !== 'object') {
        throw new Error(`GITHUB_DESTINATIONS["${targetId}"] must be an object`);
      }
      const isDefault = entry.match?.default === true;
      const hasSlugs = Array.isArray(entry.match?.enterprise_slug)
        && entry.match.enterprise_slug.length > 0
        && entry.match.enterprise_slug.every((s) => typeof s === 'string' && s.length > 0);
      // match MUST be EXACTLY ONE of default:true or a non-empty enterprise_slug[]
      // of strings. Both or neither is rejected here (the registry-level
      // "exactly one default" check below catches the all-enterprise / no-default
      // case; this catches a single malformed entry).
      if (isDefault === hasSlugs) {
        throw new Error(`GITHUB_DESTINATIONS["${targetId}"].match must be exactly one of { default: true } or a non-empty enterprise_slug[] of strings`);
      }
      if (typeof entry.webhook_secret !== 'string' || !entry.webhook_secret) {
        throw new Error(`GITHUB_DESTINATIONS["${targetId}"] is missing a string "webhook_secret"`);
      }
      // reviewer_login is required on EVERY entry (no global fallback in the
      // consolidated registry). Accept plain users (MysticatBot), EMU users
      // (handle_shortcode), and App bots (slug[bot]).
      if (typeof entry.reviewer_login !== 'string'
        || !entry.reviewer_login.trim()
        || entry.reviewer_login.length > 64
        || !/^[A-Za-z0-9][A-Za-z0-9_-]*(\[bot\])?$/.test(entry.reviewer_login)) {
        throw new Error(`GITHUB_DESTINATIONS["${targetId}"].reviewer_login must be a non-empty string matching ^[A-Za-z0-9][A-Za-z0-9_-]*(\\[bot\\])?$ and be at most 64 chars`);
      }
    });
    const defaults = Object.values(parsed).filter((e) => e.match?.default === true);
    if (defaults.length !== 1) {
      throw new Error(`GITHUB_DESTINATIONS must have exactly one match.default:true entry (found ${defaults.length})`);
    }
    return parsed;
  }
  ```
  Note on the `isDefault === hasSlugs` guard: both-true means a malformed entry (rejected); both-false means a malformed entry (rejected); exactly-one-true passes. The `both default+enterprise_slug` test and the `neither` test both throw on this guard or the registry-level check — they assert `'exactly one'` in the message, which the registry-level throw provides for the all-enterprise case, and the entry-level throw provides `'exactly one of'` for the both-set case. Both assertions match on the substring `exactly one`.

- [ ] **Step 4: Run the new tests, expect PASS.**
  ```bash
  npx mocha test/support/github-targets.test.js -g 'parseDestinations'
  ```
  Expected: all `parseDestinations` tests green.

- [ ] **Step 5: Run the full file, expect PASS (no regressions).**
  ```bash
  npx mocha test/support/github-targets.test.js
  ```
  Expected: all `github-targets` tests green — the existing `parseTargets`/`classify`/`extractClassificationMetadata` suites are untouched.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/support/github-targets.js test/support/github-targets.test.js && git commit -m "feat(github-targets): add parseDestinations for consolidated GITHUB_DESTINATIONS registry"
  ```

---

### Task 2: `classifyDestination` classifies the keyed object by match-type priority

Add a new exported `classifyDestination(meta, destinations)` to `src/support/github-targets.js`. Semantics are identical in **outcome** to the legacy `classify`, but evaluated by match-type priority over a keyed object rather than array position: the host pre-filter is unchanged (`host !== null && host !== 'github.com'` -> `{ skip: true }`); then the entry whose `match.enterprise_slug` includes the signed `enterprise.slug` wins (enterprise entries are checked before default); else the single `match.default === true` entry; else `{ skip: true }`. The returned object is the matched entry augmented so the caller has the `target_id` — return `{ target_id, ...entry }` so the handler can read `result.target_id`, `result.webhook_secret`, `result.reviewer_login`.

**Files:**
- `src/support/github-targets.js` (add `classifyDestination` after the existing `classify` function, end of file ~line 155)
- `test/support/github-targets.test.js` (add a `describe('github-targets classifyDestination', ...)` block after the existing `describe('github-targets classify', ...)` block, end of file)

Steps:

- [ ] **Step 1: Write failing tests for `classifyDestination`.**
  Add at the end of `test/support/github-targets.test.js` (after the `describe('github-targets classify', ...)` block):
  ```js
  describe('github-targets classifyDestination', () => {
    const destinations = parseDestinations({ GITHUB_DESTINATIONS: VALID_DESTINATIONS });

    it('skips a positively non-github.com host', () => {
      expect(classifyDestination({ host: 'git.corp.adobe.com', enterpriseSlug: null }, destinations))
        .to.deep.equal({ skip: true });
    });

    it('routes an EMU enterprise slug to ghec with its inline secret + reviewer', () => {
      const result = classifyDestination({ host: 'github.com', enterpriseSlug: 'adobe-prd' }, destinations);
      expect(result).to.deep.include({
        target_id: 'ghec', webhook_secret: 'whsec-ghec', reviewer_login: 'emu_reviewer',
      });
    });

    it('routes a github.com body with no enterprise to github-public (default catch-all)', () => {
      expect(classifyDestination({ host: 'github.com', enterpriseSlug: null }, destinations).target_id)
        .to.equal('github-public');
    });

    it('routes a github.com body with a NON-EMU enterprise slug to github-public', () => {
      expect(classifyDestination({ host: 'github.com', enterpriseSlug: 'some-other-enterprise' }, destinations).target_id)
        .to.equal('github-public');
    });

    it('routes a null host (ping / no repository) to github-public, NOT skip', () => {
      expect(classifyDestination({ host: null, enterpriseSlug: null }, destinations).target_id)
        .to.equal('github-public');
    });

    it('prefers an enterprise match over the default even when both could apply', () => {
      // Match rules are mutually exclusive by construction; this asserts the
      // enterprise branch is evaluated before the default branch.
      const result = classifyDestination({ host: 'github.com', enterpriseSlug: 'adobe-prd' }, destinations);
      expect(result.target_id).to.equal('ghec');
    });
  });
  ```

- [ ] **Step 2: Run the new tests, expect FAIL.**
  ```bash
  npx mocha test/support/github-targets.test.js -g 'classifyDestination'
  ```
  Expected: failure — `classifyDestination` is `undefined`, so each `it` throws `TypeError: classifyDestination is not a function`. RED.

- [ ] **Step 3: Implement `classifyDestination`.**
  In `src/support/github-targets.js`, add at the end of the file (after the existing `classify` function):
  ```js
  /**
   * Classify webhook metadata to a destination, or signal skip. Match-type
   * priority (NOT array position): host pre-filter, then an enterprise_slug
   * match, then the single default entry.
   * @param {{host: (string|null), enterpriseSlug: (string|null)}} meta
   * @param {object} destinations - validated keyed registry from parseDestinations
   * @returns {object|{skip: true}} { target_id, ...entry } of the matched
   *   destination, or { skip: true }.
   */
  export function classifyDestination(meta, destinations) {
    const { host, enterpriseSlug } = meta;
    // A positively-identified non-github.com host (e.g. a GHES host) has no
    // in-scope destination. A null/unknown host (ping / no repository) falls
    // through to the github.com catch-all (the default entry).
    if (host !== null && host !== 'github.com') {
      return { skip: true };
    }
    const entries = Object.entries(destinations);
    // Enterprise entries are evaluated BEFORE the default (match-type priority).
    if (enterpriseSlug) {
      const enterprise = entries.find(([, entry]) => Array.isArray(entry.match?.enterprise_slug)
        && entry.match.enterprise_slug.includes(enterpriseSlug));
      if (enterprise) {
        const [targetId, entry] = enterprise;
        return { target_id: targetId, ...entry };
      }
    }
    const fallback = entries.find(([, entry]) => entry.match?.default === true);
    if (fallback) {
      const [targetId, entry] = fallback;
      return { target_id: targetId, ...entry };
    }
    return { skip: true };
  }
  ```
  Note: `parseDestinations` already guarantees exactly one `default:true` entry, so the `fallback` find always succeeds on a validated registry; the `return { skip: true }` tail is defensive for direct callers passing an unvalidated object.

- [ ] **Step 4: Run the new tests, expect PASS.**
  ```bash
  npx mocha test/support/github-targets.test.js -g 'classifyDestination'
  ```
  Expected: all `classifyDestination` tests green.

- [ ] **Step 5: Run the full file, expect PASS (no regressions).**
  ```bash
  npx mocha test/support/github-targets.test.js
  ```
  Expected: all `github-targets` tests green.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/support/github-targets.js test/support/github-targets.test.js && git commit -m "feat(github-targets): add classifyDestination with match-type priority"
  ```

---

### Task 3: HMAC handler reads `GITHUB_DESTINATIONS` first (dual-read), falling back to `GITHUB_TARGETS`

Add a new branch at the top of the registry section of `checkAuth`. When `context.env.GITHUB_DESTINATIONS` is set, classify on it, select the matched entry's **inline** `webhook_secret`, verify HMAC once, and attach `{ user_id, target_id, reviewer_login }` to the profile (no `app_slug` — the new path drops it; the controller's app-slug requirement is met by `env.GITHUB_APP_SLUG` during dual-read). When `GITHUB_DESTINATIONS` is absent, the new branch is skipped entirely and control flows into the existing `GITHUB_TARGETS` / legacy-`GITHUB_WEBHOOK_SECRET` code unchanged. The structural pre-checks (path scope, signature presence, signature format, body-size limits) stay shared and run first.

**Files:**
- `src/support/github-webhook-hmac-handler.js` (modify the import at line 16; insert the new branch after the signature-format check at line 78, before `const targetsRaw = ...` at line 80)
- `test/support/github-webhook-hmac-handler.test.js` (add a new `describe('GITHUB_DESTINATIONS registry path', ...)` block after the existing `describe('GITHUB_TARGETS registry path', ...)` block closes, around line 365)

Steps:

- [ ] **Step 1: Write failing tests for the `GITHUB_DESTINATIONS` path.**
  Add a new `describe` block in `test/support/github-webhook-hmac-handler.test.js`, immediately after the existing `describe('GITHUB_TARGETS registry path', ...)` block closes (the file's top-level `computeSignature`, `makeRequest`, `makeContext`, `secret`, `validPayload` helpers are in scope):
  ```js
  describe('GITHUB_DESTINATIONS registry path (consolidated)', () => {
    const ghecSecret = 'ghec-webhook-secret';
    const DESTINATIONS = JSON.stringify({
      ghec: {
        match: { enterprise_slug: ['adobe-prd'] },
        webhook_secret: ghecSecret,
        reviewer_login: 'emu_reviewer',
      },
      'github-public': {
        match: { default: true },
        webhook_secret: secret,
        reviewer_login: 'MysticatBot',
      },
    });
    const publicBody = JSON.stringify({
      action: 'review_requested',
      installation: { id: 1 },
      repository: { html_url: 'https://github.com/adobe/spacecat-api-service' },
    });
    const ghecBody = JSON.stringify({
      action: 'review_requested',
      installation: { id: 1 },
      enterprise: { slug: 'adobe-prd' },
      repository: { html_url: 'https://github.com/Adobe-AEM-Sites/aem-sites-architecture' },
    });
    const ghesBody = JSON.stringify({ action: 'review_requested', installation: { id: 1 }, repository: { html_url: 'https://git.corp.adobe.com/experience-platform/mystique' } });
    const pingBody = JSON.stringify({ zen: 'Keep it simple', hook_id: 1 });

    function destContext(extraEnv = {}) {
      return makeContext({ env: { GITHUB_DESTINATIONS: DESTINATIONS, ...extraEnv } });
    }

    it('authenticates a github.com (default) webhook and attaches target_id github-public', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(publicBody, secret) }, publicBody);
      const result = await handler.checkAuth(request, destContext());
      expect(result).to.not.be.null;
      expect(result.type).to.equal('github_webhook');
      expect(result.getProfile().target_id).to.equal('github-public');
    });

    it('attaches reviewer_login for the default (github-public) destination (required now)', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(publicBody, secret) }, publicBody);
      const result = await handler.checkAuth(request, destContext());
      expect(result.getProfile().reviewer_login).to.equal('MysticatBot');
    });

    it('does not attach app_slug on the consolidated path', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(publicBody, secret) }, publicBody);
      const result = await handler.checkAuth(request, destContext());
      expect(result.getProfile().app_slug).to.be.undefined;
    });

    it('authenticates a GHEC webhook against the inline webhook_secret and attaches target_id ghec', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(ghecBody, ghecSecret) }, ghecBody);
      const result = await handler.checkAuth(request, destContext());
      expect(result).to.not.be.null;
      expect(result.getProfile().target_id).to.equal('ghec');
      expect(result.getProfile().reviewer_login).to.equal('emu_reviewer');
    });

    it('rejects a GHEC body signed with the github-public secret (wrong secret)', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(ghecBody, secret) }, ghecBody);
      const result = await handler.checkAuth(request, destContext());
      expect(result).to.be.null;
      expect(mockLog.warn.calledWithMatch('HMAC signature mismatch')).to.be.true;
    });

    it('skips (null) a non-github.com host without computing HMAC', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(ghesBody, secret) }, ghesBody);
      const result = await handler.checkAuth(request, destContext());
      expect(result).to.be.null;
      expect(mockLog.warn.calledWithMatch('Skipping webhook')).to.be.true;
    });

    it('treats a ping (no repository -> null host) as github-public, not skip', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(pingBody, secret) }, pingBody);
      const result = await handler.checkAuth(request, destContext());
      expect(result).to.not.be.null;
      expect(result.getProfile().target_id).to.equal('github-public');
    });

    it('returns null + error on malformed GITHUB_DESTINATIONS', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(publicBody, secret) }, publicBody);
      const result = await handler.checkAuth(request, destContext({ GITHUB_DESTINATIONS: 'not json' }));
      expect(result).to.be.null;
      expect(mockLog.error.calledWithMatch('Invalid GITHUB_DESTINATIONS')).to.be.true;
    });

    it('returns null + warn when the body is not valid JSON', async () => {
      const malformed = 'not-json';
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(malformed, secret) }, malformed);
      const result = await handler.checkAuth(request, destContext());
      expect(result).to.be.null;
      expect(mockLog.warn.calledWithMatch('not valid JSON')).to.be.true;
    });

    it('returns null + warn for an empty body', async () => {
      const request = makeRequest({ 'x-hub-signature-256': computeSignature('', secret) }, '');
      const result = await handler.checkAuth(request, destContext());
      expect(result).to.be.null;
      expect(mockLog.warn.calledWithMatch('Empty')).to.be.true;
    });

    it('prefers GITHUB_DESTINATIONS over GITHUB_TARGETS when BOTH are set (dual-read precedence)', async () => {
      // A legacy GITHUB_TARGETS that, if read, would route differently / use a
      // different secret. The consolidated path must win, so the github-public
      // inline secret authenticates and target_id is github-public.
      const legacyTargets = JSON.stringify([
        { id: 'github-public', match: { default: true }, appSlug: 'mysticat', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET' },
      ]);
      const request = makeRequest({ 'x-hub-signature-256': computeSignature(publicBody, secret) }, publicBody);
      const result = await handler.checkAuth(request, destContext({
        GITHUB_TARGETS: legacyTargets,
        GITHUB_WEBHOOK_SECRET: 'a-different-legacy-secret',
      }));
      expect(result).to.not.be.null;
      expect(result.getProfile().target_id).to.equal('github-public');
      // app_slug proves the consolidated path (not the GITHUB_TARGETS path) ran:
      // the legacy path would have set app_slug 'mysticat'.
      expect(result.getProfile().app_slug).to.be.undefined;
    });
  });
  ```

- [ ] **Step 2: Run the new tests, expect FAIL.**
  ```bash
  npx mocha test/support/github-webhook-hmac-handler.test.js -g 'GITHUB_DESTINATIONS registry path'
  ```
  Expected: failures. With `GITHUB_DESTINATIONS` set but no handler branch reading it, `targetsRaw` is `undefined`, so the handler takes the legacy `GITHUB_WEBHOOK_SECRET` branch — `destContext()` does not set that secret, so it returns null and logs `misconfigured=true`. The auth/`target_id`/`reviewer_login`/precedence assertions all fail. RED.

- [ ] **Step 3: Implement the dual-read branch.**
  In `src/support/github-webhook-hmac-handler.js`, change the import:
  ```js
  import { parseTargets, classify, extractClassificationMetadata } from './github-targets.js';
  ```
  to:
  ```js
  import {
    parseTargets, classify, extractClassificationMetadata, parseDestinations, classifyDestination,
  } from './github-targets.js';
  ```
  Then insert the new branch in `checkAuth`, immediately after the signature-format check (after the `if (!SIGNATURE_PATTERN.test(signature)) { ... }` block at line 78) and **before** `const targetsRaw = context.env?.GITHUB_TARGETS;`:
  ```js
      // ---- Consolidated path: GITHUB_DESTINATIONS (the new registry) takes
      // precedence (dual-read). Classify from the SIGNED body, select the
      // matched destination's INLINE webhook_secret, verify HMAC once. Parsing
      // before verifying is safe: a forged body just selects a candidate whose
      // secret it cannot forge. When GITHUB_DESTINATIONS is absent, fall through
      // to the legacy GITHUB_TARGETS / GITHUB_WEBHOOK_SECRET paths below.
      if (context.env?.GITHUB_DESTINATIONS) {
        let destinations;
        try {
          destinations = parseDestinations(context.env);
        } catch (e) {
          // Malformed registry is a misconfiguration; null -> 401 (visible failed
          // delivery). Do NOT interpolate the value (it is secret-bearing); the
          // parser's message names only keys/fields, never secrets.
          this.log(`Invalid GITHUB_DESTINATIONS config (misconfigured=true): ${e.message}`, 'error');
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
        const result = classifyDestination(meta, destinations);
        // host not an in-scope GitHub destination (e.g. a GHES host): skip + log,
        // NO HMAC. The body is untrusted, so do not interpolate meta.host.
        if (result.skip) {
          this.log('Skipping webhook: host is not an in-scope GitHub destination', 'warn');
          return null;
        }
        // webhook_secret is inline + validated non-empty at parse, so this is
        // present on a validated registry; verify HMAC once.
        if (!verifySignature(signature, rawBody, result.webhook_secret)) {
          this.log('HMAC signature mismatch', 'warn');
          return null;
        }
        return new AuthInfo()
          .withAuthenticated(true)
          .withProfile({
            user_id: 'github-webhook',
            target_id: result.target_id,
            // reviewer_login is required on every destination entry (no fallback
            // in the consolidated registry), so it is always set here.
            reviewer_login: result.reviewer_login,
          })
          .withType('github_webhook');
      }

  ```

- [ ] **Step 4: Run the new tests, expect PASS.**
  ```bash
  npx mocha test/support/github-webhook-hmac-handler.test.js -g 'GITHUB_DESTINATIONS registry path'
  ```
  Expected: all consolidated-path tests green.

- [ ] **Step 5: Run the full file, expect PASS (no regressions).**
  ```bash
  npx mocha test/support/github-webhook-hmac-handler.test.js
  ```
  Expected: all handler tests green — the legacy `describe('GITHUB_TARGETS registry path', ...)` and top-level tests are untouched because their contexts never set `GITHUB_DESTINATIONS`, so the new branch is skipped and they hit the original code path exactly as before.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/support/github-webhook-hmac-handler.js test/support/github-webhook-hmac-handler.test.js && git commit -m "feat(github-webhook): dual-read GITHUB_DESTINATIONS with inline webhook_secret, fall back to GITHUB_TARGETS"
  ```

---

### Task 4: Confirm the controller and trigger-rules need no change; add a consolidated-path controller test

The controller already does the right thing: it reads `profile = ctx.attributes?.authInfo?.getProfile?.() || {}`, resolves `reviewerLogin = profile.reviewer_login || env.GITHUB_REVIEWER_LOGIN`, and plumbs `profile.target_id` into the SQS payload. On the consolidated path the profile carries `reviewer_login` (always set), so the `||` short-circuits before the global fallback; `target_id` is set, so it lands in the payload. The new path attaches no `app_slug`, so the controller's `appSlug = profile.app_slug || env.GITHUB_APP_SLUG` resolves to `env.GITHUB_APP_SLUG` (present during dual-read) — satisfying the app-slug-required gate without it gating the reviewer match (the reviewer match uses `reviewerLogin`). `getSkipReason` already accepts `reviewerLogin` as its 5th param. So Tasks on `webhooks.js` and `github-trigger-rules.js` are **read-and-confirm only**; the sole code addition is a regression test proving the consolidated-path profile shape flows through correctly.

**Files:**
- `src/controllers/webhooks.js` (read-only confirm — no edit)
- `src/utils/github-trigger-rules.js` (read-only confirm — no edit)
- `test/controllers/webhooks.test.js` (add one test in the existing `describe('multi-destination target_id', ...)` block, around line 457)

Steps:

- [ ] **Step 1: Confirm `webhooks.js` and `github-trigger-rules.js` are unchanged for this PR.**
  Read `src/controllers/webhooks.js` lines 100-106 (the `profile`/`targetId`/`appSlug`/`reviewerLogin` resolution) and line 151 (the `getSkipReason(data, action, env, appSlug, reviewerLogin)` call) and line 225 (`...(targetId ? { target_id: targetId } : {})`). Read `src/utils/github-trigger-rules.js` line 35-41 (the `getSkipReason` 5-param signature) and line 58 (`reviewerLogin?.trim() || \`${appSlug}[bot]\``). Confirm no edit is required. No commit for this step.

- [ ] **Step 2: Write a failing test — consolidated-path profile (target_id + reviewer_login, no app_slug) enqueues and gates on reviewer_login.**
  In `test/controllers/webhooks.test.js`, add this test inside the existing `describe('multi-destination target_id', ...)` block, after the `falls back to env.GITHUB_REVIEWER_LOGIN ... (legacy)` test (around line 443). The block's `buildController` defaults `env.GITHUB_APP_SLUG = 'mysticat'`:
  ```js
    it('enqueues with target_id and gates on reviewer_login for a consolidated (GITHUB_DESTINATIONS) profile', async () => {
      // Mirrors what the HMAC handler attaches on the consolidated path: a
      // profile with target_id + reviewer_login but NO app_slug. The controller
      // must (a) satisfy its app-slug requirement from env.GITHUB_APP_SLUG,
      // (b) gate on the profile reviewer_login, and (c) emit target_id.
      const ctx = {
        ...validContext,
        attributes: {
          authInfo: {
            getProfile: () => ({
              user_id: 'github-webhook', target_id: 'ghec', reviewer_login: 'emu_reviewer',
            }),
          },
        },
        data: { ...validContext.data, requested_reviewer: { login: 'emu_reviewer' } },
      };

      const response = await controller.processGitHubWebhook(ctx);

      expect(response.status).to.equal(202);
      const [, payload] = mockSqs.sendMessage.firstCall.args;
      expect(payload.target_id).to.equal('ghec');
    });

    it('skips a consolidated profile when the requested reviewer does not match its reviewer_login', async () => {
      const ctx = {
        ...validContext,
        attributes: {
          authInfo: {
            getProfile: () => ({
              user_id: 'github-webhook', target_id: 'ghec', reviewer_login: 'emu_reviewer',
            }),
          },
        },
        data: { ...validContext.data, requested_reviewer: { login: 'someone-else' } },
      };

      const response = await controller.processGitHubWebhook(ctx);

      expect(response.status).to.equal(204);
      expect(mockSqs.sendMessage.called).to.be.false;
    });
  ```

- [ ] **Step 3: Run the new tests, expect PASS immediately (confirmation, no implementation needed).**
  ```bash
  npx mocha test/controllers/webhooks.test.js -g 'consolidated'
  ```
  Expected: BOTH tests green with no source change — this verifies the existing controller logic already handles the consolidated profile shape. (If either fails, STOP: the assumption that `webhooks.js` needs no change is wrong — re-read the resolution logic before proceeding. The first test's `appSlug` resolves from `env.GITHUB_APP_SLUG='mysticat'`; the reviewer gate uses `reviewer_login='emu_reviewer'` from the profile, matching `requested_reviewer.login='emu_reviewer'`, so it must enqueue. The second mismatches the reviewer, so it must 204.)

- [ ] **Step 4: Run the full file, expect PASS (no regressions).**
  ```bash
  npx mocha test/controllers/webhooks.test.js
  ```
  Expected: all `WebhooksController` tests green.

- [ ] **Step 5: Commit.**
  ```bash
  git add test/controllers/webhooks.test.js && git commit -m "test(webhooks): cover consolidated GITHUB_DESTINATIONS profile shape (target_id + reviewer_login, no app_slug)"
  ```

---

## Validation

Final gates — all must pass before the work is considered complete (ADR Validation Phase 1 — Web).

- [ ] **Full test suite green.** Run the project's test script (matches `package.json` `"test"`):
  ```bash
  npm test
  ```
  Expected: all suites pass, including the new `parseDestinations` and `classifyDestination` cases in `github-targets`, the new `GITHUB_DESTINATIONS registry path` cases in `github-webhook-hmac-handler`, and the new consolidated-profile cases in `webhooks`. (`npm test` runs `c8 --skip-full mocha --parallel --timeout 10000 -i -g 'Post-Deploy' --spec=test/**/*.test.js --ignore=test/it/**`.)

- [ ] **Lint clean.** Run the project's lint script (matches `package.json` `"lint"`):
  ```bash
  npm run lint
  ```
  Expected: no errors (`eslint .`, `@adobe/eslint-config-helix`). The `Object.entries(...).forEach`/`.find`/`.filter` iteration style matches the module's existing `parseTargets`/`classify` and avoids bare `for...in`/`for...of` restrictions. The `[bot]` literal is written `\[bot\]` in the regex and `\\[bot\\]` inside the throw-message template string, identical to the existing `parseTargets` handling (no `no-useless-escape` flag).

- [ ] **Truth-table check — `GITHUB_DESTINATIONS` classification.** The combined assertions across `classifyDestination` (Task 2) and the handler `GITHUB_DESTINATIONS registry path` (Task 3) confirm:
  - enterprise (`enterprise.slug = 'adobe-prd'`, host `github.com`) -> `ghec` (authenticated against `whsec-ghec`/`ghec-webhook-secret`).
  - plain github.com (no `enterprise`, or a non-matching enterprise, host `github.com` or `null`/ping) -> `github-public` (default catch-all).
  - non-github.com host (`git.corp.adobe.com`) -> `{ skip: true }` -> handler returns null, logs `Skipping webhook`, computes NO HMAC.

- [ ] **HMAC verifies against the inline `webhook_secret`.** The handler `GITHUB_DESTINATIONS` tests confirm a body signed with the matched entry's inline secret authenticates (200/AuthInfo), and a body signed with a different entry's secret returns null + `HMAC signature mismatch` (the classify-then-verify-once order: a forged body selects a candidate whose secret it cannot forge).

- [ ] **Dual-read fallback intact.** With `GITHUB_DESTINATIONS` unset, the entire existing `GITHUB_TARGETS` registry path and the legacy single-`GITHUB_WEBHOOK_SECRET` path still pass unchanged (the original `github-webhook-hmac-handler` and `github-targets` suites are green and untouched). The precedence test confirms that when BOTH `GITHUB_DESTINATIONS` and `GITHUB_TARGETS` are set, the consolidated path wins (proven by `target_id` resolution and the absence of `app_slug` on the profile, which only the legacy path sets).

- [ ] **`reviewer_login` reaches the profile and gates the trigger.** Handler tests assert the consolidated path attaches `reviewer_login` for both the enterprise (`emu_reviewer`) and the default (`MysticatBot`) entries (required on every entry now); controller tests assert that profile `reviewer_login` flows through `getSkipReason` to enqueue-or-skip correctly, with `env.GITHUB_APP_SLUG` satisfying the app-slug-required gate even though the consolidated profile carries no `app_slug`.

- [ ] **No secret leakage.** Confirm by code review that `parseDestinations` throw messages name only keys/fields (never the `webhook_secret`/`reviewer_login` values), and that the handler's `Invalid GITHUB_DESTINATIONS` error log interpolates only the parser's (value-free) message — never the raw `GITHUB_DESTINATIONS` env value. (The ADR classifies the consolidated value as secret-bearing; Phase-4 ops adds a "not logged" runtime check, out of scope here.)

- [ ] **Reference config shape (for the ops backfill, not provisioned by this PR).** The Vault key `GITHUB_DESTINATIONS` in `dx_mysticat/{env}/api-service` is a JSON **string** of a keyed object (ADR Schema Detail / Web). Reference shape:
  ```json
  {
    "github-public": { "match": { "default": true }, "webhook_secret": "<whsec>", "reviewer_login": "MysticatBot" },
    "ghec":          { "match": { "enterprise_slug": ["<emu-slug>"] }, "webhook_secret": "<whsec-ghec>", "reviewer_login": "<emu-reviewer-user>" }
  }
  ```
  Until this key is written, `parseDestinations` returns `null` and the web tier serves the legacy `GITHUB_TARGETS` path unchanged. `<emu-reviewer-user>` must match the worker's `destinations.ghec.reviewer_login` (cross-tier invariant; enforced operationally, not by the web tier in isolation).

### Critical Files for Implementation
- /Users/dj/work/github/adobe/spacecat-api-service/src/support/github-targets.js
- /Users/dj/work/github/adobe/spacecat-api-service/src/support/github-webhook-hmac-handler.js
- /Users/dj/work/github/adobe/spacecat-api-service/test/support/github-targets.test.js
- /Users/dj/work/github/adobe/spacecat-api-service/test/support/github-webhook-hmac-handler.test.js
- /Users/dj/work/github/adobe/spacecat-api-service/test/controllers/webhooks.test.js
