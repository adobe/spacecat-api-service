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

/** @typedef {import('./rest-transport.js').SerenityTransport} SerenityTransport */

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
 * A failed PATCH is treated exactly like a failed publish. It leaves the same
 * artefact — a created but unpublished draft — and letting it through would
 * publish a project recorded as provisioned while tracking the wrong url, which is
 * the defect this whole change exists to remove.
 *
 * @param {SerenityTransport} transport - the Semrush transport.
 * @param {string} semrushWorkspaceId - the (sub-)workspace to create in.
 * @param {object} createBody - the `createProject` body; carries `domain`.
 * @param {object} [opts] - optional extras.
 * @param {string|null} [opts.primaryUrl] - the url the project tracks. Skipped when
 *   absent, which leaves the upstream's own apex default in place rather than
 *   blanking it.
 * @param {object} [opts.log] - logger.
 * @param {object} [opts.logContext] - extra fields for the failure logs.
 * @param {string} [opts.caller] - name used to prefix the failure logs.
 * @returns {Promise<string>} the new project's id.
 * @throws when create returns no id, or when the PATCH or publish fails.
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
    throw new Error('Upstream createProject returned no id');
  }

  // Trimmed, not just `hasText`-checked: `hasText` counts whitespace as text, and a
  // caller-supplied `primaryUrl` of "   " would otherwise be PATCHed upstream
  // verbatim, replacing a correct apex default with blanks.
  const trackedUrl = typeof primaryUrl === 'string' ? primaryUrl.trim() : '';

  try {
    if (trackedUrl) {
      await transport.updateProject(semrushWorkspaceId, semrushProjectId, {
        type: 'ai',
        primary_url: trackedUrl,
      });
    }
    await transport.publishProject(semrushWorkspaceId, semrushProjectId);
  } catch (e) {
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
  }

  return semrushProjectId;
}

export default { createProvisionAndPublishProject };
