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

import { hasText } from '@adobe/spacecat-shared-utils';

// ---------------------------------------------------------------------------
// Component catalog
//
// This MUST stay in sync with the UI's RenderedComponent switch in
// experience-success-studio-ui:
//   src/dx-excshell-1/web-src/src/pages/Profiles/ProfilePage/ProfilePage.tsx
// The UI can only render these ids; anything else is dropped as null. We send
// this catalog to Claude so it knows the exact menu of components it may
// produce and the data shape each one expects.
// ---------------------------------------------------------------------------

export const COMPONENT_CATALOG = [
  {
    id: 'metrics-summary',
    description: 'A KPI grid. Use for headline numbers about an opportunity.',
    dataShape: 'data.metrics = [{ label: string, value: string|number, unit?: string, trend?: "up"|"down"|"neutral" }]',
  },
  {
    id: 'callout',
    description: 'A single highlighted insight/message. Use for the one most important takeaway.',
    dataShape: 'data.message = string, data.variant = "info"|"warning"|"negative"|"positive"',
  },
  {
    id: 'ranked-list',
    description: 'A ranked list of items (e.g. top pages). Use to rank things by impact.',
    dataShape: 'data.items = [{ rank: number, label: string, value: string|number, unit?: string }]',
  },
  {
    id: 'link-picker',
    description: 'A table of broken links with suggested redirects. Best for broken-backlinks / broken-internal-links.',
    dataShape: 'data.links = [{ fromUrl: string, toUrl: string, status: number, suggestedFix?: string, traffic?: string }]',
  },
  {
    id: 'priority-pages',
    description: 'High-traffic pages with the issues found on each. Best for a page-centric consolidated view.',
    dataShape: 'data.priorityPages = [{ url: string, traffic: string, issues: [{ type: "meta-tags"|"broken-backlinks"|"broken-internal-links", label: string }] }]',
  },
  {
    id: 'content-gap-table',
    description: 'A table of thin-content pages. Best for content/word-count gaps.',
    dataShape: 'data.pages = [{ url: string, wordCount: number, topics: string[], status: "thin"|"moderate"|"ok" }]',
  },
  {
    id: 'alt-text-review',
    description: 'A table of images with current vs suggested alt text. Best for accessibility/alt-text.',
    dataShape: 'data.images = [{ src: string, currentAlt: string, suggestedAlt: string, pageUrl: string }]',
  },
  {
    id: 'waterfall-chart',
    description: 'A performance waterfall. Best for Core Web Vitals / load timing.',
    dataShape: 'data.totalMs = number, data.steps = [{ label: string, durationMs: number, percent: number }]',
  },
  {
    id: 'page-filter',
    description: 'A small badge indicating an active page filter (e.g. "> 10k visits").',
    dataShape: 'data.minVisits = number',
  },
];

/** Set of valid component ids for validation. */
export const VALID_COMPONENT_IDS = new Set(COMPONENT_CATALOG.map((c) => c.id));

/** Max components a single profile may contain (per product decision). */
export const MAX_COMPONENTS = 2;

/**
 * Extracts the first JSON object found in a string (models sometimes wrap JSON
 * in prose or markdown fences).
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  if (!hasText(text)) {
    return null;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Resolve the Bedrock configuration from env. Returns null when Bedrock is not
 * fully configured (caller should treat this as "LLM unavailable").
 * @param {object} env
 * @returns {{ url: string, apiKey: string }|null}
 */
export function getBedrockConfig(env) {
  const apiKey = env?.BEDROCK_API_KEY;
  const modelId = env?.BEDROCK_MODEL_ID;
  const region = env?.BEDROCK_REGION;
  const endpoint = env?.BEDROCK_ENDPOINT
    || (hasText(region) ? `https://bedrock-runtime.${region}.amazonaws.com` : null);

  if (!hasText(apiKey) || !hasText(modelId) || !hasText(endpoint)) {
    return null;
  }
  return {
    url: `${endpoint.replace(/\/$/, '')}/model/${modelId}/converse`,
    apiKey,
  };
}

/**
 * Builds the system prompt that describes the task + the component catalog.
 * @returns {string}
 */
