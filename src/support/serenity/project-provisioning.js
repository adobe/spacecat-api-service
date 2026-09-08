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

import { hasText } from '@adobe/spacecat-shared-utils';

import { ensureOwnBrandBenchmark, assertMainBrandBenchmark } from './brand-urls.js';

/** @typedef {import('./rest-transport.js').SerenityTransport} SerenityTransport */

/**
 * Thrown when the upstream accepts a create but returns no project id.
 *
 * A class rather than a message match: the handlers translate this into a 502
 * (`createNoProjectId`) that callers use to decide whether a retry is safe, and a
 * `e.message === '...'` comparison would stop matching the moment the wording is
 * reworded — silently downgrading that 502 to an unhandled 500, with nothing in the
 * type system or the suite to notice.
 */
export class CreateNoProjectIdError extends Error {
  constructor() {
    super('Upstream createProject returned no id');
    this.name = 'CreateNoProjectIdError';
  }
}

/**
 * The PATCH body that sets the url an AIO project tracks.
 *
 * `type` is required on every project PATCH regardless of which field is being set,
 * and omitting it is rejected upstream; `primary_url` goes FLAT, which is what
 * `model.ProjectUpdateRequest` declares — the nested `settings.ai` spelling is
 * accepted and ignored, so it would look like success while changing nothing. Both
 * PATCH call sites build their body here so neither requirement has to be
 * re-remembered per edit.
 *
 * Note the create body also carries `type: 'ai'`, but it is a different shape with
 * different required fields and deliberately does not use this.
 *
 * @param {string} primaryUrl - the url the project should track, e.g. `nba.com/kings`.
 * @returns {{type: 'ai', primary_url: string}} the PATCH body.
 */
export function primaryUrlPatchBody(primaryUrl) {
  return { type: 'ai', primary_url: primaryUrl };
}

/**
 * Provisions one Semrush AIO project: create, then set the url it tracks, then
 * publish.
 *
 * The three calls are one unit because the upstream forces them to be. A project's
 * `domain` is accepted only at create; its `settings.ai.primary_url` — the url the
 * project actually TRACKS — is IGNORED at create and honoured only on a PATCH,
 * whether it is sent top-level, nested under `settings.ai`, or alone. So a project
 * on a subdomain or a subpath cannot be provisioned in one call, and the sequence
 * cannot be reordered: the publish has to come last or the corrected value stays in
 * draft.
 *
 * `primary_url` goes FLAT in the PATCH body, which is what
 * `model.ProjectUpdateRequest` declares. The nested spelling is accepted and
 * ignored — it would look like success while changing nothing. `type` is required
 * on every PATCH whatever field is being set.
 *
 * Both provisioning call sites share this rather than each running their own
 * sequence, because the failure mode of duplicating it is silent: one path gains
 * the PATCH and the other does not, and the difference only shows up as brands
 * tracking the wrong url months later.
 *
 * Failure semantics, unchanged from the create/publish pair this replaces: any
 * failure after a successful create leaves an orphan upstream project, so it is
 * deleted best-effort and the original error is rethrown. A retry sends a
 * byte-identical create body and Semrush accepts no idempotency key, so without
 * the cleanup a retry creates a SECOND project rather than resolving to the first;
 * the 409 gate cannot catch it either, since it only fires once a DB row exists
 * and never sees orphan upstream projects. The cleanup's own errors are swallowed
 * so they cannot mask the real one, and both outcomes are logged.
 *
 * A failed PATCH does NOT abort the create. It is logged under a greppable token
 * and the publish proceeds, leaving a live market tracking its apex — the state
 * every market was in before this change, and one the data-service reconcile
 * repairs in place. Deleting an otherwise-valid project because a refinement could
 * not be applied trades a recoverable degradation for no market at all.
 *
 * Unlike the primary-url PATCH, the own-brand benchmark is a BLOCKING invariant
 * (LLMO-7421): exactly one `main_brand: true` benchmark must exist in the DRAFT
 * before publish, or Brand Presence has no customer baseline. Checked only
 * pre-publish, not after — publish is asynchronous (see
 * `errors.js` `MainBrandBenchmarkInvariantError`), so a published-view read
 * taken immediately after `publishProject` resolves would race that transition
 * and cannot soundly confirm the invariant here; that confirmation is deferred
 * to the fleet reconciliation this ticket also scopes. A pre-publish failure
 * triggers the same best-effort-cleanup-then-rethrow as a publish failure — the
 * caller (markets.js `handleCreateMarket`) never persists the
 * `BrandSemrushProject` row on that path, so a retry is a byte-identical create
 * rather than an adoption of a half-provisioned one.
 *
 * @param {SerenityTransport} transport - the Semrush transport.
 * @param {string} semrushWorkspaceId - the (sub-)workspace to create in.
 * @param {object} createBody - the `createProject` body; carries `domain`,
 *   `brand_name_display`, `brand_names` — also used to resolve/create the
 *   own-brand benchmark.
 * @param {object} [opts] - optional extras.
 * @param {string|null} [opts.primaryUrl] - the url the project tracks. Skipped when
 *   absent, which leaves the upstream's own apex default in place rather than
 *   blanking it.
 * @param {object} [opts.log] - logger.
 * @param {object} [opts.logContext] - extra fields for the failure logs.
 * @param {string} [opts.caller] - name used to prefix the failure logs.
 * @returns {Promise<string>} the new project's id.
 * @throws {CreateNoProjectIdError} when create returns no id.
 * @throws {import('./errors.js').MainBrandBenchmarkInvariantError} when the
 *   pre-publish benchmark invariant cannot be established, after a best-effort
 *   cleanup delete.
 * @throws when the publish fails, after a best-effort cleanup delete. A failed
 *   PATCH never throws.
 */
