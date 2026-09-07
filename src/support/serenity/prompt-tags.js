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
 * project's tag tree has five roots — `category`, `intent`, `origin`, `type`,
 * and `source` — and every tag value is a bare-named descendant of one of them. No
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
 * The authorship root is `origin` (renamed from `source` — origin-dimension.md).
 * The rename is complete: the tag-tree resolver names `origin` strictly, with no
 * fallback for the pre-rename `source` name.
 */

/**
 * The five dimension roots. Each is a bare-named ROOT tag on every project.
 *
 * `source` (source-dimension.md) is the producing-system dimension — the system
 * that produced a prompt (`config`, `gsc`, `drs`, …), read from `prompts.source`
 * and canonicalized ({@link canonicalizeSource}).
 */
export const DIMENSION = Object.freeze({
  CATEGORY: 'category',
  INTENT: 'intent',
  ORIGIN: 'origin',
  TYPE: 'type',
  SOURCE: 'source',
});

/**
 * The upstream tag-name length limit (Semrush `aio/tags`). Shared single source
 * of truth: the create-tag handler holds a create body to it, and
 * {@link canonicalizeSource} refuses a derived value longer than it.
 */
export const MAX_TAG_NAME_LEN = 100;
/** The five dimensions, in the order their roots are provisioned on a project. */
export const DIMENSION_PROVISION_ORDER = Object.freeze([
  DIMENSION.CATEGORY,
  DIMENSION.INTENT,
  DIMENSION.ORIGIN,
  DIMENSION.TYPE,
  DIMENSION.SOURCE,
]);

/**
 * The agreed marker that hides a tag tree entry from the customer-facing Brand
 * Presence tag filter: Semrush suppresses any entry whose name starts with it.
 *
 * This is a data-exposure control, not a naming convention, so anything deciding
 * what reaches a customer-visible payload keys on THIS rather than on a list of
 * known marked names.
 */
export const HIDDEN_TAG_MARKER = '$abv_tags$';

/**
 * The upstream ROOT NAME of the `intent` dimension.
 *
 * The intent root carries {@link HIDDEN_TAG_MARKER}, so it is named
 * `$abv_tags$intent` upstream. `intent` remains the DIMENSION KEY everywhere else
 * — the `type` a client names on the tag endpoints, the key of the closed
 * vocabularies, the value elmo reads — and only the root's upstream name carries
 * the marker. The five intent VALUES stay bare-named (`Informational`,
 * `Commercial`, …); the rename does not touch them.
 */
export const INTENT_ROOT_NAME = `${HIDDEN_TAG_MARKER}intent`;

/**
 * The customer-facing DISPLAY root name for a dimension whose root gets renamed
 * (tag-display-names.md §1 item 4) — `category` → `Category`, `type` → `Type`,
 * `source` → `Source`. `intent` is excluded (permanently hidden under
 * {@link INTENT_ROOT_NAME}, no display rename) and `origin` keeps its canonical
 * root name.
 *
 * IDENTITY PLACEHOLDER — serenity-docs#407 (the vocabulary sign-off PR) is not
 * yet merged, so every value here is its own key, verbatim. Do NOT add or remove
 * keys here; only the orchestrator swaps these VALUES in once #407 merges and the
 * vocabulary is frozen (tag-display-names.md §7 gate 1).
 */
export const ROOT_DISPLAY_NAME = Object.freeze({
  [DIMENSION.CATEGORY]: DIMENSION.CATEGORY,
  [DIMENSION.TYPE]: DIMENSION.TYPE,
  [DIMENSION.SOURCE]: DIMENSION.SOURCE,
});

/**
 * The upstream root NAME a dimension's root is provisioned and resolved by
 * TODAY — {@link INTENT_ROOT_NAME} for `intent`, {@link ROOT_DISPLAY_NAME} for
 * the three renaming dimensions, the dimension key itself for everything else
 * (`origin`, and anything outside the taxonomy). Anything outside the taxonomy
 * maps to itself, so a caller gets the name it asked for rather than `undefined`
 * flowing into a create.
 *
 * {@link RESERVED_ROOT_NAMES} is derived through this function, so a change to the
 * mapping widens or narrows what a customer tag may not shadow.
 *
 * @param {string} dimension - a dimension key.
 * @returns {string} the upstream root name.
 */
export function rootNameOfDimension(dimension) {
  if (dimension === DIMENSION.INTENT) {
    return INTENT_ROOT_NAME;
  }
  return ROOT_DISPLAY_NAME[/** @type {keyof ROOT_DISPLAY_NAME} */ (dimension)] ?? dimension;
}

/**
 * The origin (authorship) dimension root name — who authored the prompt. Named
 * after its dimension key, like the other roots.
 */
export const ORIGIN_ROOT_NAME = DIMENSION.ORIGIN;

