/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

// @ts-check

/**
 * Serenity prompt-tag taxonomy — the single source of truth for the tag tree
 * attached to prompts (and registered as the tag vocabulary on each project).
 * Import these constants instead of hardcoding tag literals anywhere in the
 * serenity flow.
 *
 * A tag's DIMENSION is its root ancestor, not a prefix on its name. Every
 * project's tag tree has exactly four roots — `category`, `intent`, `origin`,
 * `type` — and every tag value is a bare-named descendant of one of them. No
 * tag name contains a `:`. A tag's dimension is therefore `path[0]` of the
 * upstream breadcrumb (verified against the live Semrush API: `path[]` is a
 * full root-first ancestry at any depth), never something parsed out of a name.
 *
 * Depth is a property of the data, not of this module: a customer category
 * sits at depth 2 (child of the `category` root) and a sub-category at depth 3.
 * The upstream API caps neither, so nothing here does either.
 *
 * Names are NOT unique on their own — upstream uniqueness is scoped per
 * `(project, parent)`. A sub-category named `human` and the `origin` value
 * `human` are two distinct tags. Never key a tag by name alone; key by id.
 *
 * The authorship root is being renamed `source` → `origin` in place across the
 * live projects (origin-dimension.md). Until that migration's contract phase
 * (WP-O6) lands, the tag-tree resolver tolerates BOTH names — see
 * {@link LEGACY_AUTHORSHIP_ROOT_NAME} and `tag-tree.js`.
 */

/**
 * The five dimension roots. Each is a bare-named ROOT tag on every project.
 *
 * `source` (source-dimension.md) is the producing-system dimension — the system
 * that produced a prompt (`config`, `gsc`, `drs`, …), read from `prompts.source`
 * and canonicalized ({@link canonicalizeSource}). It reuses the name the
 * authorship root vacates in the `source` → `origin` rename (origin-dimension.md):
 * while that rename's contract phase (WP-O6) is still in flight the identifier is
 * temporarily overloaded, so this dimension MUST NOT be provisioned on a project
 * whose `source` root still carries `ai` / `human` — see
 * {@link LEGACY_AUTHORSHIP_ROOT_NAME} and the distinctness guard in `tag-tree.js`.
 */
export const DIMENSION = Object.freeze({
  CATEGORY: 'category',
  INTENT: 'intent',
  ORIGIN: 'origin',
  TYPE: 'type',
  SOURCE: 'source',
});

/**
 * The pre-rename name of the authorship root. Live projects provisioned before
 * the rename still carry a root named `source` (with `ai` / `human` beneath it);
 * the tolerant resolver accepts it in place of `origin` until WP-O6 drops this.
 *
 * NOTE it is the SAME string as {@link DIMENSION.SOURCE}: the producing-system
 * `source` root (this dimension) and the legacy authorship root are told apart by
 * their CHILDREN, never by name — see `tag-tree.js` `childrenAreAuthorship` and the
 * distinctness guard in `ensureDimensionRoots`.
 */
export const LEGACY_AUTHORSHIP_ROOT_NAME = 'source';

/**
 * The upstream tag-name length limit (Semrush `aio/tags`). Shared single source
 * of truth: the create-tag handler holds a create body to it, and
 * {@link canonicalizeSource} refuses a derived value longer than it.
 */
export const MAX_TAG_NAME_LEN = 100;

/** Root names, in the order they are provisioned on a project. */
export const DIMENSION_ROOT_NAMES = Object.freeze([
  DIMENSION.CATEGORY,
  DIMENSION.INTENT,
  DIMENSION.ORIGIN,
  DIMENSION.TYPE,
  DIMENSION.SOURCE,
]);

/** `origin` values — who authored the prompt. */
export const ORIGIN_VALUE = Object.freeze({
  AI: 'ai',
  HUMAN: 'human',
});

