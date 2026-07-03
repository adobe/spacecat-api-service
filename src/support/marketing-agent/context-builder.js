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
 * The proven pattern (verified via live MCP calls, 2026-07-03) is: the data sources
 * (LLM Optimizer, Sites Optimizer, Semrush) are INPUTS; the agent is the reasoning
 * layer that synthesizes the brief when the data is provided inline. The agent refuses
 * to "analyze an external brand" with no data, but happily synthesizes provided data.
 *
 * For this POC the Lovesac context is static. In production this function would assemble
 * the block from real per-site sources (LLM Optimizer opportunities, Sites Optimizer
 * audits, Semrush exports) keyed by siteId.
 */

const LOVESAC_CONTEXT = `Brand: Lovesac (lovesac.com) — modular furniture (Sactionals, Sacs, Accessories).
- AI Visibility 8/100 (rank 6 of 13); AI Favorability 87 (rank 1 of 13); AI Safety 84; leader in all 3 product lines (avg 8.7/10).
- Unbranded discovery led by IKEA 24, West Elm 15, Ashley 14.
- Semrush AI Visibility 30/100 (AI Overview 56, Gemini 47, ChatGPT 32); 52K organic keywords; 530K organic visits/mo; 18.15M monthly AI audience.
- LLM Optimizer: 5,327 pages need pre-render; 4,919 FAQ pairs ready; 26% structured-data errored; 1,603 AI-bot error pages.
- AI citations: Reddit 38%, YouTube 35%, owned 21%; brand/OEM sites ~1.7%.
- Sentiment: Reddit 71% favorable (durability, washability, value). Widest wins: Washability +3.5, Tech Integration +3.5.`;

/**
 * Returns the gathered data-source context string for a site.
 * POC: returns the static Lovesac block. In production this would be assembled
 * per-site from LLM Optimizer, Sites Optimizer and Semrush.
 * @returns {string} data-source context to ground the agent
 */
export function getMarketingConsultantContext() {
  return LOVESAC_CONTEXT;
}

/**
 * Builds the grounding prompt sent to the agent. Frames the request as "synthesize
 * THIS data" (not "analyze an external brand"), which is what unlocks a real response.
 * @param {string} contextData - output of getMarketingConsultantContext
 * @returns {string} the full prompt
 */
export function buildBriefPrompt(contextData) {
  return [
    'I am providing gathered source data below (from LLM Optimizer, Sites Optimizer and Semrush).',
    'Do NOT fetch or analyze any external system — just synthesize THIS data.',
    'Task: write a short GEO strategic brief with (1) 3 key findings and (2) top 3 prioritized recommendations.',
    '',
    'DATA:',
    contextData,
    '',
    'Output only the brief.',
  ].join('\n');
}

/**
 * CoWorker framing: same grounded data, but asks the AEP Agentic Orchestrator for a
 * strategic execution plan (exec summary + prioritized 90-day plan) instead of a brief.
 * @param {string} contextData - output of getMarketingConsultantContext
 * @returns {string} the full prompt
 */
export function buildCoworkerPrompt(contextData) {
  return [
    'I am providing gathered source data below (from LLM Optimizer, Sites Optimizer and Semrush).',
    'Do NOT fetch or analyze any external system — just synthesize THIS data.',
    'Acting as a CX strategy coworker, produce: (1) a one-paragraph executive summary, and',
    '(2) a prioritized 90-day action plan of exactly 4 steps (owned / social / earned),',
    'each on one line with its expected outcome.',
    '',
    'DATA:',
    contextData,
    '',
    'Output only the executive summary and the 4-step plan.',
  ].join('\n');
}
