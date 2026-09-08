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
 * Governed metrics/dimensions catalog for the ABV custom-dashboard analytics query API.
 *
 * v1 scope: a single fact domain (brand-presence), one grain (week), and only the
 * metric/dimension combinations a real data source could actually answer (see
 * `docs/plans/abv-custom-dashboards.md` in project-elmo-ui for the product spec). This
 * catalog is the ONLY thing the query endpoint (`llmo-analytics.js`) trusts to decide
 * whether a requested Analysis is legal — never derive allowed combinations ad hoc in
 * the controller.
 *
 * Kept as a plain JS module (not a JSON asset) per this repo's Lambda-bundling rule —
 * `readFileSync`/sibling-asset reads are dropped by the `helix-deploy` bundler; a JS
 * module import is resolved at build time instead.
 */

/** Mirrors the `llm_model` DB enum used by the real brand-presence RPCs (see
 * `LLM_MODEL_VALUES` in `llmo-brand-presence.js`) so fixture data and any future real
 * data source speak the same vocabulary. Not re-exported from there to avoid coupling
 * this fixture-only catalog to that (much larger, PostgREST-specific) module. */
export const PLATFORM_VALUES = Object.freeze([
  'chatgpt-paid',
  'chatgpt-free',
  'google-ai-overview',
  'perplexity',
  'copilot',
  'gemini',
]);

export const TOPIC_VALUES = Object.freeze([
  'Enterprise DAM',
  'Generative AI',
  'Content Supply Chain',
  'Digital Asset Management',
  'Personalization',
]);

export const REGION_VALUES = Object.freeze([
  'United States',
  'Germany',
  'United Kingdom',
  'France',
  'Japan',
]);

export const COMPETITOR_VALUES = Object.freeze([
  'Competitor A',
  'Competitor B',
  'Competitor C',
]);

export const GRAINS = Object.freeze(['week']);

export const DIMENSIONS = Object.freeze({
  week: {
    id: 'week',
    displayName: 'Week',
    type: 'time',
    supportsGrouping: true,
    supportsFiltering: false,
    supportsSearch: false,
    isHierarchical: false,
    supportsMultiSelect: false,
  },
  platform: {
    id: 'platform',
    displayName: 'LLM Platform',
    type: 'enum',
    allowedValues: PLATFORM_VALUES,
    supportsGrouping: true,
    supportsFiltering: true,
    supportsSearch: false,
    isHierarchical: false,
    supportsMultiSelect: true,
  },
  topic: {
    id: 'topic',
    displayName: 'Topic',
    type: 'enum',
    allowedValues: TOPIC_VALUES,
    supportsGrouping: true,
    supportsFiltering: true,
    supportsSearch: true,
    isHierarchical: false,
    supportsMultiSelect: true,
  },
  region: {
    id: 'region',
    displayName: 'Region / Market',
    type: 'enum',
    allowedValues: REGION_VALUES,
    supportsGrouping: true,
    supportsFiltering: true,
    supportsSearch: true,
    isHierarchical: false,
    supportsMultiSelect: true,
  },
  competitor: {
    id: 'competitor',
    displayName: 'Competitor',
    type: 'enum',
    allowedValues: COMPETITOR_VALUES,
    supportsGrouping: true,
    supportsFiltering: true,
    supportsSearch: true,
    isHierarchical: false,
    supportsMultiSelect: true,
  },
});

export const METRICS = Object.freeze({
  visibilityScore: {
    id: 'visibilityScore',
    displayName: 'Visibility Score',
    description: 'Share of tracked prompts where the brand appears in the model response.',
    dataType: 'number',
    unit: 'percent',
    supportedAggregations: ['avg'],
    supportedDimensions: ['week', 'platform', 'topic', 'region', 'competitor'],
    supportedGrains: GRAINS,
    supportedComparisons: ['none', 'previousPeriod'],
  },
  brandMentions: {
    id: 'brandMentions',
    displayName: 'Brand Mentions',
    description: 'Raw count of brand-name occurrences across tracked model responses.',
    dataType: 'number',
    unit: 'count',
    supportedAggregations: ['sum'],
    supportedDimensions: ['week', 'platform', 'topic', 'region', 'competitor'],
    supportedGrains: GRAINS,
    supportedComparisons: ['none', 'previousPeriod'],
  },
  citations: {
    id: 'citations',
    displayName: 'Citations',
    description: 'Raw count of citation events pointing at brand-owned sources.',
    dataType: 'number',
    unit: 'count',
    supportedAggregations: ['sum'],
    supportedDimensions: ['week', 'platform', 'topic', 'region'],
    supportedGrains: GRAINS,
    supportedComparisons: ['none', 'previousPeriod'],
  },
  sentimentScore: {
    id: 'sentimentScore',
    displayName: 'Sentiment Score',
    description: 'Average sentiment (-1 negative to 1 positive) of brand mentions.',
    dataType: 'number',
    unit: 'decimal',
    supportedAggregations: ['avg'],
    supportedDimensions: ['week', 'platform', 'topic', 'region'],
    supportedGrains: GRAINS,
    supportedComparisons: ['none', 'previousPeriod'],
  },
});

export const FILTER_OPERATORS_BY_DIMENSION_TYPE = Object.freeze({
  time: ['dateRange'],
  enum: ['equals', 'notEquals', 'in', 'notIn'],
});

export function getMetric(metricId) {
  return METRICS[metricId];
}

export function getDimension(dimensionId) {
  return DIMENSIONS[dimensionId];
}

/**
 * Returns the full metadata catalog shaped for the `GET .../analytics/metadata` response —
 * every metric with its own `supportedDimensions` expanded to full dimension objects
 * (rather than just ids), so the frontend never needs a second lookup.
 */
export function getMetadataCatalog() {
  const metrics = Object.values(METRICS).map((metric) => ({
    ...metric,
    supportedDimensions: metric.supportedDimensions.map((id) => DIMENSIONS[id]),
  }));
  return {
    metrics,
    dimensions: Object.values(DIMENSIONS),
    grains: GRAINS,
  };
}