export async function createProvisionAndPublishProject(
  transport,
  semrushWorkspaceId,
  createBody,
  {
    primaryUrl = null, log, logContext = {}, caller = 'provisionProject',
  } = {},
) {
  const createResp = await transport.createProject(semrushWorkspaceId, createBody);
  const semrushProjectId = String(createResp?.id || '');
  if (!hasText(semrushProjectId)) {
    throw new CreateNoProjectIdError();
  }

  // Trimmed, not just `hasText`-checked: `hasText` counts whitespace as text, and a
  // caller-supplied `primaryUrl` of "   " would otherwise be PATCHed upstream
  // verbatim, replacing a correct apex default with blanks.
  const trackedUrl = typeof primaryUrl === 'string' ? primaryUrl.trim() : '';

  if (trackedUrl) {
    try {
      await transport.updateProject(
        semrushWorkspaceId,
        semrushProjectId,
        primaryUrlPatchBody(trackedUrl),
      );
    } catch (e) {
      log?.warn?.(
        `${caller}: SERENITY_MARKET_PRIMARY_URL_DIVERGENCE — could not set primary_url (non-fatal); market tracks its apex domain`,
        {
          ...logContext,
          semrushWorkspaceId,
          semrushProjectId,
          primaryUrl: trackedUrl,
          error: e.message,
        },
      );
    }
  }

  // Best-effort cleanup-then-rethrow, shared by every failure past this point
  // (the pre-publish benchmark invariant, and publish itself) so a
  // half-provisioned project is never left for a caller to mistakenly persist
  // as complete.
  /**
   * @param {Error} e - the original failure; always rethrown after cleanup.
   * @returns {Promise<never>}
   */
  const cleanupAndRethrow = async (e) => {
    let cleanedUp = false;
    try {
      await transport.deleteProject(semrushWorkspaceId, semrushProjectId);
      cleanedUp = true;
    } catch (cleanupErr) {
      log?.error?.(
        `${caller}: best-effort cleanup deleteProject failed; orphan upstream project remains`,
        {
          ...logContext, semrushWorkspaceId, semrushProjectId, error: cleanupErr.message,
        },
      );
    }
    log?.error?.(
      cleanedUp
        ? `${caller}: provisioning failed; upstream project cleaned up`
        : `${caller}: orphaned upstream project after provisioning failure`,
      {
        ...logContext, semrushWorkspaceId, semrushProjectId, error: e.message, cleanedUp,
      },
    );
    throw e;
  };

  // Blocking invariant (LLMO-7421): resolve/repair the own-brand benchmark and
  // confirm exactly one main_brand:true benchmark exists in the DRAFT before
  // publishing. This is the fix for the root cause — the prior version of this
  // function never touched benchmark state at all, so a project could publish
  // and be recorded as provisioned with zero main-brand benchmarks.
  const brand = {
    name: hasText(createBody?.brand_name_display)
      ? createBody.brand_name_display
      : createBody?.brand_names?.[0],
    domain: createBody?.domain,
    // The market's tracked url, not just its host — matches the PATCH above and
    // the sub-workspace path's `ownBrand.primaryUrl` (markets-subworkspace.js).
    // Falls back to `domain` inside ensureOwnBrandBenchmark when absent, but a
    // subpath/subdomain market must carry its real tracked url here or the
    // own-brand benchmark's `primary_url` silently scores it against its bare
    // host — omitting this was a merge-integration miss (LLMO-7421 review).
    primaryUrl: trackedUrl || undefined,
    aliases: hasText(createBody?.brand_name_display)
      ? createBody?.brand_names
      : createBody?.brand_names?.slice(1),
  };
  try {
    // repairAliasCase is deliberately NOT requested here: createBody's aliases
    // are fully caller-controlled (unlike the sub-workspace path, which repairs
    // mixed-case aliases Semrush may have auto-provisioned from customer input),
    // so there is nothing upstream-cased to reconcile on this path.
    await ensureOwnBrandBenchmark(
      transport,
      semrushWorkspaceId,
      semrushProjectId,
      brand,
      log,
      { repairUnflagged: true },
    );
    await assertMainBrandBenchmark(transport, semrushWorkspaceId, semrushProjectId);
  } catch (e) {
    await cleanupAndRethrow(e);
  }

  try {
    await transport.publishProject(semrushWorkspaceId, semrushProjectId);
  } catch (e) {
    await cleanupAndRethrow(e);
  }

  return semrushProjectId;
}
