# ADR-005: Opt-in TypeScript type-checking (`checkJs` + JSDoc)

## Context

`spacecat-api-service` is a pure ESM + JSDoc repo — the Helix/Franklin
convention shared across the spacecat fleet. Until now it had **no
type-checking at all**: no `tsconfig.json`, no `typescript` dependency, no
`tsc`/CI step. There was no prior ADR recording the JS-vs-TS convention; this
ADR is the place that records the shift.

The trigger is `src/support/serenity/**`, which now talks to Semrush through the
typed `@adobe/spacecat-shared-project-engine-client` (`openapi-fetch` over a
generated `paths` contract — see
https://github.com/adobe/spacecat-api-service/pull/2643 and
https://github.com/adobe/spacecat-shared/pull/1706 ). A generated contract is
only worth shipping if something actually checks it. A scoped `tsc --checkJs`
probe over `/serenity` also surfaced genuine type-modeling gaps in our own code
(below), so the value is twofold: enforce the Semrush contract **and** catch our
own latent shape/null bugs.

## Decision

Introduce **opt-in** type-checking via `checkJs` + JSDoc — **no `.ts` source,
no emit**. Files opt in one at a time with a `// @ts-check` pragma. The initial
opted-in scope is every file under `src/support/serenity/**`. Enforced in CI
(blocking) and in the pre-commit hook.

### Infrastructure

- `typescript` + `@types/node` added as exact devDependencies.
- `tsconfig.json` at the repo root (type-checks `.js`, no emit). Adapted from the
  only `tsconfig` in the ecosystem,
  `spacecat-shared/packages/spacecat-shared-data-access/tsconfig.json` (which
  compiles `.ts`→`.d.ts`; ours type-checks JS with `noEmit`).
- `npm run type-check` → `tsc -p tsconfig.json`.
- A self-contained, **blocking** `type-check` job in `.github/workflows/ci.yaml`
  (the reusable `adobe/mysticat-ci` service-ci workflow has no type-check seam
  yet, so it runs as a local job rather than an upstream input).
- `npm run type-check` added to `.husky/pre-commit`.

### `tsconfig.json` — the load-bearing choices

The authoritative config is **`tsconfig.json` at the repo root** — read it there
rather than from a copy in this ADR. We deliberately do **not** reproduce the file
here: the `include` list grows with every ratchet step (each newly opted-in file
or directory is added to it), so a pasted copy would drift out of date. The
load-bearing, non-obvious compiler choices — and why they are set the way they
are — are explained below.

**`checkJs: false`, not `true` (the opt-in seam).** This is the crux and it is
the opposite of what a first reading suggests. With `checkJs: true`, TypeScript
reports errors in **every** `.js` file in the program graph — and because tsc
follows imports, `include`-ing serenity alone drags ~260 errors out of
transitively-imported non-serenity files. With `checkJs: false`, only files
carrying a `// @ts-check` pragma are error-reported; everything else is still
parsed for **types** but not flagged. That is exactly the gradual-adoption seam:
add `// @ts-check` to a file to turn enforcement on for it, one file at a time.
(A `// @ts-check` pragma is inert under `checkJs: true` — it only opts a file
*in*, and under `checkJs:true` everything is already in.)

**`types: ["node"]`.** Required so `node:crypto` / `process` / `Buffer` resolve.
Without it, `node:crypto` reported `TS2591` even with `@types/node` installed.

**`noImplicitAny: false` + `useUnknownInCatchVariables: false`.** The pragmatic
floor. Full `strict` over serenity reports ~500 errors, ~372 of which are just
implicit-`any` params (missing `@param` types). `noImplicitAny:false` removes
that noise. `useUnknownInCatchVariables:false` keeps `catch (e)` variables typed
`any` (the default-pragmatic pairing) so this first pass is not dominated by
~24 mechanical `catch` narrowings — those are deferred to the strict ratchet.

## What the probe found and how we fixed it

The scoped probe reported **45 genuine errors** (the original estimate of ~15
had drifted as the code evolved — e.g. the issue's `site-linkage` file no longer
exists and many new `catch` blocks were added). After
`useUnknownInCatchVariables:false`, **21** remained — all legitimate modeling
fixes. The notable ones:

- **`ErrorWithStatusCode` did not model `code`.** Six serenity call sites assign
  `err.code = ERROR_CODES.*` dynamically, but the class only declared `.status`.
  Fixed by declaring `code` (and typing `status`) on the class in
  `src/support/utils.js`. **One fix, six errors cleared.**

- **`never[]` from incomplete JSDoc `@param` mapping.** `handleCreateMarketSubworkspace`
  and `generateAndAttachPrompts` take a destructured options object with `= []`
  defaults. Their leading positional params (`transport`, `brand`, `body`, `log`,
  …) were **undocumented**, which broke JSDoc `@param`→parameter association, so
  the destructured options got no declared types and TS inferred its array fields
  as `never[]`. **Completing the `@param` tags** (the types were already authored
  for the options fields) let TS bind them and cleared the whole cluster. This is
  the kind of latent documentation gap the checker is meant to surface.

- **Null-safety after `hasText` guards.** `resolveWorkspaceId` /
  `preResolvedWorkspaceId` are `string | null`; code guards them with
  `if (!hasText(x)) throw` and then uses `x` as a `string`. `hasText` is a plain
  non-empty-string predicate — **not** a type guard — so TS does not narrow
  across it. Fixed **locally** by adding an explicit truthiness check
  (`!x || !hasText(x)`) / a `x && hasText(x)` ternary so the `string | null` →
  `string` narrowing is visible to TS. (We deliberately did **not** turn the
  shared `hasText` into a TS type guard — that is not what the helper is for; the
  null-safety is this repo's concern.)

- **`readonly` constant arrays → mutable param.** `STANDARD_PROMPT_TAGS` /
  `PROJECT_STANDARD_TAGS` are `readonly`; passed to `string[]` options fields.
  Fixed by spreading a mutable copy at the call site (`[...CONST]`) — the callee
  only reads them.

- Misc: an optional `@param` (`[removedDomains=[]]`) declared before required
  params (`TS1016`) corrected to required; a `function`-typed `@param` that
  defaults to `null` widened to `function|null`; a result-union property access
  narrowed with a cast.

**Principle carried forward:** a type error can mean the **types/spec are wrong**,
not our code (the issue's original motivation — a Semrush swagger defect fixed
upstream via overlay CR4). We hit a smaller instance of this: the published
`hasText(str: string)` type is narrower than its `@param {*}` runtime contract.
We chose to absorb that **locally** (narrow before calling) rather than widen the
shared helper's published type, keeping this change self-contained to api-service.

## Scope expansion: Serenity controllers

The first ratchet-step-1 expansion beyond the support files: `// @ts-check` +
`include` for `src/controllers/serenity.js` and `src/controllers/brands.js`
(tracked by https://github.com/adobe/spacecat-api-service/issues/2678).
`brands.js` is the **general** brands controller (not purely Serenity), so
type-checking it benefits the whole controller surface, not just `/serenity`.

The probe reported **50 errors** (serenity 26, brands 24 — matching the issue's
~49 estimate). The notable class — another instance of "the published types are
wrong, not our code":

- **Over-narrow http-utils `ok()`.** `@adobe/spacecat-shared-http-utils`'s
  `index.d.ts` types `ok(body?: string)`, but at runtime `ok` delegates to
  `createResponse`, whose own JSDoc is `@param {object|string|Buffer} body` (it
  JSON-stringifies). The controllers' dominant idiom — `ok({ ... })` — was
  therefore flagged ~21 times as "not assignable to parameter of type `string`".
  The proper fix is upstream (the shipped `.d.ts` is the artifact that is wrong),
  but rather than carry a local ambient augmentation of a third-party module — or
  cast every call site to `any` (forbidden) — we **switched the flagged object-bodied
  `ok(x)` calls to the sibling `createResponse(x, 200)`**, which `index.d.ts`
  already types correctly as `(body: object, …)`. `ok(x)` is literally
  `createResponse(x, 200, {})`, so this is runtime-identical; both controllers
  already use `createResponse` elsewhere, so it is not a foreign idiom. The
  `any`-bodied `ok()` calls (whose argument is an untyped helper return) are left
  as-is and will swap the same way when `noImplicitAny` ratchets on. The five
  deliberate empty-body responses written `createResponse(null, 204)` became
  `noContent()` (also 204), which drops the stray `"null"` JSON body — a 204 must
  carry no body, so this is a spec-correctness improvement, not a regression. (If
  the upstream `ok` type is ever corrected + released, these call sites can revert
  to `ok(x)`.)

The remaining errors were fixed with the idioms already established for the
support files (no shared helper signatures widened, no blanket `any` casts):

- **Null/undefined narrowing at boundaries.** `auth.parentWorkspaceId`
  (`string | null`) → `?? ''` for callees that already treat empty like null
  (verified: `ensureSubworkspace`/`handleCreateMarketSubworkspace` throw a 404 on
  a falsy parent), `?? undefined` where the param is `string | undefined`;
  `!hasText(x)` positive checks rewritten `!x || !hasText(x)` / `x && hasText(x)`;
  `?? undefined` on `ensureMarketSite`'s nullable `brandId`/`domain`.
- **Inferred `{}` from a dynamically-keyed object.** `parsedQuery`'s `out` was
  inferred `{}` (so property assignment failed); annotated
  `Record<string, string | string[] | number | null>`.
- **`readonly` constant arrays → mutable param.** Same `[...STANDARD_PROMPT_TAGS]`
  spread fix as the support files, at the two activate/create-market call sites.
- **`{ error } | { brandUuid, … }` union leaves `brandUuid` `string | undefined`.**
  `authorize()` guarantees a non-null brand (it 404s a missing one), so a single
  local assertion (`/** @type {string} */ (auth.brandUuid)`) at the top of the
  handler covers the typed data-access calls.
- **Incomplete `@param` tags on `upsertPrompts` / `upsertBrand`.** Both destructure
  params the controllers pass (`classifyIntent`, `classifyIntentBatchTimeoutMs`;
  `log`, `forceBrandId`, `semrushWorkspaceId`) but never documented them, so TS
  flagged them as excess properties. Completing the (doc-only) `@param` tags to
  match the real signatures cleared the cluster — the same "complete the JSDoc"
  fix the support-file pass relied on.

The only behavioural touch is the `createResponse(null, 204)` → `noContent()`
swap, which removes the stray `"null"` body from those 204 responses (spec-correct
— a 204 carries no body). Everything else is types/JSDoc-only. All controller
tests stay green.

## Consequences

- The Semrush `paths` contract is now actually enforced for every `@ts-check`'d
  serenity file. Drift between our calls and the generated types fails CI.
- `tsc` runs on every commit (pre-commit) and every PR (CI). The serenity-scoped
  program is small, so the check is fast.
- No runtime change: `noEmit`, JSDoc-only, no `.ts`. The single behavioural touch
  is `ErrorWithStatusCode` now initializing `this.code = undefined` — verified
  against the existing test suite (all serenity + utils tests green).

## Ratchet path (future work)

The pragmatic floor is intentional. Tighten in steps, each its own PR, by
removing one relaxation and fixing the surfaced errors:

1. **Expand opt-in scope** — add `// @ts-check` to more directories beyond
   serenity, one area at a time. Done so far: `src/support/url-utils.js` and the
   two Serenity controllers (`src/controllers/serenity.js`, `src/controllers/brands.js`
   — see "Scope expansion: Serenity controllers"). The rest of `src/controllers/**`
   is the natural next area.
2. **`useUnknownInCatchVariables: true`** — narrow each `catch (e)` with
   `instanceof Error` / type guards (~24 sites today).
3. **`noImplicitAny: true`** — add `@param` types to the implicit-`any` params
   (~372 today). At that point a per-file `// @ts-check` is no longer needed and
   the repo can consider `checkJs: true` with `// @ts-nocheck` opt-outs instead.
