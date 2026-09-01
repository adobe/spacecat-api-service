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
 * LLMO-7284 (AC12): a site's organization must not be reassigned while the site still
 * carries product enrollments tied to its CURRENT organization. `site_enrollments` reach
 * an org only indirectly through their entitlement's `organization_id` (they have no
 * `organization_id` column of their own), so nothing re-links them when a site's own
 * `organization_id` changes — the move silently leaves them behind as the "foreign LLMO
 * enrollment" drift that scripts/reconcile-org-identity-integrity.mjs reports after the
 * fact. Rather than drift silently, fail with an EXPLICIT reconciliation failure and make
 * the operator offboard/transfer the enrollments first.
 *
 * Applied at every reassignment site that does not already revoke enrollments first:
 * set-ims-org-modal.js, onboard-llmo-modal.js::checkOrg, approve-org.js, and
 * llmo-onboarding.js::createOrFindSite (the last of these originally had its own inline
 * enrollment check; converged onto this shared guard so a straggler can't be orphaned by one
 * path while the others are guarded). The paths NOT routed here are only PARTIALLY equivalent,
 * and deliberately out of this change's scope: move-plg-site.js and bypass-handlers.js gate on
 * `enrollments.length > 0` before moving, but that gate is NOT fail-closed on an unverifiable
 * (null/undefined) read the way this guard is — a null read there short-circuits falsy and the
 * move proceeds; onboarding-flow.js reassigns only from internal/demo orgs. Converging those
 * onto this guard is a tracked follow-up (see the PR discussion); until then the reconcile
 * report remains the backstop for any straggler.
 *
 * Fails CLOSED: if the enrollments cannot be read back (a non-array), the move is aborted
 * rather than assumed safe — a swallowed read must not be treated as "no enrollments".
 *
 * SCOPE (LLMO-7284): this guard covers ONLY enrollment orphaning (reconcile Check 1). It
 * does NOT cover the brand/site org mismatch (reconcile Check 3): an active brand anchored to
 * this site via `brands.site_id` keeps its own `organization_id` when the site moves, so a
 * site with no enrollments but an active brand can still drift. Blocking that is intentionally
 * deferred here — it needs brand-transfer semantics (move vs. refuse), not just a block — and
 * is tracked separately; it is called out so the omission is explicit rather than silent. A
 * Check-3 straggler is still surfaced by the reconcile report after the fact.
 *
 * @param {object} params
 * @param {object} params.site         the Site being reassigned (SpaceCat data-access model);
 *   must be a resolved, non-null Site — callers null-check `site` before invoking, since
 *   `site.getOrganizationId()` is dereferenced immediately below.
 * @param {string|null} params.targetOrgId  the org the site is moving to; `null` when the
 *   target org does not exist yet (a brand-new org — always a real move)
 * @param {object} [params.log]
 * @returns {Promise<void>} resolves when the reassignment is safe (no enrollments to orphan,
 *   or the target org is the site's current org — a no-op)
 * @throws {Error} `.status=409`, `.code='site_org_reassignment_blocked'` when the move would
 *   orphan enrollments; `.status=502`, `.code='site_org_reassignment_unverified'` when the
 *   enrollments cannot be verified.
 */
export async function assertSiteOrgReassignmentSafe({ site, targetOrgId, log = console }) {
  const currentOrgId = site.getOrganizationId();

  // Re-running the admin action against the site's CURRENT org (e.g. to add products)
  // is not a move — never block it, regardless of how many enrollments the site has.
  if (targetOrgId !== null && targetOrgId === currentOrgId) {
    return;
  }

  const enrollments = await site.getSiteEnrollments();
  if (!Array.isArray(enrollments)) {
    const err = new Error(
      `Unable to verify enrollments for site ${site.getBaseURL()} `
      + `(current org ${currentOrgId}); aborting org reassignment to avoid orphaning them.`,
    );
    // `.status`/`.code` here are an INTERNAL classifier the Slack callers switch on, not an
    // HTTP contract (this helper is not mounted on an HTTP route). 502 flags "could not
    // verify a dependency read"; if this ever fronts a REST endpoint, treat it as 5xx.
    err.status = 502;
    err.code = 'site_org_reassignment_unverified';
    throw err;
  }

  if (enrollments.length > 0) {
    const err = new Error(
      `Site ${site.getBaseURL()} still has ${enrollments.length} enrollment(s) under `
      + `org ${currentOrgId}; reassigning it${targetOrgId ? ` to ${targetOrgId}` : ''} would `
      + 'orphan them as foreign enrollments. Offboard or transfer the enrollments first, then retry.',
    );
    err.status = 409;
    err.code = 'site_org_reassignment_blocked';
    throw err;
  }

  log?.info?.(
    `[llmo-7284] site ${site.getId()} org reassignment `
    + `${currentOrgId} -> ${targetOrgId ?? '(new org)'} is enrollment-free; proceeding.`,
  );
}