/**
 * The pre-rename origin root name. Authorship shipped under a root literally
 * named `source` before the rename to `origin` (LLMO-6270 §46,
 * origin-dimension.md). The rename runs project by project from the migration
 * CLI, so a project can carry either spelling until the sweep completes, and the
 * Elements read path tolerates both.
 *
 * COLLISION — pinned to the literal `source`, NOT to {@link DIMENSION.SOURCE},
 * even though the two coincide today: this is the *historical* wire spelling of
 * authorship and must not drift if the producing-system dimension is ever
 * renamed. The producing-system `source` dimension (LLMO-6270 §47) also emits
 * `source__` tags, so a `source__` value is ambiguous — pre-rename authorship on
 * an un-reshaped project, or a producing-system value on a reshaped one — and the
 * two cannot be told apart at this prefix. The origins read tolerates `source__`
 * for the un-reshaped case and accepts that producing-system values ride along on
 * reshaped projects until a dedicated source dimension claims them. That
 * ambiguity is also why this tolerance carries no transition log: a `source__`
 * tag on the read surface does not tell you whether any project is still
 * un-reshaped, so the sweep has to be proved from the tag trees themselves.
 */
export const LEGACY_ORIGIN_ROOT_NAME = 'source';

/**
 * Every name reserved at the root level: each dimension's key AND its upstream
 * root name. Those coincide for four of the five; for `intent` they differ, so
 * both `intent` and `$abv_tags$intent` are reserved.
 *
 * The bare `intent` is reserved even though no root is named that, because
 * {@link dimensionOfRootName} maps it to the intent dimension: a name shadowing
 * it would be READ as the dimension itself, leaving the tree with two entries a
 * reader cannot tell apart at the level that decides a tag's dimension.
 *
 * Its most reachable effect today is on {@link canonicalizeSource}, which reuses
 * this list to refuse a free-text `prompts.source` that folds onto a dimension
 * name. The root-level create paths are already closed by other means — a create
 * without a parent is placed under its dimension's own root, one with a parent
 * must prove in-dimension ancestry, and a patch cannot promote a tag to root — so
 * treat this as defence in depth there rather than the only guard.
 *
 * Both halves are derived from `DIMENSION_PROVISION_ORDER` rather than listed, so
 * a future tidy-up that maps the spread through {@link rootNameOfDimension} —
 * which is what the other consumer of that list does — cannot silently drop the
 * bare spelling and with it the shadowing guard.
 */
export const RESERVED_ROOT_NAMES = Object.freeze([...new Set([
  ...DIMENSION_PROVISION_ORDER,
  ...DIMENSION_PROVISION_ORDER.map(rootNameOfDimension),
])]);
// ^ Grows automatically with the display root names (tag-display-names.md §1
// item 5) once ROOT_DISPLAY_NAME's IDENTITY PLACEHOLDER values become real: this
// is derived through rootNameOfDimension, so no edit is needed here when that
// happens. The Set dedupes the case that coincides today (display === slug).

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
 * `type` value slug → customer-facing display form (tag-display-names.md §1
 * item 4: `branded` → `Branded`, `non-branded` → `Non-branded`).
 *
 * IDENTITY PLACEHOLDER — do not add/remove keys here; only the orchestrator
 * swaps these VALUES in once serenity-docs#407 is merged + signed off.
 */
export const TYPE_VALUE_DISPLAY = Object.freeze({
  [TYPE_VALUE.BRANDED]: TYPE_VALUE.BRANDED,
  [TYPE_VALUE.NON_BRANDED]: TYPE_VALUE.NON_BRANDED,
});

/**
 * Backing map for {@link valueSlugOfDisplayName}'s `type` branch — built once
 * from {@link TYPE_VALUE_DISPLAY}, mirroring {@link SOURCE_LABEL_INVERSE}'s
 * pattern for `source` so the two server-owned display-form inverses stay
 * structurally consistent as this generalizes to more dimensions.
 *
 * @type {Map<string, string>}
 */
const TYPE_VALUE_DISPLAY_INVERSE = new Map(
  Object.entries(TYPE_VALUE_DISPLAY).map(([slug, displayName]) => [displayName, slug]),
);

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

