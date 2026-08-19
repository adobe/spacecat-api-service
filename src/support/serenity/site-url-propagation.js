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

import { siteIdentityFromUrlString } from '@adobe/spacecat-shared-utils';

import { hostnameFromUrlString } from '../url-utils.js';
import { ensureOwnBrandBenchmark, republish } from './brand-urls.js';
import { projectsForSite } from './mapping-rows.js';

/** @typedef {import('./rest-transport.js').SerenityTransport} SerenityTransport */

/**
 * Propagates a brand's own primary site's `baseURL` change onto Semrush: for every live
 * market project mapped to this site, re-points the project's tracked `primary_url` AND its
 * `domain` (the registrable-domain grouping key — Semrush normalizes whatever is sent to the
 * eTLD+1 via the Public Suffix List, so a same-domain edit is a no-op on this field and a
 * cross-domain edit moves it too; live-verified against adobe-hackathon.semrush.com
 * 2026-08-18 that a changed `domain` is accepted, persists, and a subsequent publish settles
 * cleanly with no project recreation), the own-brand benchmark's `domain` (full-body PUT — a
 * field omitted from that PUT is CLEARED upstream, not preserved, see `rest-transport.js`'s
 * `updateBenchmark` JSDoc — so this reads the benchmark first to carry its
 * `brand_name`/`brand_aliases` forward unchanged), and republishes.
 *
 * Scope: a brand's sub-workspace can hold multiple market projects, and a Site can be
 * shared by more than one of them (two locale variants of the same market both on one
 * domain) — see `projectsForSite`. This updates every live project mapped to `siteId`,
 * never the brand's other markets on a different domain.
 *
 * Errors (a transport failure, or `republish` throwing `toQuotaExceededError()` under the
 * SITES-49206 convention) propagate to the caller rather than being swallowed — the
 * caller (sites.js `updateSite`) persists the SpaceCat-side URL only after this resolves,
 * so a thrown error here must fail the whole edit, not leave a partial update silent.
 *
 * @param {object} params
 * @param {any} params.dataAccess - `ctx.dataAccess`, for `projectsForSite`.
 * @param {SerenityTransport} params.transport
 * @param {string} params.workspaceId - the brand's Semrush sub-workspace id.
 * @param {string} params.brandId
 * @param {string} params.siteId - the Site being edited.
 * @param {{name: string, aliases?: Array<{name: string, regions?: string[]}>}} params.brandIdentity
 *   - the brand's own identity, for `ensureOwnBrandBenchmark`'s `brand` param.
 * @param {string} params.newBaseURL - the site's new `baseURL`, as submitted.
 * @param {object} [params.log]
 * @returns {Promise<{projectsUpdated: number}>}
 */
export async function propagateSiteUrlToSemrush({
  dataAccess, transport, workspaceId, brandId, siteId, brandIdentity, newBaseURL, log,
}) {
  const newIdentity = siteIdentityFromUrlString(newBaseURL);
  const newDomain = hostnameFromUrlString(newBaseURL);
  if (newIdentity === null || newDomain === null) {
    // The caller validates newBaseURL as a well-formed URL before calling this — a
    // null identity/hostname here means the derivations disagree on parseability,
    // which is a bug worth failing loudly on rather than sending a nullish
    // `primary_url`/`domain` to Semrush (domain is required in practice, see
    // updateBenchmark's JSDoc).
    throw new Error(`site-url-propagation: could not derive a URL identity from "${newBaseURL}"`);
  }

  const rows = await projectsForSite(dataAccess, brandId, siteId);
  if (rows.length === 0) {
    // No live project mapped to this site yet (e.g. the mapping row's siteId link is
    // still pending a best-effort write). Not an error — the caller still persists the
    // SpaceCat-side baseURL.
    log?.warn?.('site-url-propagation: no live projects mapped to this site; nothing to propagate', {
      brandId, siteId,
    });
    return { projectsUpdated: 0 };
  }

  let projectsUpdated = 0;
  for (const row of rows) {
    const projectId = row.getSemrushProjectId();

    try {
      // eslint-disable-next-line no-await-in-loop
      await transport.updateProject(workspaceId, projectId, {
        type: 'ai', primary_url: newIdentity, domain: newDomain,
      });

      // eslint-disable-next-line no-await-in-loop
      const benchmarkId = await ensureOwnBrandBenchmark(
        transport,
        workspaceId,
        projectId,
        { name: brandIdentity.name, domain: newDomain, aliases: brandIdentity.aliases },
        log,
      );
      if (benchmarkId) {
        // Read the DRAFT view — the PUT below acts on the draft (see updateBenchmark's
        // JSDoc / syncBrandAliasesAcrossMarkets), so a diff against the published view
        // would be stale on a project with pending changes.
        // eslint-disable-next-line no-await-in-loop
        const resp = await transport.listBenchmarks(workspaceId, projectId, { draft: true });
        const benchmarks = Array.isArray(resp?.aio_benchmarks) ? resp.aio_benchmarks : [];
        const own = benchmarks.find((b) => String(b?.id) === benchmarkId);
        // eslint-disable-next-line no-await-in-loop
        await transport.updateBenchmark(workspaceId, projectId, benchmarkId, {
          brand_name: own?.brand_name || brandIdentity.name,
          domain: newDomain,
          brand_aliases: Array.isArray(own?.brand_aliases) ? own.brand_aliases : [],
        });
      }

      // NEW convention (SITES-49206): a real quota 405 now throws toQuotaExceededError()
      // instead of silently leaving the project draft. Let it propagate.
      // eslint-disable-next-line no-await-in-loop
      await republish(transport, workspaceId, projectId, log);
    } catch (e) {
      // Name WHICH project failed and how many in THIS call already succeeded before it —
      // mirrors brand-urls.js/brand-aliases.js's per-market fan-out logging — so an operator
      // reading this line can tell "2 of 3 projects already re-pointed, the 3rd failed" rather
      // than an opaque top-level error with no indication of partial progress. Log-then-rethrow:
      // the caller (sites.js) still needs this to propagate so the SpaceCat-side URL isn't
      // persisted on a failure (see the module JSDoc's "propagate before persist" ordering).
      log?.error?.('site-url-propagation: failed re-pointing a project mid fan-out', {
        brandId,
        siteId,
        projectId,
        status: e?.status,
        projectsUpdatedBeforeFailure: projectsUpdated,
        totalProjects: rows.length,
      });
      throw e;
    }

    projectsUpdated += 1;
  }

  log?.info?.('site-url-propagation: re-pointed Semrush project(s) for a site URL change', {
    brandId, siteId, projectsUpdated,
  });
  return { projectsUpdated };
}
