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

/**
 * Dual-mode Semrush credential provider (LLMO-7029, PR-3b preparation).
 *
 * Design of record: adobe/mysticat-architecture#248 §6.2/§6.3
 * (`products/llmo/spec-brand-claims-semrush-ingestion-feed.md`). Upstream blocker:
 * LLMO-6836.
 *
 * The upstream technical-account (TA) decision is still contested along two axes
 * (spec §6.2 "the two pluggable knobs"). This provider implements BOTH so the eventual
 * landing is a config flip, not a rewrite:
 *
 *   Knob A -- credential granularity: one SHARED technical account (Vivek) vs one
 *             PER-ORG TA (Ravi/security). Controls only the credential scope/cache KEY.
 *   Knob B -- workspace selection: `workspaceId` supplied in the REQUEST (Vivek) vs
 *             `ims_org_id`-from-token -> workspace mapping (Semrush/security-preferred,
 *             TOKEN_ORG_MAPPING). Controls only whether the descriptor's `workspaceHint`
 *             is read from the request or from an injected mapping lookup.
 *
 * Default-to-code (spec §6.2): PER_ORG + TOKEN_ORG_MAPPING -- the combination most
 * likely to survive a security review (tenant isolation; Semrush refuses a
 * `workspaceId` in the payload). Landing on SHARED / REQUEST later is a narrowing,
 * not a redesign.
 *
 * Everything that could bind this to a live credential or to a concrete
 * brand -> org -> workspace table is an INJECTED seam:
 *   - resolveOrgId(brand, env)          -> the `ims_org_id` for the request context
 *   - resolveRequestWorkspace(brand, env) -> the `workspaceId` supplied in the request
 *                                           (Knob B = REQUEST)
 *   - lookupWorkspaceForOrg(imsOrgId, env) -> the `workspaceId` for an org
 *                                           (Knob B = TOKEN_ORG_MAPPING; candidate
 *                                           mapping source: serenity-docs INDEX.md)
 *   - mintToken(scope, env)             -> Promise<MintResult> for the resolved scope
 *
 * No brand/org/workspace value is hardcoded here -- the built-in context extractors
 * only read fields off the object the caller passes in. This module registers NOTHING:
 * the seam stays inert until a future PR (3b) calls `setSemrushCredentialProvider()`
 * from `semrush-credential-resolver.js` with an instance built here.
 *
 * @typedef {import('./semrush-credential-resolver.js').SemrushCredential} SemrushCredential
 * @typedef {import('./semrush-credential-resolver.js')
 *   .SemrushCredentialProvider} SemrushCredentialProvider
 * @typedef {import('./semrush-credential-resolver.js').MintResult} MintResult
 */

/** Knob A -- how many technical accounts back the feed. */
export const CredentialGranularity = Object.freeze({
  /** One shared TA for every brand (Vivek). */
  SHARED: 'shared',
  /** One TA per customer org (Ravi/security). */
  PER_ORG: 'per-org',
});

/** Knob B -- where the target workspace comes from. */
export const WorkspaceSource = Object.freeze({
  /** `workspaceId` is supplied in the request (Vivek). */
  REQUEST: 'request',
  /** `ims_org_id`-from-token is mapped to a workspace (Semrush/security-preferred). */
  TOKEN_ORG_MAPPING: 'token-org-mapping',
});

/**
 * Default-to-code combination (spec §6.2): per-org TA + `ims_org_id` -> workspace
 * mapping.
 */
export const DEFAULT_DUAL_MODE_CONFIG = Object.freeze({
  credentialGranularity: CredentialGranularity.PER_ORG,
  workspaceSource: WorkspaceSource.TOKEN_ORG_MAPPING,
});

/** Stable cache/scope key for the single shared TA (Knob A = SHARED). */
const SHARED_SCOPE_KEY = 'semrush-ta:shared';

/** Per-org cache/scope key (Knob A = PER_ORG). */
function perOrgScopeKey(imsOrgId) {
  return `semrush-ta:org:${imsOrgId}`;
}

/**
 * Built-in `ims_org_id` extractor: reads the org claim off the request context. Never
 * consults a hardcoded table -- a bare brand-id string carries no org, so it yields
 * `null` and the caller falls back to the shared credential path.
 */
function defaultResolveOrgId(brand) {
  if (!brand || typeof brand !== 'object') {
    return null;
  }
  return brand.imsOrgId ?? brand.ims_org_id ?? brand.orgId ?? null;
}

/**
 * Built-in request-workspace extractor: reads a `workspaceId` the caller placed on the
 * request context (Knob B = REQUEST). Never consults a hardcoded table.
 */
function defaultResolveRequestWorkspace(brand) {
  if (!brand || typeof brand !== 'object') {
    return null;
  }
  return brand.workspaceId ?? brand.workspace_id ?? null;
}

