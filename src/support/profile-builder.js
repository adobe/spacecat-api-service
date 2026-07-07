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
 * Shared Bedrock Converse call. Returns the parsed JSON object from the model,
 * or null if Bedrock is unconfigured / the call failed / the output wasn't JSON.
 * @param {object} params
 * @param {object} params.env
 * @param {object} params.log
 * @param {string} params.systemPrompt
 * @param {object} params.userPayload serialized as the user message
 * @returns {Promise<object|null>}
 */
async function callBedrock({
  env, log, systemPrompt, userPayload,
}) {
  const config = getBedrockConfig(env);
  if (!config) {
    log.info('Bedrock not configured; profile-builder LLM unavailable');
    return null;
  }

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        system: [{ text: systemPrompt }],
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
  "name": "<short, descriptive profile name (2–5 words) that reflects the goal or theme of the selected opportunities — NOT a concatenation of opportunity titles>",
  "rationale": "<one or two sentences explaining what you surfaced and why>",
  "components": [ { "id": "<catalog id>", "title": "<human title>", "data": { ... } } ],
  "opportunityIds": ["<id of each opportunity you used>"],
  "reply": "<one short sentence to show the user in chat>"
}
Rules: components length <= ${MAX_COMPONENTS}; every component id must be from the catalog; every opportunityId must be one of the provided opportunity ids; name must be a meaningful business-oriented label (e.g. "SEO Health", "Accessibility & Discovery", "Link & Metadata Fix") — never a raw concatenation like "Opportunity A + Opportunity B".`;
}

// ---------------------------------------------------------------------------
// Keyword-based opportunity matching — fallback when LLM is unavailable.
// Maps common search terms to opportunity type strings used in the DB.
// ---------------------------------------------------------------------------

const OPPORTUNITY_KEYWORD_MAP = [
  { types: ['alt-text'], keywords: ['alt text', 'alt-text', 'alttext', 'alternative text', 'image accessibility', 'image alt'] },
  { types: ['meta-tags'], keywords: ['meta tag', 'meta tags', 'metadata', 'title tag', 'description tag', 'meta description'] },
  { types: ['broken-backlinks'], keywords: ['backlink', 'broken backlink', 'external link'] },
  { types: ['broken-internal-links'], keywords: ['internal link', 'broken link', 'broken internal'] },
  { types: ['cwv'], keywords: ['cwv', 'core web vitals', 'web vitals', 'lcp', 'cls', 'fid', 'inp', 'page speed', 'pagespeed'] },
  { types: ['canonical'], keywords: ['canonical'] },
  { types: ['structured-data'], keywords: ['structured data', 'schema markup', 'schema.org', 'json-ld', 'schema'] },
  { types: ['sitemap'], keywords: ['sitemap'] },
  { types: ['consent-banner'], keywords: ['consent', 'cookie banner', 'gdpr', 'cookie consent'] },
  { types: ['high-organic-low-ctr'], keywords: ['ctr', 'organic ctr', 'click through', 'click-through', 'low ctr'] },
  { types: ['security', 'security-xss', 'security-vulnerabilities', 'security-permissions', 'security-csp'], keywords: ['security', 'xss', 'csp', 'vulnerability', 'vulnerabilities'] },
  { types: ['a11y-assistive', 'a11y-color-contrast'], keywords: ['accessibility', 'a11y', 'color contrast', 'wcag', 'assistive'] },
];

// ---------------------------------------------------------------------------
// Workflow registry and keyword constants
// ---------------------------------------------------------------------------

const WORKFLOW_REGISTRY = [
  { id: 'createJiraTicket', description: 'Open a Jira issue pre-filled with opportunity details and suggestions.' },
  { id: 'createGitHubPR', description: 'Generate a pull request with automated fixes for the selected items.' },
  { id: 'deployAndPublish', description: 'Deploy fixes to AEM author environment and publish affected pages.' },
];

const KNOWN_SCOPE_TYPES = [
  'broken-backlinks', 'broken-internal-links', 'meta-tags', 'alt-text', 'cwv',
  'canonical', 'structured-data', 'sitemap', 'consent-banner',
  'high-organic-low-ctr', 'security', 'all',
];

const VALID_WORKFLOW_IDS = new Set(WORKFLOW_REGISTRY.map((w) => w.id));

const WORKFLOW_DEFAULT_NAMES = {
  createJiraTicket: 'Jira ticket workflow',
  createGitHubPR: 'GitHub PR workflow',
  deployAndPublish: 'Deploy and publish workflow',
};

const WORKFLOW_KEYWORD_MAP = [
  { id: 'createJiraTicket', keywords: ['jira', 'ticket', 'jira ticket', 'jira issue'] },
  { id: 'createGitHubPR', keywords: ['github pr', 'pull request', ' pr ', 'github pull'] },
  { id: 'deployAndPublish', keywords: ['deploy', 'publish', 'deployment'] },
];

const SCOPE_KEYWORD_MAP = [
  { scope: 'cwv', keywords: ['cwv', 'core web vitals', 'web vitals'] },
  { scope: 'broken-backlinks', keywords: ['backlink', 'broken backlink'] },
  { scope: 'broken-internal-links', keywords: ['internal link', 'broken link', 'internal links'] },
  { scope: 'meta-tags', keywords: ['meta tag', 'meta tags'] },
  { scope: 'alt-text', keywords: ['alt text', 'alt-text', 'alttext'] },
  { scope: 'canonical', keywords: ['canonical'] },
  { scope: 'structured-data', keywords: ['structured data', 'schema markup', 'schema.org'] },
  { scope: 'sitemap', keywords: ['sitemap'] },
  { scope: 'consent-banner', keywords: ['consent', 'cookie banner', 'gdpr'] },
  { scope: 'high-organic-low-ctr', keywords: ['ctr', 'organic ctr', 'low ctr'] },
  { scope: 'security', keywords: ['security'] },
];

/**
 * Keyword-based opportunity selector used as a fallback when the LLM is
 * unavailable. Matches the user message against known opportunity type keywords
 * and returns the IDs of any candidate opportunities whose type is matched.
 *
 * @param {string} message
 * @param {Array<{id,type,title,data}>} opportunities
 * @returns {{ opportunityIds: string[] }|null} null when nothing matched
 */
function selectOpportunitiesFromKeywords(message, opportunities) {
  const lower = ` ${message.toLowerCase()} `;

  const matchedTypes = new Set();
  for (const entry of OPPORTUNITY_KEYWORD_MAP) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      entry.types.forEach((t) => matchedTypes.add(t));
    }
  }

  if (matchedTypes.size === 0) {
    return null;
  }

  const opportunityIds = opportunities
    .filter((o) => matchedTypes.has(o.type))
    .map((o) => o.id);

  return opportunityIds.length > 0 ? { opportunityIds } : null;
}

/**
 * Builds a minimal fallback component for an opportunity without using the LLM.
 * Returns a single `callout` summarising the opportunity so the profile is
 * still usable when Bedrock is unavailable.
 *
 * @param {{ id, type, title }} opportunity
 * @returns {{ components, opportunityIds, reply }}
 */
function buildDefaultComponentForOpportunity(opportunity) {
  return {
    components: [
      {
        id: 'callout',
        title: opportunity.title,
        data: {
          message: `Added "${opportunity.title}" to your profile. Visit the Opportunities page to see details and suggested fixes.`,
          variant: 'info',
        },
      },
    ],
    opportunityIds: [opportunity.id],
    reply: `Added "${opportunity.title}" to your profile.`,
  };
}

/**
 * Calls Claude (Bedrock Converse) to select components for a profile from the
 * given opportunities. Falls back to keyword matching when the LLM is
 * unavailable so basic requests ("add alt-text opportunity") always work.
 *
 * @param {object} params
 * @param {string} params.message the customer's request
 * @param {Array<{id,type,title,data}>} params.opportunities candidate opportunities
 * @param {object} params.env environment variables (Bedrock config)
 * @param {object} params.log logger
 * @returns {Promise<{ name, rationale, components, opportunityIds, reply }|null>}
 *   parsed+validated profile spec, or null if both the LLM and keyword match failed.
 */
export async function selectComponentsWithClaude({
  message, opportunities, env, log,
}) {
  const userPayload = {
    request: message,
    opportunities: opportunities.map((o) => ({
      id: o.id, type: o.type, title: o.title, data: o.data,
    })),
  };
  const result = await callBedrock({
    env, log, systemPrompt: buildSystemPrompt(), userPayload,
  });
  if (result !== null) {
    return result;
  }

  // LLM unavailable — fall back to keyword matching so common requests
  // ("add alt-text opportunity") always resolve.
  return selectOpportunitiesFromKeywords(message, opportunities);
}

// ---------------------------------------------------------------------------
// Unified add-intent detection (call 1 of 2 for the add-to-existing path)
//
// Sends only lightweight opportunity stubs (id, type, title — no full data)
// plus the workflow registry so a single LLM call can identify both which
// opportunities the user wants to add AND which workflows they want to schedule.
// ---------------------------------------------------------------------------

/**
 * Builds the unified intent-detection prompt used for the add-to-existing path.
 * @returns {string}
 */
function buildAddIntentPrompt() {
  const workflows = WORKFLOW_REGISTRY
    .map((w) => `- "${w.id}": ${w.description}`)
    .join('\n');
  const scopes = KNOWN_SCOPE_TYPES.join(', ');

  return `You are an assistant for a website optimisation profile tool.
