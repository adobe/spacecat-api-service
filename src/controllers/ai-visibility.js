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
  ok,
  internalServerError,
  createResponse,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { getGrpcClients } from '../support/ai-visibility/grpc-transport.js';
import { normalizeVisibilityV1SuccessfulBody } from '../support/ai-visibility/visibility-normalize.js';
import { attachSrFiltersToSuccessfulBody } from '../support/ai-visibility/visibility-filters.js';

import {
  handleBrandStats,
  handleBrandTopics,
  handleBrandPrompts,
  handleBrandCitedPages,
  handleBrandTopicOpportunities,
  handleBrandTopBrands,
  handleBrandCitedSources,
  handleBrandSourceOpportunities,
  handleBrandCompetitors,
} from '../support/ai-visibility/handlers/brands.js';
import {
  handleCompetitorsMetrics,
} from '../support/ai-visibility/handlers/competitors.js';
import {
  handlePromptsResponses,
  handlePromptsResponsesLatest,
} from '../support/ai-visibility/handlers/prompts.js';
import {
  handleTopicsResearchStats,
  handleTopicsResearch,
  handleTopicsStats,
  handleTopicsResearchPrompts,
  handleTopicsResearchBrands,
  handleTopicsResearchSourceDomains,
} from '../support/ai-visibility/handlers/topics.js';
import { handleBrandTopics as handleBrandTopicsV1 } from '../support/ai-visibility/handlers/v1/topic/brand-topics.js';
import { handleBrandTopicsExport as handleBrandTopicsExportV1 } from '../support/ai-visibility/handlers/v1/topic/brand-topics-export.js';
import { handleBrandTopicsTotals as handleBrandTopicsTotalsV1 } from '../support/ai-visibility/handlers/v1/topic/brand-topics-totals.js';
import { handleGapTopics as handleGapTopicsV1 } from '../support/ai-visibility/handlers/v1/topic/gap-topics.js';
import { handleGapTopicsExport as handleGapTopicsExportV1 } from '../support/ai-visibility/handlers/v1/topic/gap-topics-export.js';
import { handleGapTopicsTotals as handleGapTopicsTotalsV1 } from '../support/ai-visibility/handlers/v1/topic/gap-topics-totals.js';
import { handleBrandPrompts as handleBrandPromptsV1 } from '../support/ai-visibility/handlers/v1/prompt/brand-prompts.js';
import { handleBrandPromptsExport as handleBrandPromptsExportV1 } from '../support/ai-visibility/handlers/v1/prompt/brand-prompts-export.js';
import { handleGapPrompts as handleGapPromptsV1 } from '../support/ai-visibility/handlers/v1/prompt/gap-prompts.js';
import { handleGapPromptsExport as handleGapPromptsExportV1 } from '../support/ai-visibility/handlers/v1/prompt/gap-prompts-export.js';
import { handleGapPromptsTotals as handleGapPromptsTotalsV1 } from '../support/ai-visibility/handlers/v1/prompt/gap-prompts-totals.js';
import { handlePromptResponse as handlePromptResponseV1 } from '../support/ai-visibility/handlers/v1/prompt/prompt-response.js';
import { handleGapSourceDomains as handleGapSourceDomainsV1 } from '../support/ai-visibility/handlers/v1/source/gap-source-domains.js';
import { handleGapSourceDomainsExport as handleGapSourceDomainsExportV1 } from '../support/ai-visibility/handlers/v1/source/gap-source-domains-export.js';
import { handleGapSourceDomainsTotals as handleGapSourceDomainsTotalsV1 } from '../support/ai-visibility/handlers/v1/source/gap-source-domains-totals.js';
import { handleStatsByCountry as handleBrandStatsByCountryV1 } from '../support/ai-visibility/handlers/v1/brand/stats-by-country.js';
import { handleStatsByLLM as handleBrandStatsByLLMV1 } from '../support/ai-visibility/handlers/v1/brand/stats-by-llm.js';
import { handleMeta as handleMetaV1 } from '../support/ai-visibility/handlers/v1/meta/meta.js';
import { handleMeta } from '../support/ai-visibility/handlers/meta.js';