function assertGranularity(value) {
  if (value !== CredentialGranularity.SHARED && value !== CredentialGranularity.PER_ORG) {
    throw new Error(
      `createDualModeSemrushCredentialProvider: unknown credentialGranularity "${value}"`,
    );
  }
}

function assertWorkspaceSource(value) {
  if (value !== WorkspaceSource.REQUEST && value !== WorkspaceSource.TOKEN_ORG_MAPPING) {
    throw new Error(
      `createDualModeSemrushCredentialProvider: unknown workspaceSource "${value}"`,
    );
  }
}

/**
 * Build a dual-mode credential provider suitable for
 * {@link import('./semrush-credential-resolver.js').setSemrushCredentialProvider}.
 *
 * The returned function has the exact provider shape the resolver expects
 * (`(brand, env) => SemrushCredential | null`). A `null` result means "no per-brand
 * credential" and the transport falls back to the shared `client_credentials` path.
 *
 * @param {object} [options]
 * @param {{credentialGranularity?: string, workspaceSource?: string}} [options.config]
 *   overrides merged over {@link DEFAULT_DUAL_MODE_CONFIG}.
 * @param {(brand: unknown, env: object) => (string | null)} [options.resolveOrgId]
 *   resolves the `ims_org_id` for the request context (defaults to reading the org
 *   claim off the context object).
 * @param {(brand: unknown, env: object) => (string | null)} [options.resolveRequestWorkspace]
 *   resolves the request-supplied `workspaceId` (Knob B = REQUEST; defaults to reading
 *   `workspaceId` off the context object).
 * @param {(imsOrgId: string, env: object) => (string | null)} [options.lookupWorkspaceForOrg]
 *   maps an `ims_org_id` to its workspace (Knob B = TOKEN_ORG_MAPPING; REQUIRED for that
 *   mode; candidate source: serenity-docs INDEX.md). Never hardcode the mapping here.
 * @param {(scope: object, env: object) => Promise<MintResult>} options.mintToken
 *   mints the TA token for the resolved credential scope (REQUIRED). Injected so this
 *   module never holds a live credential.
 * @returns {SemrushCredentialProvider}
 */
export function createDualModeSemrushCredentialProvider(options = {}) {
  const {
    config: overrides = {},
    resolveOrgId = defaultResolveOrgId,
    resolveRequestWorkspace = defaultResolveRequestWorkspace,
    lookupWorkspaceForOrg,
    mintToken,
  } = options;

  if (typeof mintToken !== 'function') {
    throw new Error('createDualModeSemrushCredentialProvider: mintToken must be a function');
  }

  const config = { ...DEFAULT_DUAL_MODE_CONFIG, ...overrides };
  const { credentialGranularity, workspaceSource } = config;
  assertGranularity(credentialGranularity);
  assertWorkspaceSource(workspaceSource);

  if (
    workspaceSource === WorkspaceSource.TOKEN_ORG_MAPPING
    && typeof lookupWorkspaceForOrg !== 'function'
  ) {
    throw new Error(
      'createDualModeSemrushCredentialProvider: workspaceSource "token-org-mapping" '
      + 'requires a lookupWorkspaceForOrg seam',
    );
  }

  /** @type {SemrushCredentialProvider} */
  return function dualModeProvider(brand, env) {
    const imsOrgId = resolveOrgId(brand, env) || null;

    // Knob A: credential granularity -> credential scope/cache key.
    let key;
    if (credentialGranularity === CredentialGranularity.SHARED) {
      key = SHARED_SCOPE_KEY;
    } else {
      // per-org: without an org claim we cannot scope a TA -> defer to the shared
      // fallback path (a null result, per spec §6.2).
      if (!imsOrgId) {
        return null;
      }
      key = perOrgScopeKey(imsOrgId);
    }

    // Knob B: workspace selection -> workspaceHint (advisory; the transport does not
    // consume it yet -- live wiring is PR-3b).
    let workspaceHint;
    if (workspaceSource === WorkspaceSource.REQUEST) {
      workspaceHint = resolveRequestWorkspace(brand, env) || undefined;
    } else {
      // token-org-mapping: the org claim is the join key into the mapping.
      if (!imsOrgId) {
        return null;
      }
      workspaceHint = lookupWorkspaceForOrg(imsOrgId, env) || undefined;
    }

    const scope = Object.freeze({
      credentialKey: key,
      granularity: credentialGranularity,
      imsOrgId: imsOrgId ?? undefined,
      workspaceId: workspaceHint,
      brand,
    });

    return {
      key,
      getAuthToken: (mintEnv) => mintToken(scope, mintEnv ?? env),
      workspaceHint,
    };
  };
}
