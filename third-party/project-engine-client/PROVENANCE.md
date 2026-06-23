# Vendored: @adobe/spacecat-shared-project-engine-client

This directory is a **verbatim vendored copy** of the runtime source of
`@adobe/spacecat-shared-project-engine-client` — the typed Semrush Project
Engine client (`openapi-fetch` wrapper + IMS-Bearer auth + retry).

It is vendored, not consumed from npm, because the upstream package is
`private: true` and the team does not want it published to public npm, while the
`@adobe` scope in this repo is bound to the public registry (so a private
registry redirect for a single package is not possible). See the discussion on
the api-service adoption PR.

## Source

- Package: `@adobe/spacecat-shared-project-engine-client`
- Version: `1.1.0`
- Upstream path: `packages/spacecat-shared-project-engine-client/src/`
- Commit: `0465ab0e2897a32b64f377241750c8ea0762f0e7` (adobe/spacecat-shared)

## What is vendored

Only the runtime JS is copied — `client.js`, `internal.js`, `index.js`. The
upstream `generated/types.ts` (and `index.d.ts`) are **type-only** artifacts;
this repo runs no `tsc` over `src`, so they carry no runtime value and are
omitted. The JSDoc `import('./generated/types.js')` references in `client.js`
are inert comments.

## Runtime dependency

Requires `openapi-fetch` (declared in this repo's `package.json`), pinned to the
version upstream depends on (`0.17.0`).

## Keeping in sync

These three files are kept **byte-identical** to upstream — a diff against the
source tree at the commit above should be empty. To update, re-copy the three
`.js` files from the upstream `src/` and bump the version/commit above. Do not
hand-edit the vendored sources; `third-party/*` is eslint-ignored precisely so
this copy stays faithful.
