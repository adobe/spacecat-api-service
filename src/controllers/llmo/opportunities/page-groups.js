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

import {
  badRequest, forbidden, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';
import AccessControlUtil from '../../../support/access-control-util.js';

const EXPERIMENTABLE_TYPES = new Set(['faq', 'summarization']);

/**
 * Extract a `/first-segment/*` pattern from any URL string.
 * e.g. "https://example.com/products/photoshop" → "/products/*"
 *      "/blog/design-tips" → "/blog/*"
 */
function toPathPattern(url) {
  try {
    const { pathname } = new URL(url);
    const first = pathname.split('/').filter(Boolean)[0];
    return first ? `/${first}/*` : '/*';
  } catch {
    const first = String(url).split('/').filter(Boolean)[0];
    return first ? `/${first}/*` : '/*';
  }
}

/**
 * Page Groups controller — clusters suggestion URLs by URL path prefix
 * for use in the Comparative Experiments wizard Step 1.
 */
function PageGroupsController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site, Opportunity, Suggestion } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  const getPageGroups = async (context) => {
    const { siteId } = context.params ?? {};

    if (!isValidUUID(siteId)) {
      return badRequest('Valid site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Access denied');
    }

    const allOpportunities = await Opportunity.allBySiteId(siteId);
    const experimentable = allOpportunities.filter(
      (o) => EXPERIMENTABLE_TYPES.has(o.getType()),
    );

    // cluster: pattern → { pageCount, lockedPages, suggestions }
    const clusters = new Map();

    await Promise.all(experimentable.map(async (opp) => {
      const suggestions = await Suggestion.allByOpportunityId(opp.getId());
      for (const suggestion of suggestions) {
        const url = suggestion.getData()?.url;
        if (url) {
          const pattern = toPathPattern(url);
          const isLocked = suggestion.getData()?.edgeOptimizeStatus === 'EXPERIMENT_IN_PROGRESS';
          const existing = clusters.get(pattern)
            ?? { pageCount: 0, lockedPages: 0, suggestions: [] };
          existing.suggestions.push(suggestion);
          clusters.set(pattern, {
            pageCount: existing.pageCount + 1,
            lockedPages: existing.lockedPages + (isLocked ? 1 : 0),
            suggestions: existing.suggestions,
          });
        }
      }
    }));

    const groups = [...clusters.entries()]
      .sort(([, a], [, b]) => b.pageCount - a.pageCount)
      .map(([pattern, { pageCount, lockedPages, suggestions: clusterSuggestions }]) => {
        // Aggregate W6 personas from stored suggestion data; empty if W6 hasn't run
        const personaFreq = new Map();
        for (const s of clusterSuggestions) {
          for (const p of (s.getData()?.personas ?? [])) {
            const existing = personaFreq.get(p.id) ?? { persona: p, count: 0 };
            personaFreq.set(p.id, { persona: p, count: existing.count + 1 });
          }
        }
        const topPersonas = [...personaFreq.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
          .map(({ persona }) => persona);

        return {
          id: pattern.replace(/[^a-z0-9]/gi, '-').replace(/^-+|-+$/g, ''),
          pattern,
          pageCount,
          // eslint-disable-next-line no-nested-ternary
          trafficLevel: pageCount >= 80 ? 'high' : pageCount >= 30 ? 'medium' : 'low',
          lockedPages,
          topPersonas, // [] until W6 has run for this site
        };
      });

    return ok(groups);
  };

  return { getPageGroups };
}

export default PageGroupsController;