/**
 * Every dimension a caller may address on the create-tag endpoint. This is a
 * MEMBERSHIP set (used only for `.includes` validation), so its order is
 * irrelevant and INTENTIONALLY differs from {@link DIMENSION_PROVISION_ORDER} — that
 * list is provisioning ORDER (`category, intent, origin, type, source`), whereas
 * this is grouped open-then-closed (`category, source, intent, origin, type`).
 * Do not assume the two share an order.
 */
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
  'strategy-chat',
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
 * Canonical producing-system slug → customer-facing TAG NAME (the tree-write
 * boundary map, tag-display-names.md §1 item 3 — "the tag-name map"). Covers
 * every {@link SOURCE_VALUES} entry.
 *
 * FROZEN and EXHAUSTIVE over that set, enforced by a unit test that FAILS the
 * moment a canonical value is added without an entry. There is deliberately NO
 * pass-through slug default — a `SOURCE_LABEL[x] ?? x` fallback is exactly the
 * mechanism by which an internal slug reaches a customer silently
 * (source-dimension.md §7) — and every value in this map must be UNIQUE
 * (bijective): two slugs may never share one tag name (tag-display-names.md §1
 * item 3; a duplicate is a hard upstream 500 at create time and an
 * unresolvable ambiguity at read time).
 *
 * IDENTITY PLACEHOLDER — serenity-docs#407 (the vocabulary sign-off PR) is not
 * yet merged, so every value here is its own key, verbatim. Do NOT add or
 * remove keys here; only the orchestrator swaps these VALUES in once #407
 * merges and the vocabulary is frozen (tag-display-names.md §7 gate 1). (elmo
 * ships its OWN, separate label map behind `SOURCE_BADGE_CONFIG` — the
 * Postgres-backed "label map" of §1 item 3, which DOES cover `llm-generated`
 * many-to-one; that map is WP-D3, out of scope here.)
 */
export const SOURCE_LABEL = Object.freeze(
  SOURCE_VALUES.reduce((acc, slug) => {
    acc[slug] = slug;
    return acc;
  }, /** @type {Record<string, string>} */ ({})),
);

/** Backing map for {@link displayToSlug} — built once from {@link SOURCE_LABEL}. */
const SOURCE_LABEL_INVERSE = new Map(
  Object.entries(SOURCE_LABEL).map(([slug, displayName]) => [displayName, slug]),
);

/**
 * The true inverse of {@link SOURCE_LABEL}: a `source`-dimension TAG NAME →
 * the canonical slug it was minted from. `undefined` for anything that is not
 * a value in {@link SOURCE_LABEL} — in particular a bare slug is NOT
 * automatically its own display name unless the map says so (which, under
 * today's identity placeholders, it does for every entry — see
 * {@link SOURCE_LABEL}'s docs).
 *
 * Built as a real inverse of the map (not a shortcut) so this is a no-op
 * change when {@link SOURCE_LABEL}'s values stop being identity: the read
 * side (tolerant tag-tree resolvers, the Elements boundary) always goes
 * through this function first, exactly as tag-display-names.md §1 item 7
 * requires, with the slug form accepted as its own alias for as long as
 * un-migrated projects exist.
 *
 * @param {string} displayName - a `source`-dimension tag name.
 * @returns {string | undefined} the canonical slug, or `undefined`.
 */
export function displayToSlug(displayName) {
  return SOURCE_LABEL_INVERSE.get(displayName);
}

/**
 * The customer-facing DISPLAY FORM of a value under a SERVER-OWNED dimension —
 * the value itself for `intent`/`origin` (no display rename planned for
 * either; tag-display-names.md §1 item 4), {@link SOURCE_LABEL} for `source`,
 * {@link TYPE_VALUE_DISPLAY} for `type`. Anything outside those maps falls
 * back to the value unchanged, matching {@link rootNameOfDimension}'s
 * "anything outside the taxonomy maps to itself" convention.
 *
 * IDENTITY PLACEHOLDER by construction today (both underlying maps are), so
 * this is a no-op fold until the vocabulary freezes — see
 * {@link valueSlugOfDisplayName} for the inverse the tolerant resolvers pair
 * this with.
 *
 * @param {string} dimension - a server-owned dimension key.
 * @param {string} value - a bare value under that dimension's root.
 * @returns {string} the tag name to create/resolve for that value.
 */
export function displayNameOfValue(dimension, value) {
  if (dimension === DIMENSION.SOURCE) {
    return SOURCE_LABEL[value] ?? value;
  }
  if (dimension === DIMENSION.TYPE) {
    return TYPE_VALUE_DISPLAY[/** @type {keyof TYPE_VALUE_DISPLAY} */ (value)] ?? value;
  }
  return value;
}

/**
 * The canonical slug a server-owned dimension's DISPLAY FORM denotes — the
 * inverse of {@link displayNameOfValue}, generalized across dimensions the way
 * {@link displayToSlug} is `source`-specific. `undefined` when `displayName`
 * is not a mapped display form for that dimension (including when it is
 * simply the bare slug itself — callers that also want to accept the slug as
 * its own alias check for that separately, exactly as the tolerant tag-tree
 * resolvers do).
 *
 * @param {string} dimension - a server-owned dimension key.
 * @param {string} displayName - a bare value AS IT WOULD APPEAR on the tree.
 * @returns {string | undefined} the canonical slug, or `undefined`.
 */
