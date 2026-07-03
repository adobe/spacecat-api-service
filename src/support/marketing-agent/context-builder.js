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

/*
 * POC: assembles the data-source context that grounds the Adobe Marketing Agent / CoWorker.
 *
 * Proven pattern (live MCP calls, 2026-07-03): data sources (LLM Optimizer, Sites
 * Optimizer, Semrush) are INPUTS; the agent synthesizes when data is provided inline.
 *
 * Two roles, one live agent:
 *  - CoWorker  (buildCoworkerBriefPrompt): full GEO strategic brief — KPIs + 6 considerations.
 *  - Marketing Agent (buildMarketingAgentPrompt): operational insights / Experience Cloud data.
 */

const LOVESAC_CONTEXT = `Brand: Lovesac (lovesac.com) — modular furniture (Sactionals, Sacs, Accessories).
- AI Visibility 8/100 (rank 6 of 13); AI Favorability 87 (rank 1 of 13); AI Safety 84; GEO readiness leader in all 3 product lines (avg 8.7/10).
- Unbranded discovery led by IKEA 24, West Elm 15, Ashley 14.
- Semrush AI Visibility 30/100 (AI Overview 56, Gemini 47, ChatGPT 32); 52K organic keywords; 530K organic visits/mo; 18.15M monthly AI audience.
- LLM Optimizer: 5,327 pages need pre-render; 4,919 FAQ pairs ready; 26% structured-data errored; 1,603 AI-bot error pages.
- AI citations: Reddit 38%, YouTube 35%, owned 21%; brand/OEM sites ~1.7%.
- Sentiment: Reddit 71% favorable (durability, washability, value). Widest wins: Washability +3.5, Tech Integration +3.5.`;

/**
 * Returns the gathered data-source context string for a site.
 * POC: static Lovesac block. In production this would be assembled per-site from
 * LLM Optimizer, Sites Optimizer and Semrush.
 * @returns {string} data-source context to ground the agent
 */
export function getMarketingConsultantContext() {
  return LOVESAC_CONTEXT;
}

/**
 * CoWorker: asks for a FULL GEO strategic brief as structured JSON — 4 KPIs and exactly
 * 6 "things to take into consideration" — plus an executive summary. JSON keeps the rich
 * UI (KPIs + KeyInsights) populated with live content.
 * @param {string} contextData
 * @returns {string} prompt
 */
export function buildCoworkerBriefPrompt(contextData) {
  return [
    'You are Adobe CoWorker. I am providing gathered source data below (LLM Optimizer, Sites Optimizer, Semrush).',
    'Do NOT fetch or analyze any external system — synthesize THIS data into a full GEO strategic brief.',
    'Return ONLY a JSON object (no prose, no markdown code fences) with EXACTLY this shape:',
    '{',
    '  "executiveSummary": "one concise paragraph",',
    '  "kpis": [ { "label": "AI Visibility", "score": 8, "rank": 6, "totalBrands": 13, "benchmarkDelta": "short note" } ],',
    '  "considerations": [ { "title": "short title", "bullets": ["point", "point", "point"] } ]',
    '}',
    'Rules: "kpis" MUST be 4 items and MUST use the KPI numbers from the data (AI Visibility, AI Favorability, AI Safety, GEO Readiness).',
    '"considerations" MUST be EXACTLY 6 items — the six things to take into consideration — each with 2-3 short bullets.',
    '',
    'DATA:',
    contextData,
  ].join('\n');
}

/**
 * Marketing Agent: operational insights, campaign context and Adobe Experience Cloud
 * data-grounding angles. Returns plain text bullets.
 * @param {string} contextData
 * @returns {string} prompt
 */
export function buildMarketingAgentPrompt(contextData) {
  return [
    'You are the Adobe Marketing Agent. I am providing gathered source data below.',
    'Do NOT fetch anything — synthesize THIS data into operational marketing insights:',
    'campaign context, Adobe Experience Cloud data-grounding angles, and concrete activation next steps.',
    'Return 4-6 concise bullet points, one per line, each starting with "- ". Output only the bullets.',
    '',
    'DATA:',
    contextData,
  ].join('\n');
}