/**
 * `intent` values — the searcher intent the prompt represents.
 *
 * These are the Semrush AIO intent TARGETS, the shared vocabulary that the
 * mysticat-data-service customer-onboarding script also registers as a project's
 * tag taxonomy. They are NOT the raw data-service intent buckets persisted in
 * `prompts.intent` (those — informational / instructional / comparative /
 * transactional / planning / delegation — live in `src/support/intent.js` and
 * are unchanged here). The DRS-bucket → Semrush-target mapping is the onboarding
 * script's `INTENT_MAP` (mysticat-data-service `scripts/serenity_migration/tags.py`).
 *
 * `Navigational` has no DRS source bucket, so no generated prompt is tagged with
 * it, but it is part of the Semrush vocabulary and every live customer project
 * carries it — so it belongs in the taxonomy.
 */
export const INTENT_VALUE = Object.freeze({
  INFORMATIONAL: 'Informational',
  TASK: 'Task',
  COMMERCIAL: 'Commercial',
  TRANSACTIONAL: 'Transactional',
  NAVIGATIONAL: 'Navigational',
});

/** `type` values — whether the prompt mentions the brand. */
export const TYPE_VALUE = Object.freeze({
  BRANDED: 'branded',
  NON_BRANDED: 'non-branded',
});

/**
 * The CLOSED dimensions and their fixed child vocabularies. A caller may never
 * mint an arbitrary value under these; the values below are provisioned as the
 * root's children on every project. A caller may still "create" one of these
 * (POST /serenity/tags) to learn its upstream id, but only a value already in
 * the enum, and the create is resolve-before-create/idempotent — unlike an OPEN
 * dimension, where a duplicate `(parent, name)` is a hard upstream 500 by design
 * (verified live) and resolve-before-create is the caller's job.
 */
export const CLOSED_DIMENSION_VALUES = Object.freeze({
  [DIMENSION.INTENT]: Object.freeze(Object.values(INTENT_VALUE)),
  [DIMENSION.ORIGIN]: Object.freeze(Object.values(ORIGIN_VALUE)),
  [DIMENSION.TYPE]: Object.freeze(Object.values(TYPE_VALUE)),
});

/** The closed dimensions — fixed vocabularies, never customer-authored. */
export const CLOSED_DIMENSIONS = Object.freeze([
  DIMENSION.INTENT,
  DIMENSION.ORIGIN,
  DIMENSION.TYPE,
]);

/**
 * The OPEN dimensions — a value's vocabulary is NOT a fixed enum.
 *
 * `category` is customer-authored: a customer category is a child of the
 * `category` root, and a sub-category is a child of a category, at any depth.
 * `source` is server-owned but equally open — its vocabulary is the set of
 * producing systems, which grows with the platform and is never a frozen enum
 * (source-dimension.md §1 item 3). Open-vs-closed answers ONLY "does this have a
 * fixed vocabulary"; it does NOT answer "may a client write it" — that is
 * {@link SERVER_OWNED_DIMENSIONS}.
 */
export const OPEN_DIMENSIONS = Object.freeze([DIMENSION.CATEGORY, DIMENSION.SOURCE]);

/**
 * The SERVER-OWNED dimensions — everything except `category`. No client may mint
 * a value beneath these or assert one on a write; the server resolves-or-creates
 * them. This is a SEPARATE axis from open/closed ({@link isClosedDimension}): a
 * dimension is described by two independent properties — its vocabulary (open or
 * closed) and who writes it (the customer or the server) — and `source` is the
 * cell that is open AND server-owned (source-dimension.md §1 item 4).
 *
 * Two decisions route through this list, not through `isClosedDimension`:
 *  - the create-tag WRITE GUARD (a client may address it but never author a value
 *    outside the server's control — the closed dimensions additionally enum-check,
 *    `source` does not), and
 *  - CREATE SEMANTICS: a server-owned value is resolve-or-create, because no human
 *    is in a dialog to resolve it first.
 * `isClosedDimension` keeps its one honest job: vocabulary validation.
 */
