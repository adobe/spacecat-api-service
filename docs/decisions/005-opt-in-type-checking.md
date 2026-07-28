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
- `npm run type-check` → both tiers: `type-check:base` (`tsc -p tsconfig.json`)
  then `type-check:strict` (`tsc -p tsconfig.strict.json`). Each is separately
  runnable; the composite is what CI and pre-commit invoke.
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

That floor has a **specific, load-bearing cost**, measured rather than assumed:
under `noImplicitAny:false` TypeScript suppresses `TS2339` (unknown member) in
JS files **outright** — including against a fully-typed receiver. So a
method-name typo, and any mistake about a response's shape, is invisible to this
tier no matter how well the value is typed. That is what `tsconfig.strict.json`
exists to close, file by file.

### `tsconfig.strict.json` — the strict tier

A second config extends the base one with `noImplicitAny: true` over an
**explicit, deliberately-grown file list** (`src/support/serenity/rest-transport.js`
today). `npm run type-check` runs both tiers — `type-check:base` then
`type-check:strict` — so the CI job and the pre-commit hook need no knowledge of
the split, and the strict pass cannot be forgotten. A file joins the list once its
implicit-`any` params carry `@param` types.

The list names the program's **roots**, not the set of files that get checked.
`noImplicitAny` is a program-wide option, so every `// @ts-check` file reachable by
import from a root is reported as well, whether or not it appears in the list — a
program rooted only at `subworkspace-projects.js` also reports `locations.js`, which
imports pull in. The unit of work is therefore an import closure, not a file. Today's
one-entry list happens to pull in nothing extra only because `rest-transport.js`'s
repo-side imports carry no `// @ts-check` pragma; that stops being true at the second
entry.

`rest-transport.js` leads because it is the module that defines the outbound
Semrush contract for the whole serenity surface: it is where an unchecked member
access is most expensive, and it cost 14 mechanical annotations to bring up.

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

## How far the gate reaches

A generated contract is only enforced where a **typed value** actually meets the
generated client. Two properties of JSDoc-typed JS decide that reach, and both are
easy to lose by accident:

- **`@param {object} x` is `any`.** Every member access, argument count and
  argument type on such a value is unchecked. A lifecycle function that receives
  the Semrush transport this way has no checking on any call it makes through it,
  however sound the client's own types are.
- **An undocumented parameter is optional.** Naming the transport is therefore
  not sufficient on its own: against a correctly inferred 35-method object whose
  methods carry no `@param` tags, TS reports `createSubworkspace()` as taking
  "0–2 arguments" and accepts the call. Arity checking only returns once the
  methods' own parameters are documented.

Both halves are required, and both are in place for the transport:
`rest-transport.js` exports a `SerenityTransport` typedef and documents every
method's parameters, deriving each request shape **from the generated contracts**
(`Parameters<PeTransport['createProject']>[0]['body']`,
`UmSchemas['handlers.createWorkspaceV2Resources']`) rather than restating it, so a
vendor spec change surfaces at the call site instead of on the wire. Every
serenity function that receives the transport annotates it `SerenityTransport`.

`test/types/base/serenity-transport.types.js` pins this with `@ts-expect-error`
assertions: it is type-checked, never executed, and fails the build if the
arity/argument/body-shape errors it expects ever stop happening. Its strict-tier
counterpart, `test/types/strict/serenity-transport-strict.types.js`, pins the
unknown-member error that only that tier reports; the two live in separate
directories because a `TS2339` directive is unused — and so itself an error —
under the base tier.

### The spec-generated mocks are the contract gate

Type-check enforces the shapes our code *states*. It cannot enforce what it cannot
see, and — while `noImplicitAny` stays off outside the strict tier — it never
reports an unknown member. The gate that validates a real outbound **request body**
against the vendor spec is the Counterfact vendor mock, which is generated from
that spec and refuses a non-conforming body. It runs only in the `it-postgres`
suite, which makes that suite, not `type-check`, the de-facto contract gate
against Semrush. Treat an `it-postgres` failure on a mock-backed serenity test as
a contract violation first and a test-wiring problem second.