export function valueSlugOfDisplayName(dimension, displayName) {
  if (dimension === DIMENSION.SOURCE) {
    return displayToSlug(displayName);
  }
  if (dimension === DIMENSION.TYPE) {
    return TYPE_VALUE_DISPLAY_INVERSE.get(displayName);
  }
  return undefined;
}

/**
 * The closed-dimension values applied to EVERY AI-generated prompt: the
 * default `Informational` intent (the most common intent for brand-topic
 * prompts; re-classification can refine it later). The `type` value is
 * classified per prompt at generation time (branded vs non-branded — see the
 * handler), so it is NOT seeded here. AI-generated prompts carry `origin/ai`
 * independently from their producing-system `source`.
 *
 * Each entry names a dimension and the bare value beneath it; the caller resolves
 * the pair to an upstream tag id against the project's tree.
 */
export const STANDARD_PROMPT_TAG_VALUES = Object.freeze([
  Object.freeze({ dimension: DIMENSION.ORIGIN, name: ORIGIN_VALUE.AI }),
  Object.freeze({ dimension: DIMENSION.INTENT, name: INTENT_VALUE.INFORMATIONAL }),
]);

/**
 * True when `name` is a reserved dimension-root name ({@link RESERVED_ROOT_NAMES}).
 * Root names are reserved: a customer category may not be called `category`, and
 * a closed value may not be minted at the root level.
 *
 * @param {string} name - a bare tag name.
 * @returns {boolean}
 */
export function isDimensionRootName(name) {
  return (/** @type {readonly string[]} */ (RESERVED_ROOT_NAMES)).includes(name);
}

/**
 * `dimensionOfRootName`'s lookup table: every root-name SPELLING a project may
 * currently carry → its dimension key. Built from {@link DIMENSION_PROVISION_ORDER}
 * so it can never drift from {@link rootNameOfDimension}: for each dimension it
 * registers BOTH the bare dimension key (the pre-rename / un-migrated spelling,
 * tag-display-names.md §1 item 6 — "both forms accepted in") AND
 * `rootNameOfDimension(dimension)` (today's live spelling — `$abv_tags$intent`
 * for `intent`, the identity-placeholder display name for the three renaming
 * dimensions, `origin` unchanged). A `Map` (not a plain object) so a dimension
 * key that collides with `Object.prototype` can never resolve to an inherited
 * member.
 */
const ROOT_NAME_TO_DIMENSION = new Map(
  DIMENSION_PROVISION_ORDER.flatMap((dimension) => [
    [dimension, dimension],
    [rootNameOfDimension(dimension), dimension],
  ]),
);

/**
 * The DIMENSION KEY a root name denotes — the inverse of
 * {@link rootNameOfDimension}, tolerant of BOTH the current live spelling and
 * the bare dimension-key spelling (tag-display-names.md §1 item 6, §5 phase
 * 1) — resolves `category`/`Category`, `type`/`Type`, `source`/`Source`,
 * `intent`/`$abv_tags$intent`, and `origin` (unchanged) alike. This is the
 * fold that keeps `$abv_tags$intent` from leaking out of the tag-tree walk
 * into everything that reasons about dimensions by key, generalized to every
 * root that may display-rename.
 *
 * Identity for anything NOT in {@link ROOT_NAME_TO_DIMENSION} — a customer
 * category name, or any future root this taxonomy does not know about. Note
 * the write and read paths deliberately disagree about a BARE `intent` root:
 * this fold makes the write path treat its children as server-owned, while
 * the Elements read path does not claim them as intents. That asymmetry is
 * intended; do not "fix" one side to match the other.
 *
 * @param {string} rootName - a tag's root-ancestor name, as upstream spells it.
 * @returns {string} the dimension key.
 */
export function dimensionOfRootName(rootName) {
  return ROOT_NAME_TO_DIMENSION.get(rootName) ?? rootName;
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
 * The bare canonical FOLD of a `source` value — trim, lowercase, `_` → `-`
 * (source-dimension.md §3.1) — with none of {@link canonicalizeSource}'s safety
 * guards. This is the SINGLE definition of the transform in this repo: both
 * `canonicalizeSource` (read/tag-write boundary) and the v2 list `source` filter
 * fold (prompts-storage.js) route through it so the spellings can never drift.
 *
 * Coerces with `String()` so a non-string filter value (e.g. a query param parsed
 * as a number/array) folds instead of throwing; `canonicalizeSource` already
 * guards the type before calling, so the coercion is a no-op on that path.
 *
 * @param {unknown} value - a `source` value.
 * @returns {string} the folded value.
 */
export function foldSourceValue(value) {
  return String(value).trim().toLowerCase().replace(/_/g, '-');
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
  const canonical = foldSourceValue(value);
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
