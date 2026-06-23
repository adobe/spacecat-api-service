# TEMPORARY vendored Semrush clients — REMOVE once published to npm

`third-party/spacecat-shared-project-engine-client/` and
`third-party/spacecat-shared-user-manager-client/` are **temporary, vendored copies**
of two `@adobe/spacecat-shared-*` packages, wired into `package.json` as `file:` deps.

## Why they're here

Both packages are **merged on `adobe/spacecat-shared` `main` but not yet published to
npm**. The repo publishes via npm OIDC Trusted Publishing, which works for the existing
packages but not for a brand-new package name until a trusted publisher is registered on
npmjs (an Adobe Open Source Office / npm-org-admin action — `Grp-opensourceoffice@adobe.com`
/ Slack `#guild-opensource`). Until that one-time bootstrap is done, `npm install` of the
real versions 404s, so the typed Semrush transport (`src/support/serenity/rest-transport.js`)
can't be built/shipped. Vendoring unblocks development in the meantime.

## Provenance (do NOT hand-edit these files)

Copied verbatim from `adobe/spacecat-shared` `origin/main`, the published file set only
(`package.json` + `src/`, i.e. `files: ["src"]`):

| vendored dir | source package | target published version |
|---|---|---|
| `spacecat-shared-project-engine-client/` | `packages/spacecat-shared-project-engine-client` | **1.1.1** |
| `spacecat-shared-user-manager-client/` | `packages/spacecat-shared-user-manager-client` | **1.1.0** |

(The vendored `package.json` versions read `1.1.0` / `1.0.0` — the unreleased source state;
the *target* published versions consumers should pin are `1.1.1` / `1.1.0`. `1.0.0` of
user-manager is the clientless foundation slice — do not pin it.)

Their only runtime dependency is `openapi-fetch`, installed transitively.

## How to remove (once the packages publish)

1. In `package.json`, change the two deps back to the published versions:
   - `"@adobe/spacecat-shared-project-engine-client": "1.1.1"`
   - `"@adobe/spacecat-shared-user-manager-client": "1.1.0"`
2. `npm install` to regenerate `package-lock.json` against the registry.
3. Delete both `third-party/spacecat-shared-*-client/` directories and this file.
4. No source changes needed — imports are `@adobe/spacecat-shared-*` either way.

Tracking: spacecat-shared publish bootstrap (OSS office / trusted publisher) +
spacecat-api-service serenity typed-transport adoption.