The user has an existing profile and is sending a chat message.
Determine:
1. Which opportunities (if any) they want to ADD — from the provided list.
2. Which workflows (if any) they want to SCHEDULE — from the provided registry.

Available workflows:
${workflows}

Valid scope values (pick the closest match or "all"): ${scopes}

Rules:
- opportunityIds must only contain ids from the provided opportunities list.
- workflows must only contain workflowIds from the available workflows list.
- A message can contain BOTH opportunities and workflows at the same time.
- If nothing matches, return empty arrays — never invent ids.
- name must be a 2-5 word business-oriented label reflecting all opportunities
  now in the profile (existing ones plus newly added). Never concatenate titles.
- If no opportunities are being added, omit "name" or set it to null.

Respond with ONLY valid JSON (no prose, no markdown):
{
  "opportunityIds": ["<id from the provided list>"],
  "workflows": [
    { "workflowId": "<id from registry>", "scope": "<scope value or 'all'>", "name": "<short label>" }
  ],
  "name": "<revised profile name or null>",
  "reply": "<one short sentence summarising what was done>"
}`;
}

/**
 * Keyword-based fallback for the unified add-intent detection.
 * Finds ALL matching opportunity ids AND ALL matching workflows from the message.
 *
 * @param {string} message
 * @param {Array<{id,type}>} opportunities lightweight stubs
 * @returns {{ opportunityIds: string[], workflows: Array }}
 */
function detectAddIntentFromKeywords(message, opportunities) {
  const lower = ` ${message.toLowerCase()} `;

  // --- opportunities ---
  const matchedTypes = new Set();
  for (const entry of OPPORTUNITY_KEYWORD_MAP) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      entry.types.forEach((t) => matchedTypes.add(t));
    }
  }
  const opportunityIds = opportunities
    .filter((o) => matchedTypes.has(o.type))
    .map((o) => o.id);

  // --- workflows ---
  // "workflow" alone (e.g. "add a jira ticket workflow") counts as a scheduling intent.
  const hasScheduleVerb = /\b(schedule|automate|automation|set up|setup|trigger|run workflow|workflow)\b/.test(lower);
  const workflows = [];
  if (hasScheduleVerb) {
    for (const w of WORKFLOW_KEYWORD_MAP) {
      if (w.keywords.some((kw) => lower.includes(kw))) {
        const scopeMatch = SCOPE_KEYWORD_MAP
          .find((s) => s.keywords.some((kw) => lower.includes(kw)));
        const scope = scopeMatch?.scope ?? 'all';
        const baseName = WORKFLOW_DEFAULT_NAMES[w.id];
        workflows.push({
          workflowId: w.id,
          scope,
          name: scope === 'all' ? baseName : `${baseName} for ${scope}`,
        });
      }
    }
  }

  return { opportunityIds, workflows };
}

/**
 * Calls Claude to detect which opportunities and workflows the user wants to
 * add/schedule in a single LLM call. Falls back to keyword matching when the
 * LLM is unavailable.
 *
 * @param {object} params
 * @param {string} params.message
 * @param {Array<{id,type,title}>} params.opportunities lightweight stubs (no full data)
 * @param {string} params.currentProfileName
 * @param {object} params.env
 * @param {object} params.log
 * @returns {Promise<{ opportunityIds: string[], workflows: Array, name: string|null,
 *   reply: string|null }>}
 */
export async function detectAddIntent({
  message, opportunities, currentProfileName, env, log,
}) {
  const userPayload = {
    request: message,
    currentProfileName: currentProfileName ?? 'Custom profile',
    opportunities: opportunities.map((o) => ({ id: o.id, type: o.type, title: o.title })),
  };

  const result = await callBedrock({
    env, log, systemPrompt: buildAddIntentPrompt(), userPayload,
  });

  if (result !== null) {
    const validIds = new Set(opportunities.map((o) => o.id));
    const opportunityIds = Array.isArray(result.opportunityIds)
      ? result.opportunityIds.filter((id) => validIds.has(id))
      : [];

    const workflows = Array.isArray(result.workflows)
      ? result.workflows.filter((w) => VALID_WORKFLOW_IDS.has(w?.workflowId))
        .map((w) => ({
          workflowId: w.workflowId,
          scope: hasText(w.scope) ? w.scope : 'all',
          name: hasText(w.name)
            ? w.name
            : (WORKFLOW_DEFAULT_NAMES[w.workflowId] ?? w.workflowId),
        }))
      : [];

    return {
      opportunityIds,
      workflows,
      name: hasText(result.name) ? result.name : null,
      reply: hasText(result.reply) ? result.reply : null,
    };
  }

  // LLM unavailable — keyword fallback
  const fallback = detectAddIntentFromKeywords(message, opportunities);
  return { ...fallback, name: null, reply: null };
}

/**
 * System prompt for building component(s) for a SINGLE opportunity that is
 * being added to an existing profile.
 * @returns {string}
 */
function buildAddOpportunityPrompt() {
  const catalog = COMPONENT_CATALOG
    .map((c) => `- "${c.id}": ${c.description}\n    ${c.dataShape}`)
    .join('\n');

  return `You are adding ONE opportunity to an existing website profile.