function buildSystemPrompt() {
  const catalog = COMPONENT_CATALOG
    .map((c) => `- "${c.id}": ${c.description}\n    ${c.dataShape}`)
    .join('\n');

  return `You build a goal-oriented "profile" for a website from its real opportunities.
You are given the customer's request and a list of that site's opportunities (each with an id, type, title, and data).

Choose AT MOST ${MAX_COMPONENTS} components from the catalog below that best represent the requested opportunities, and fill each component's "data" using the real opportunity data provided. Only use opportunities that match the customer's request.

Available components (use the exact "id" and the described data shape):
${catalog}

Respond with ONLY a JSON object (no prose, no markdown) of this exact form:
{
  "name": "<short profile name derived from the request>",
  "rationale": "<one or two sentences explaining what you surfaced and why>",
  "components": [ { "id": "<catalog id>", "title": "<human title>", "data": { ... } } ],
  "opportunityIds": ["<id of each opportunity you used>"],
  "reply": "<one short sentence to show the user in chat>"
}
Rules: components length <= ${MAX_COMPONENTS}; every component id must be from the catalog; every opportunityId must be one of the provided opportunity ids.`;
}

/**
 * Calls Claude (Bedrock Converse) to select components for a profile from the
 * given opportunities.
 *
 * @param {object} params
 * @param {string} params.message the customer's request
 * @param {Array<{id,type,title,data}>} params.opportunities candidate opportunities
 * @param {object} params.env environment variables (Bedrock config)
 * @param {object} params.log logger
 * @returns {Promise<{ name, rationale, components, opportunityIds, reply }|null>}
 *   parsed+validated profile spec, or null if the LLM is unavailable/failed.
 */
export async function selectComponentsWithClaude({
  message, opportunities, env, log,
}) {
  const config = getBedrockConfig(env);
  if (!config) {
    log.info('Bedrock not configured; profile-builder LLM unavailable');
    return null;
  }

  try {
    const userPayload = {
      request: message,
      opportunities: opportunities.map((o) => ({
        id: o.id, type: o.type, title: o.title, data: o.data,
      })),
    };

    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        system: [{ text: buildSystemPrompt() }],
        messages: [{ role: 'user', content: [{ text: JSON.stringify(userPayload) }] }],
        inferenceConfig: { maxTokens: 4096 },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      log.warn(`Bedrock converse returned ${response.status}: ${detail}`);
      return null;
    }

    const body = await response.json();
    const text = body?.output?.message?.content?.find((b) => hasText(b?.text))?.text;
    const parsed = extractJson(text);
    if (!parsed) {
      log.warn('Bedrock response did not contain parseable JSON');
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn(`Bedrock profile-builder call failed: ${error.message}`);
    return null;
  }
}

/**
 * Validates and normalizes a raw LLM profile spec against the catalog and the
 * set of real opportunity ids.
 *
 * @param {object} raw the parsed LLM output
 * @param {Set<string>} validOpportunityIds ids of the opportunities we fetched
 * @returns {{ name, rationale, components, opportunityIds, reply }|null}
 *   null when nothing usable survived validation.
 */
export function validateProfileSpec(raw, validOpportunityIds) {
  if (!raw || !Array.isArray(raw.components)) {
    return null;
  }

  const components = raw.components
    .filter((c) => c && VALID_COMPONENT_IDS.has(c.id) && c.data && typeof c.data === 'object')
    .slice(0, MAX_COMPONENTS)
    .map((c) => ({
      id: c.id,
      title: hasText(c.title) ? c.title : c.id,
      data: c.data,
    }));

  if (components.length === 0) {
    return null;
  }

  const opportunityIds = Array.isArray(raw.opportunityIds)
    ? raw.opportunityIds.filter((id) => validOpportunityIds.has(id))
    : [];

  return {
    name: hasText(raw.name) ? raw.name : 'Custom profile',
    rationale: hasText(raw.rationale) ? raw.rationale : '',
    components,
    opportunityIds,
    reply: hasText(raw.reply) ? raw.reply : 'I created a profile from your request.',
  };
}