A live probe is **not** a substitute: the Semrush gateway accepts bodies the spec
forbids (an omitted-but-required `resources` key among them), so a green
end-to-end run against the real API cannot detect this class of defect at all.

## Consequences

- The Semrush contract is enforced wherever a typed value reaches the generated
  client — which, for the whole serenity surface, means every call through the
  transport. Drift between those calls and the generated types fails CI.
- `tsc` runs on every commit (pre-commit) and every PR (CI). The serenity-scoped
  program is small, so the check is fast.
- Nothing is emitted: `noEmit`, JSDoc-only, no `.ts`. The gate has nonetheless
  changed behaviour four times, each because it surfaced something real:
  `ErrorWithStatusCode` now initializes `this.code = undefined`; a `.filter(Boolean)`
  in `handlers/markets.js` became an explicit `!== undefined`, since `Boolean` does
  not narrow; `usersBaseUrl` binds its env value before guarding it, because
  `hasText` cannot accept a `string | undefined`; and `handleDeleteMarketSubworkspace`
  now treats a listing entry whose contract-nullable `id` is absent as no project at
  all, rather than addressing an upstream delete and a mapping-row tombstone by a
  missing id. Each is covered by the existing suites.

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
3. **`noImplicitAny: true`** — grow `tsconfig.strict.json`'s file list until it
   covers the base `include` set, then fold the two configs back into one. This is
   the step that restores `TS2339`, so it is what finally makes an unknown member
   or a wrong response shape a build failure rather than a runtime surprise.
   Flipping it across the whole base `include` set today reports **705** errors:

   | code | count | nature |
   |---|---|---|
   | TS7006 / TS7031 / TS7034 / TS7005 / TS7053 | 324 | missing parameter and variable annotations |
   | TS2339 | 351 | member access on a value annotated `{object}` |
   | TS2345 / TS2322 / TS18047 | 28 | assignability and possibly-null |
   | TS7016 | 2 | a dependency ships no declarations |

   Those errors are concentrated in `controllers/brands.js` (151),
   `handlers/markets-subworkspace.js` (62), `handlers/markets.js` (53) and
   `controllers/serenity.js` (52), so take it in steps rather than one sweep.

   **Grow the strict list leaf-first, and do not use those per-file counts to
   order the work.** Because the tier follows imports, the cost of adding a file
   is its whole import closure. `controllers/brands.js` owns 151 errors but sits
   near the top of the graph: rooting a program there reports **505 errors across
   23 files**. `handlers/markets.js` owns 53 and pulls in 99 across 6. A leaf such
   as `support/serenity/errors.js` or `support/serenity/locations.js` costs 1.
   Ordering by owned errors therefore picks the most expensive step available.
   Measure a candidate before adding it — copy `tsconfig.strict.json`, set
   `include` to just that file, and run `tsc` against it.

   One shortcut is worth taking before any of that, because it cuts across every
   file rather than sitting inside one: a shared `log` typedef. 79 of the 351
   `TS2339` are logger-method accesses (`info`/`warn`/`error`/`debug`), and `log`
   is a small, stable shape, so one typedef retires them in a uniform mechanical
   pass and shrinks every per-file step that follows. `context` looks like the
   same opportunity and is not — it is the wrapper-assembled universal context
   (`dataAccess`, `env`, `sqs`, `s3Client`, `imsClient`, `attributes`, … see the
   middleware stack in `src/index.js`), so typing it accurately is a design task,
   and an inaccurate typedef relocates errors instead of retiring them.

   Once `noImplicitAny` is on across the whole base `include` set, the two configs
   fold back into one, the per-file `// @ts-check` pragma is no longer needed, and
   the repo can consider `checkJs: true` with `// @ts-nocheck` opt-outs instead.
