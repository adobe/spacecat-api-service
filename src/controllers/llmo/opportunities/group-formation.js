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
const HOLDOUT_RATIO = 0.2;
const MIN_HOLDOUT = 20;

/** Shuffle array copy using Fisher-Yates. Returns a new array. */
function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    // eslint-disable-next-line no-param-reassign
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Split an array into `n` roughly equal chunks. */
function chunkEvenly(arr, n) {
  const chunks = Array.from({ length: n }, () => []);
  arr.forEach((item, idx) => chunks[idx % n].push(item));
  return chunks;
}

/** Derive baseline metrics from suggestion data; fall back to count-based estimates. */
function deriveBaselineMetrics(suggestions) {
  const withData = suggestions.filter((s) => s.getData()?.agenticTraffic != null);
  if (withData.length === 0) {
    const count = suggestions.length;
    return {
      // eslint-disable-next-line no-nested-ternary
      agenticTraffic: count >= 80 ? 350 : count >= 30 ? 180 : 60,
      contentVisibility: 42,
      citationRate: 28,
      contentGainRatio: 2.1,
    };
  }
  const avg = (key) => Math.round(
    (withData.reduce((sum, s) => sum + (s.getData()?.[key] ?? 0), 0) / withData.length) * 10,
  ) / 10;
  return {
    agenticTraffic: Math.round(avg('agenticTraffic')),
    contentVisibility: avg('contentVisibility') || 42,
    citationRate: avg('citationRate') || 28,
    contentGainRatio: avg('contentGainRatio') || 2.1,
  };
}

/** Check if a URL's pathname matches the given glob pattern (e.g. "/products/*"). */
function urlMatchesPattern(url, pattern) {
  try {
    const prefix = pattern.replace(/\/\*$/, '');
    const { pathname } = new URL(url);
    return pathname.startsWith(prefix);
  } catch {
    const prefix = pattern.replace(/\/\*$/, '');
    return String(url).includes(prefix);
  }
}

/**
 * Group Formation controller — stratifies matching suggestion URLs into
 * control, test, and holdout groups for Comparative Experiments.
 */
function GroupFormationController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site, Opportunity, Suggestion } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  const createGroupings = async (context) => {
    const { siteId } = context.params ?? {};
    const { pageGroupPattern, testGroupCount } = context.data ?? {};

    if (!isValidUUID(siteId)) {
      return badRequest('Valid site ID required');
    }
    if (!pageGroupPattern) {
      return badRequest('pageGroupPattern required');
    }
    if (!testGroupCount || testGroupCount < 1) {
      return badRequest('testGroupCount must be >= 1');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }
    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Access denied');
    }

    // 1. Collect all suggestion objects for matching pattern
    const allOpportunities = await Opportunity.allBySiteId(siteId);
    const experimentable = allOpportunities.filter((o) => EXPERIMENTABLE_TYPES.has(o.getType()));

    const matchingSuggestions = (
      await Promise.all(
        experimentable.map((opp) => Suggestion.allByOpportunityId(opp.getId())),
      )
    )
      .flat()
      .filter((s) => {
        const url = s.getData()?.url;
        return url && urlMatchesPattern(url, pageGroupPattern);
      });

    if (matchingSuggestions.length === 0) {
      return ok([]);
    }

    // 2. Shuffle + reserve holdout
    const shuffled = shuffle(matchingSuggestions);
    const holdoutSize = Math.max(
      MIN_HOLDOUT,
      Math.round(shuffled.length * HOLDOUT_RATIO),
    );
    const holdoutSuggestions = shuffled.splice(0, holdoutSize);

    // 3. Split pool into (testGroupCount + 1) groups [0=control, 1..N=test]
    const totalGroups = testGroupCount + 1;
    const chunks = chunkEvenly(shuffled, totalGroups);

    const groups = chunks.map((chunk, idx) => ({
      id: idx === 0 ? 'control' : `test-${idx}`,
      role: idx === 0 ? 'control' : 'test',
      name: idx === 0 ? 'Control' : `Test Group ${idx}`,
      pageUrls: chunk.map((s) => s.getData().url),
      pageCount: chunk.length,
      samplePages: chunk.slice(0, 3).map((s) => s.getData().url),
      baseline: deriveBaselineMetrics(chunk),
      variantId: null,
      currentCitationRate: null,
      finalCitationRate: null,
    }));

    // 4. Add holdout
    groups.push({
      id: 'holdout',
      role: 'holdout',
      name: 'Holdout',
      pageUrls: holdoutSuggestions.map((s) => s.getData().url),
      pageCount: holdoutSuggestions.length,
      samplePages: holdoutSuggestions.slice(0, 3).map((s) => s.getData().url),
      baseline: deriveBaselineMetrics(holdoutSuggestions),
      variantId: null,
      currentCitationRate: null,
      finalCitationRate: null,
    });

    return ok(groups);
  };

  return { createGroupings };
}

export default GroupFormationController;