You are given the customer's request and a single opportunity (id, type, title, data).

Build 1 (at most 2) component(s) from the catalog below that best represent this
opportunity, filling each component's "data" from the opportunity data.

Available components (use the exact "id" and the described data shape):
${catalog}

Respond with ONLY a JSON object (no prose, no markdown) of this exact form:
{
  "name": "<revised short profile name (2–5 words) that reflects all opportunities now in the profile — a meaningful business-oriented label, never a raw concatenation of titles>",
  "components": [ { "id": "<catalog id>", "title": "<human title>", "data": { ... } } ],
  "opportunityIds": ["<the opportunity id you used>"],
  "reply": "<one short sentence to show the user in chat>"
}
Rules: components length <= ${MAX_COMPONENTS}; every component id must be from the catalog; opportunityIds must be the provided opportunity id; name must be a meaningful business-oriented label (e.g. "SEO Health", "Accessibility & Discovery", "Link & Metadata Fix") — never a raw concatenation like "Custom profile + Broken Backlinks + Meta Tags".`;
}

/**
 * Calls Claude to build component(s) for a single opportunity being added to a
 * profile.
 *
 * @param {object} params
 * @param {string} params.message the customer's request (e.g. "add alt text")
 * @param {{id,type,title,data}} params.opportunity the matched opportunity
 * @param {object} params.env
 * @param {object} params.log
 * @returns {Promise<{ components, opportunityIds, reply }|null>}
 */
export async function buildComponentsForOpportunity({
  message, opportunity, currentProfileName, env, log,
}) {
  const userPayload = {
    request: message,
    currentProfileName: currentProfileName ?? 'Custom profile',
    opportunity: {
      id: opportunity.id,
      type: opportunity.type,
      title: opportunity.title,
      data: opportunity.data,
    },
  };
  const result = await callBedrock({
    env, log, systemPrompt: buildAddOpportunityPrompt(), userPayload,
  });
  if (result !== null) {
    return result;
  }

  // LLM unavailable — return a simple callout so the opportunity is still
  // added to the profile with at least minimal visual representation.
  return buildDefaultComponentForOpportunity(opportunity);
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

/**
 * Lightweight keyword-based workflow intent detector used as a fallback when
 * the LLM is unavailable. Returns null when the message doesn't look like a
 * workflow scheduling request.
 * @param {string} message
 * @returns {{ isWorkflow: true, workflowId, scope, name, reply }|null}
 */
function detectWorkflowIntentFromKeywords(message) {
  const lower = ` ${message.toLowerCase()} `;

  // Must contain a scheduling verb to avoid misclassifying "add a jira field"
  const hasScheduleVerb = /\b(schedule|automate|automation|set up|setup|trigger|run workflow)\b/.test(lower);
  if (!hasScheduleVerb) {
    return null;
  }

  const match = WORKFLOW_KEYWORD_MAP.find((w) => w.keywords.some((kw) => lower.includes(kw)));
  if (!match) {
    return null;
  }

  const scopeMatch = SCOPE_KEYWORD_MAP.find((s) => s.keywords.some((kw) => lower.includes(kw)));
  const scope = scopeMatch?.scope ?? 'all';
  const baseName = WORKFLOW_DEFAULT_NAMES[match.id];
  const name = scope === 'all' ? baseName : `${baseName} for ${scope}`;

  return {
    isWorkflow: true,
    workflowId: match.id,
    scope,
    name,
    reply: `Scheduled "${name}" for your profile.`,
  };
}

function buildWorkflowDetectionPrompt() {
  const workflows = WORKFLOW_REGISTRY
    .map((w) => `- "${w.id}": ${w.description}`)
    .join('\n');
  const scopes = KNOWN_SCOPE_TYPES.join(', ');
  return `You are a workflow scheduling assistant for a website optimization profile.
