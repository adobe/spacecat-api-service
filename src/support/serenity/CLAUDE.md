# Serenity support — type-checking convention

This directory (and the Serenity controller logic that drives it) is the
**opt-in TypeScript type-checking scope** for spacecat-api-service. The point is
to lean on the typed API clients and typed models as hard as possible so we make
fewer wiring mistakes against Semrush / data-access / PostgREST.

See `docs/decisions/005-opt-in-type-checking.md` for the why and the ratchet
plan. `npm run type-check` (`tsc -p tsconfig.json`) is a **blocking** gate in CI
(`.github/workflows/ci.yaml`) and in `.husky/pre-commit`.

## Rules for every JS file here

1. **Always add `// @ts-check`** as the first non-license line (blank line above
   and below). Every file in this directory carries it; a new file without it is
   silently NOT type-checked, because tsconfig uses `checkJs: false` — the
   per-file pragma is the opt-in seam, not the `include` glob.
2. **Keep the file inside the tsconfig `include` scope.** New subfolders under
   `src/support/serenity/**` are covered automatically. A Serenity file placed
   elsewhere (e.g. a controller) must be added to `include` explicitly AND carry
   the pragma — both are required; either alone type-checks nothing.
3. **Use the typed clients/models, don't reach around them.** Prefer the typed
   transport (`rest-transport.js`) and the typed data-access models over raw
   PostgREST calls or `any`. If a value is genuinely untyped, narrow or assert it
   locally at the boundary — never widen a shared helper's signature to make a
   call site compile.
4. **Write complete JSDoc `@param` tags.** Incomplete tags break TS's
   `@param`→param mapping (e.g. a destructured options arg with `= []`/`= {}`
   defaults then infers `never[]`/missing-prop errors). Document every positional
   param, in order.

## Known idioms / gotchas (matched in the existing files)

- **`hasText` is NOT a type guard.** `@adobe/spacecat-shared-utils`'s `hasText`
  is typed `(str: string): boolean`, so it does not narrow `string | null` →
  `string`. Narrow locally: `if (!x || !hasText(x)) { ... }`. Do not change the
  shared helper.
- **data-access models are type-only exports.** `@adobe/spacecat-shared-data-access`'s
  `index.d.ts` re-exports its models with `export type *`, so `import { Site }`
  binds a *type*, not the runtime class value. To use a static like
  `Site.DELIVERY_TYPES.OTHER`, reach the value through a namespace import and
  assert the shape you need (see `site-linkage.js`) rather than hard-coding the
  literal.
- **Options arg with a default.** When a function takes `({ ... } = {})`, mark
  the options object and its fields optional in JSDoc (`@param {object} [opts]`,
  `@param {string} [opts.foo]`) and narrow the fields before use — otherwise the
  `= {}` default trips a "missing required properties" error.
- Pragmatic floor (see ADR-005): `noImplicitAny: false` and
  `useUnknownInCatchVariables: false`. Don't rely on those staying relaxed — the
  ratchet tightens them later.