const ROUTE_MAP = [
  ['/brands/stats', handleBrandStats],
  ['/brands/topics', handleBrandTopics],
  ['/brands/prompts', handleBrandPrompts],
  ['/brands/cited-pages', handleBrandCitedPages],
  ['/brands/topic-opportunities', handleBrandTopicOpportunities],
  ['/brands/top-brands', handleBrandTopBrands],
  ['/brands/cited-sources', handleBrandCitedSources],
  ['/brands/source-opportunities', handleBrandSourceOpportunities],
  ['/brands/competitors', handleBrandCompetitors],
  ['/competitors/metrics', handleCompetitorsMetrics],
  ['/meta', handleMeta],
  ['/prompts/responses/latest', handlePromptsResponsesLatest],
  ['/prompts/responses', handlePromptsResponses],
  ['/topics/research/stats', handleTopicsResearchStats],
  ['/topics/research/prompts', handleTopicsResearchPrompts],
  ['/topics/research/brands', handleTopicsResearchBrands],
  ['/topics/research/source-domains', handleTopicsResearchSourceDomains],
  ['/topics/research', handleTopicsResearch],
  ['/topics/stats', handleTopicsStats],
  ['/v1/topic/brand-topics', handleBrandTopicsV1],
  ['/v1/topic/brand-topics-export', handleBrandTopicsExportV1],
  ['/v1/topic/brand-topics-totals', handleBrandTopicsTotalsV1],
  ['/v1/topic/gap-topics', handleGapTopicsV1],
  ['/v1/topic/gap-topics-export', handleGapTopicsExportV1],
  ['/v1/topic/gap-topics-totals', handleGapTopicsTotalsV1],
  ['/v1/prompt/brand-prompts', handleBrandPromptsV1],
  ['/v1/prompt/brand-prompts-export', handleBrandPromptsExportV1],
  ['/v1/prompt/gap-prompts', handleGapPromptsV1],
  ['/v1/prompt/gap-prompts-export', handleGapPromptsExportV1],
  ['/v1/prompt/gap-prompts-totals', handleGapPromptsTotalsV1],
  ['/v1/prompt/prompt-response', handlePromptResponseV1],
  ['/v1/source/gap-source-domains', handleGapSourceDomainsV1],
  ['/v1/source/gap-source-domains-export', handleGapSourceDomainsExportV1],
  ['/v1/source/gap-source-domains-totals', handleGapSourceDomainsTotalsV1],
  ['/v1/brand/stats-by-country', handleBrandStatsByCountryV1],
  ['/v1/brand/stats-by-llm', handleBrandStatsByLLMV1],
  ['/v1/meta/meta', handleMetaV1],
];

function extractSearchParams(context) {
  if (context.request?.url) {
    try {
      return new URL(context.request.url).searchParams;
    } catch {
      /* fall through */
    }
  }
  const data = context.data || {};
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        sp.append(k, String(item));
      }
    } else if (v != null) {
      sp.set(k, String(v));
    }
  }
  return sp;
}

function wrapHandler(handlerFn, relPath, log) {
  return async (context) => {
    let clients;
    try {
      clients = getGrpcClients(context.env);
    } catch (e) {
      log.error('AI Visibility gRPC transport init failed', e);
      return createResponse(
        {
          error: 'aiVisibilityNotConfigured',
          message: 'AI Visibility is not configured.',
        },
        503,
      );
    }
    const sp = extractSearchParams(context);
    try {
      const result = await handlerFn(sp, clients);
      if (result.status !== 200) {
        return createResponse(result.body, result.status);
      }
      const normalized = normalizeVisibilityV1SuccessfulBody(
        relPath,
        result.body,
      );
      const withFilters = attachSrFiltersToSuccessfulBody(
        result.status,
        normalized,
        sp,
      );
      return ok(withFilters);
    } catch (e) {
      log.error(`AI Visibility handler error [${relPath}]`, e);
      return internalServerError('AI Visibility request failed');
    }
  };
}

function AiVisibilityController(context, log, _) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }
  if (!log) {
    throw new Error('Log required');
  }

  const handlers = {};
  for (const [relPath, handlerFn] of ROUTE_MAP) {
    const methodName = `get${relPath
      .split('/')
      .filter(Boolean)
      .map((seg) => seg.replace(/-([a-z])/g, (_, c) => c.toUpperCase()))
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join('')}`;
    handlers[methodName] = wrapHandler(handlerFn, relPath, log);
  }

  return handlers;
}

export default AiVisibilityController;