Decide whether the user's message is asking to CREATE or SCHEDULE a workflow/automation.

Available workflows:\n${workflows}

Valid scope values (pick the closest match, or "all"): ${scopes}

Rules:
- If the message is clearly about scheduling/creating a workflow (even if incomplete or trailing off), set isWorkflow to true.
- If no scope is mentioned or the message is cut off, always default scope to "all".
- If no name is clear from the message, generate a short descriptive one from the workflowId.
- Only set isWorkflow to false when the message is clearly about something else (adding an opportunity, asking a question, etc.).

If NOT a workflow request: {"isWorkflow":false}

If IS a workflow request, respond with ONLY valid JSON (no prose, no markdown):
{
  "isWorkflow": true,
  "workflowId": "<exact id from the list above>",
  "scope": "<one scope value from the valid list, or 'all'>",
  "name": "<short descriptive label, e.g. 'Jira tickets for broken backlinks'>",
  "reply": "<one short sentence confirming what was scheduled>"
}`;
}

/**
 * Calls Claude to determine whether the user's message is a workflow creation
 * request. Returns the parsed intent or null on failure.
 *
 * @param {object} params
 * @param {string} params.message
 * @param {object} params.env
 * @param {object} params.log
 * @returns {Promise<{isWorkflow: boolean, workflowId?: string, scope?: string,
 *   name?: string, reply?: string}|null>}
 */
export async function detectWorkflowIntent({ message, env, log }) {
  const bedrockResult = await callBedrock({
    env,
    log,
    systemPrompt: buildWorkflowDetectionPrompt(),
    userPayload: { message },
  });
  if (bedrockResult !== null) {
    return bedrockResult;
  }

  // LLM unavailable — fall back to keyword matching so basic workflow
  // scheduling ("schedule jira ticket for cwv") always works.
  return detectWorkflowIntentFromKeywords(message);
}

/**
 * Normalizes a raw workflow intent from the LLM, filling in defaults for any
 * missing fields. Returns null only when the intent is definitively not a
 * workflow or carries an unrecognized workflowId.
 *
 * @param {object|null} intent result of detectWorkflowIntent
 * @returns {{ isWorkflow: true, workflowId, scope, name, reply }|null}
 */
export function normalizeWorkflowIntent(intent) {
  if (!intent?.isWorkflow || !VALID_WORKFLOW_IDS.has(intent?.workflowId)) {
    return null;
  }
  return {
    isWorkflow: true,
    workflowId: intent.workflowId,
    scope: hasText(intent.scope) ? intent.scope : 'all',
    name: hasText(intent.name)
      ? intent.name
      : (WORKFLOW_DEFAULT_NAMES[intent.workflowId] ?? intent.workflowId),
    reply: hasText(intent.reply)
      ? intent.reply
      : `Scheduled "${WORKFLOW_DEFAULT_NAMES[intent.workflowId] ?? intent.workflowId}" for your profile.`,
  };
}

/**
 * @deprecated Use normalizeWorkflowIntent — this strict check drops intents
 *   with missing scope/name rather than applying safe defaults.
 * @param {object|null} intent
 */
export function isValidWorkflowIntent(intent) {
  return normalizeWorkflowIntent(intent) !== null;
}

/**
 * Validates the component(s) returned when adding a single opportunity.
 * @param {object} raw parsed LLM output
 * @returns {{ components: Array, reply: string }|null} null when no valid component survived
 */
export function validateComponents(raw) {
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

  return {
    name: hasText(raw.name) ? raw.name : null,
    components,
    reply: hasText(raw.reply) ? raw.reply : 'I added that opportunity to your profile.',
  };
}