export const SERVER_OWNED_DIMENSIONS = Object.freeze([
  DIMENSION.INTENT,
  DIMENSION.ORIGIN,
  DIMENSION.TYPE,
  DIMENSION.SOURCE,
]);

/** Every dimension a caller may address on the create-tag endpoint. */
export const ALL_DIMENSIONS = Object.freeze([...OPEN_DIMENSIONS, ...CLOSED_DIMENSIONS]);

/**
 * The canonical producing-system vocabulary known TODAY (source-dimension.md
 * §2.2, folded to the canonical form by §3.1). `source` is an OPEN dimension, so
 * this is NOT an allow-list and canonicalization never consults it — a producer
 * that ships a new value tomorrow is tagged tomorrow. It is a HYGIENE REFERENCE
 * SET with one job: anchoring the exhaustiveness of {@link SOURCE_LABEL}, so a
 * new canonical value cannot be added without also giving it a label (§7). Mirror
 * of the migration CLI's `KNOWN_PROMPT_SOURCES` (mysticat-data-service
 * `scripts/serenity_migration/tags.py`); keep the two in sync.
 */
export const SOURCE_VALUES = Object.freeze([
  'config',
  'base-url',
  'gsc',
  'drs',
  'semrush',
  'flow',
  'synthetic-personas',
  'citation-attempt',
  'llm-generated',
  'sheet',
  'api',
  'personalized',
  'agentic-traffic',
  'brand-concierge',
]);

/**
 * The `source` value stamped on a prompt created through the Serenity PROXY create
 * path (the human create dialog). A constant at the write site, never a caller
 * input and never read from a column — it matches what Postgres assigns on the v2
 * path (`prompts.source` default `config`), so the same user action produces the
 * same tag whichever store is behind it (source-dimension.md §1 items 2 & 5).
 */
export const PROXY_CREATE_SOURCE_VALUE = 'config';

/**
 * The `source` value stamped on every AI-generated prompt by the market-onboarding
 * generator. That path builds prompts from Semrush's own `getBrandTopics`, and
 * `semrush` is the persisted key for prompts from SR AI Visibility (source-dimension.md
 * §1 item 2). A constant at that write site — NOT `config`.
 */
export const GENERATED_PROMPT_SOURCE_VALUE = 'semrush';

/**
 * Canonical producing-system slug → customer-facing label. FROZEN and EXHAUSTIVE:
 * one entry per {@link SOURCE_VALUES} value, enforced by a unit test that FAILS
 * the moment a canonical value is added without a label. There is deliberately NO
 * pass-through slug default — a `SOURCE_LABEL[x] ?? x` fallback is exactly the
 * mechanism by which an internal slug reaches a customer silently (source-dimension.md
 * §7), and §3.2's product sign-off protects only the values that exist today.
 *
 * The label question is OPEN (source-dimension.md §3.2): until product signs off,
 * the labels are the canonical machine-name slugs, verbatim. This map is the SINGLE
 * place a display label would land, so whichever way that call goes it changes here
 * and nowhere else. (elmo ships its own display labels behind `SOURCE_BADGE_CONFIG`;
 * WP-S3.)
 */
export const SOURCE_LABEL = Object.freeze(
  SOURCE_VALUES.reduce((acc, slug) => {
    acc[slug] = slug;
    return acc;
  }, /** @type {Record<string, string>} */ ({})),
);

/**
 * The closed-dimension values applied to EVERY AI-generated prompt: the `origin`
 * value `ai` (AI-authored) plus the default `Informational` intent (the most
 * common intent for brand-topic prompts; re-classification can refine it later).
 * The `type` value is classified per prompt at generation time (branded vs
 * non-branded — see the handler), so it is NOT seeded here.
 *
 * Each entry names a dimension and the bare value beneath it; the caller resolves
 * the pair to an upstream tag id against the project's tree.
 */
