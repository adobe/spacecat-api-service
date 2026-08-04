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

// NOTE: no `// @ts-check` — this file bridges to `findFacsResourceBinding` /
// `normalizeImsOrgId`, which the pinned `@adobe/spacecat-shared-http-utils` exports at
// runtime but not in its shipped types yet (same reason `state-access-mapping-utils.js`
// is unchecked). Consumers (e.g. the type-checked serenity controller) still get the
// export signatures below by JSDoc inference.

import { hasText } from '@adobe/spacecat-shared-utils';
import { findFacsResourceBinding, normalizeImsOrgId } from '@adobe/spacecat-shared-http-utils';

/**
 * Caller-identity resolvers used to KEY the FACS state layer
 * (`facs_access_mappings`). Kept in one place so every reader of a binding
 * derives the subject / org exactly as `createMapping` wrote it — the state
 * layer is keyed on `(ims_org_id, product, subject_type, subject_id,
 * resource_type, resource_id)`, so a resolver that drifts from the write path
 * silently fails to match a real grant.
 *
 * Both are byte-equal to `facsWrapper`'s own resolution
 * (`spacecat-shared-http-utils` `resolveUserIdent` reads `profile.sub`; the
 * wrapper keys the org on the caller's first tenant id), and to the
 * state-layer management controller's write path — that equality is the whole
 * point of sharing them.
 */

/**
 * The caller's canonical FACS subject id — `profile.sub`. auth-service
 * canonicalises `userId` / `sub` / `email` to the same `<ident>@<authSrc>`
 * value at login, and both `facsWrapper` and `POST /state/access-mappings`
 * key user-subject bindings on exactly `sub` — so this must read `sub`, not
 * the `user_id ?? sub ?? email` fallback used for authorship stamping.
 *
 * @param {object} ctx - request context.
 * @returns {string|null} canonical subject id, or null when absent.
 */
export function resolveCallerUserIdent(ctx) {
  return ctx?.attributes?.authInfo?.getProfile?.()?.sub ?? null;
}

/**
 * The caller's BARE IMS org ident (first tenant id, e.g. without an
 * `@AdobeOrg` suffix). Normalise with `normalizeImsOrgId` before using it as
 * the `ims_org_id` state-layer key.
 *
 * @param {object} ctx - request context.
 * @returns {string|null} bare org ident, or null when absent.
 */
export function resolveCallerImsOrgIdentBare(ctx) {
  return ctx?.attributes?.authInfo?.getTenantIds?.()?.[0] ?? null;
}

/**
 * PROTOTYPE (SITES-47870, Option B): resolves whether the caller holds a capability
 * at the FACS STATE layer (`facs_access_mappings`) for a brand resource.
 *
 * The serenity `can_track` gate is enforced in-controller via
 * `authInfo.hasFacsPermission` (the JWT), which is NOT a `facsWrapper` route
 * requirement — so the wrapper never unions the state layer for it. This performs
 * that union, so a per-brand / org-wide `POST /state/access-mappings` grant is
 * honoured exactly as every other capability is: it checks both subject scopes the
 * wrapper unions — the caller's user-subject row and the caller's org-subject row
 * (org bindings are keyed `subject_id === imsOrgId`; hybrid model §8.3). Keys use the
 * SAME resolvers the write path uses, so a real grant can never be missed by drift.
 *
 * FAIL-CLOSED: a missing dependency or a state-layer read error resolves to `false`
 * (the caller is simply not granted), never a throw — the serenity gate drops an
 * unpermitted assert, it does not 500.
 *
 * @param {object} ctx - request context (carries authInfo + postgrestClient).
 * @param {object} opts
 * @param {string} opts.product - UPPERCASE product code (the state layer stores it uppercase).
 * @param {string} opts.capability - the capability string, e.g. `llmo/can_track`.
 * @param {string | undefined} opts.brandUuid - brand resource id (== the route's `:brandId` UUID).
 * @param {object} [opts.log] - logger.
 * @returns {Promise<boolean>} true iff an active binding grants `capability`.
 */
export async function callerHasStateLayerCapability(ctx, {
  product, capability, brandUuid, log,
}) {
  const postgrestClient = ctx?.dataAccess?.services?.postgrestClient;
  if (!postgrestClient?.from || !hasText(brandUuid)) {
    return false;
  }
  const imsOrgId = normalizeImsOrgId(resolveCallerImsOrgIdentBare(ctx));
  if (!hasText(imsOrgId)) {
    return false;
  }
  const subjectId = resolveCallerUserIdent(ctx);
  const subjects = [
    ...(hasText(subjectId) ? [{ subjectType: 'user', subjectId }] : []),
    { subjectType: 'org', subjectId: imsOrgId },
  ];
  try {
    const bindings = await Promise.all(subjects.map(
      ({ subjectType, subjectId: sid }) => findFacsResourceBinding(postgrestClient, {
        imsOrgId,
        product,
        subjectType,
        subjectId: sid,
        resourceType: 'brand',
        resourceId: brandUuid,
      }),
    ));
    return bindings.some(
      (b) => Array.isArray(b?.granted_capabilities) && b.granted_capabilities.includes(capability),
    );
  } catch (e) {
    log?.warn?.(
      'callerHasStateLayerCapability: state-layer lookup failed; treating as not granted',
      { capability, error: e?.message },
    );
    return false;
  }
}