export const STANDARD_PROMPT_TAG_VALUES = Object.freeze([
  Object.freeze({ dimension: DIMENSION.ORIGIN, name: ORIGIN_VALUE.AI }),
  Object.freeze({ dimension: DIMENSION.INTENT, name: INTENT_VALUE.INFORMATIONAL }),
]);

/**
 * True when `name` is a reserved dimension-root name. Root names are reserved:
 * a customer category may not be called `category`, and a closed value may not
 * be minted at the root level.
 *
 * While the `source` → `origin` rename is in flight, the legacy authorship name
 * ({@link LEGACY_AUTHORSHIP_ROOT_NAME}) is ALSO reserved — a customer must not be
 * able to mint a tag named `source` during the migration window, or it could be
 * mistaken for (or collide with) the legacy authorship root the tolerant resolver
 * still adopts. Dropped with the rest of the fallback at WP-O6.
 *
 * @param {string} name - a bare tag name.
 * @returns {boolean}
 */
export function isDimensionRootName(name) {
  return name === LEGACY_AUTHORSHIP_ROOT_NAME
    || (/** @type {readonly string[]} */ (DIMENSION_ROOT_NAMES)).includes(name);
}

/**
 * True when `dimension` has a fixed child vocabulary. This answers ONLY the
 * vocabulary question — for the write-guard / create-semantics question use
 * {@link isServerOwnedDimension}.
 *
 * @param {string} dimension
 * @returns {boolean}
 */
export function isClosedDimension(dimension) {
  return (/** @type {readonly string[]} */ (CLOSED_DIMENSIONS)).includes(dimension);
}

/**
 * True when `dimension` is server-owned — no client may author a value under it,
 * and the server resolves-or-creates it. Everything except `category`. Distinct
 * from {@link isClosedDimension}: `source` is server-owned yet open.
 *
 * @param {string} dimension
 * @returns {boolean}
 */
export function isServerOwnedDimension(dimension) {
  return (/** @type {readonly string[]} */ (SERVER_OWNED_DIMENSIONS)).includes(dimension);
}

/**
 * Canonicalizes a raw `prompts.source` value to its `source`-dimension tag name,
 * OR returns `null` when the value must not be tagged (source-dimension.md §3.1).
 *
 * The rule is mechanical: trim, lowercase, and `_` → `-`. Nothing else — no
 * mapping table, no inference, no default. It is total as a transform, but total
 * is not the same as safe (`prompts.source` is free text with no `CHECK`), so a
 * derived value is refused a tag — `null` — when it is empty after trimming,
 * contains a `:` (forbidden in any tag name), exceeds {@link MAX_TAG_NAME_LEN},
 * or shadows a dimension-root name ({@link isDimensionRootName}).
 *
 * `null` means "do not tag this prompt", NEVER "substitute a default": a caller
 * writes the prompt regardless and logs the offending value. This is the single
 * place the rule lives in this repo; it is applied at both derivation boundaries
 * (the tag write and the v2 read surface — `mapRowToPrompt`).
 *
 * @param {unknown} value - a raw `prompts.source` value.
 * @returns {string | null} the canonical slug, or `null` when it must not be tagged.
 */
export function canonicalizeSource(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const canonical = value.trim().toLowerCase().replace(/_/g, '-');
  if (canonical === ''
    || canonical.includes(':')
    || canonical.length > MAX_TAG_NAME_LEN
    || isDimensionRootName(canonical)) {
    return null;
  }
  return canonical;
}

/**
 * The fixed child vocabulary of a closed dimension, or an empty tuple for an
 * open one.
 *
 * @param {string} dimension
 * @returns {readonly string[]}
 */
export function closedValuesOf(dimension) {
  return CLOSED_DIMENSION_VALUES[/** @type {keyof CLOSED_DIMENSION_VALUES} */ (dimension)] ?? [];
}
