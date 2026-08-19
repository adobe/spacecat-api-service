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
 * Market Discovery controller (POC — elmo Visibility Overview dashboard).
 * Ported from the brand_audit app's full 5-step pipeline (Brand Discovery ->
 * Market Discovery -> Generate Prompts -> Execute Prompts -> Analyze SoV,
 * `app/api/{market-discovery,generate-prompts,execute-prompts,analyze-sov}/
 * route.js`), collapsed to three endpoints. The Brand Discovery step (building
 * a full brand profile) is dropped — the dashboard is scoped to one hardcoded
 * brand (see `MarketDiscoveryDataService`), so there's no profile to build.
 *
 * `getCategories` mirrors `market-discovery`: given an industry (+ optional
 * products/services/region), returns the market's categories and topics.
 * `getTopicSources` collapses `generate-prompts` (scoped to one topic, one
 * prompt instead of three) + `execute-prompts` (one topic instead of all of
 * them) into a single "what sources and answer come up for this topic"
 * lookup — called on demand per topic (not for all topics on load) to keep
 * the LLM/search cost and latency bounded per call; the frontend fans this
 * out across topics only when the caller explicitly asks for Share of Voice.
 * `getShareOfVoice` mirrors `analyze-sov` as-is: given the hardcoded brand
 * name and a set of already-fetched `{category, topic, prompt, answer}`
 * results, counts brand mentions across them.
 */

import { badRequest, ok, internalServerError } from '@adobe/spacecat-shared-http-utils';
import { callLLM, callLLMJSON } from '../support/market-discovery/llm.js';
import { webSearch } from '../support/market-discovery/search.js';
import { suggestSourcesFromLLM, dedupSources } from '../support/market-discovery/sources.js';

function MarketDiscoveryController(context, log, env) {
  const getCategories = async (reqContext) => {
    const body = reqContext.data || {};
    const {
      industry, products, services, region,
    } = body;
    const regionCode = region || 'US';

    if (!industry) {
      return badRequest('industry is required');
    }

    const productList = (products || []).map((p) => `- ${p.name}: ${p.description}`).join('\n');
    const serviceList = (services || []).map((s) => `- ${s.name}: ${s.description}`).join('\n');

    let searchContext;
    try {
      const result = await webSearch(env, `${industry} market landscape categories trends competitive analysis ${regionCode}`);
      searchContext = result?.context;
    } catch (e) {
      log.warn('[market-discovery] web search failed, continuing without it', e);
    }

    const searchBlock = searchContext
      ? `\n\nHere are recent web search results about the ${industry} market in ${regionCode}:\n\n${searchContext}\n\n`
        + 'Use these search results to understand the current market landscape. Categories should reflect the real '
        + "market, not just this one brand's offerings."
      : '';

    const regionInstruction = regionCode !== 'Global'
      ? `Focus on the ${regionCode} market — include competitors and categories relevant to the ${regionCode} region specifically.`
      : 'Consider the global market landscape across all regions.';

    const messages = [
      {
        role: 'system',
        content: 'You are a market research analyst specializing in competitive landscapes. Always respond with '
          + 'valid JSON only — no markdown fences, no preamble.',
      },
      {
        role: 'user',
        content: `Given a brand in the "${industry}" industry operating in the ${regionCode} market with these offerings:

PRODUCTS:
${productList || '(none identified)'}

SERVICES:
${serviceList || '(none identified)'}
${searchBlock}
Identify the broader MARKET categories and sub-topics relevant to this industry in the ${regionCode} market — not just what this brand does, but what the entire market covers. ${regionInstruction}

IMPORTANT:
- Return at most 5 categories, at most 3 topics per category
- Categories are the main market segments (e.g., "Performance Athletic Footwear", "Creative Design & Image Editing Software")
- Topics are SUB-CATEGORIES within each category — short noun phrases, NOT questions or prompts (e.g., "Marathon Running Shoes", "Trail Running Footwear")
- Topics should be 2-5 words, written as category labels, not as search queries
- Include categories where competitors in ${regionCode} might dominate

Return this exact JSON structure:
{
  "categories": [
    {
      "name": "Category Name",
      "topics": ["specific topic 1", "specific topic 2", "specific topic 3"]
    }
  ]
}`,
      },
    ];

    try {
      const result = await callLLMJSON(env, { messages, options: { maxTokens: 2048 } });
      result.webSearchUsed = !!searchContext;
      return ok(result);
    } catch (e) {
      log.error('[market-discovery] getCategories failed', e);
      return internalServerError(e.message);
    }
  };

  const getTopicSources = async (reqContext) => {
    const body = reqContext.data || {};
    const { industry, topic, region } = body;
    const regionCode = region || 'US';

    if (!industry || !topic) {
      return badRequest('industry and topic are required');
    }

    // Three short, brand-agnostic prompts for this single topic (generate-prompts,
    // matching the original pipeline's "3 per topic" — each gets its own search +
    // answer lookup below, so Share of Voice analyzes 3 independent samples per topic
    // instead of 1).
    let prompts;
    try {
      const promptMessages = [
        {
          role: 'system',
          content: 'You are a market research analyst. Always respond with valid JSON only — no markdown fences, '
            + 'no preamble.',
        },
        {
          role: 'user',
          content: `For the topic "${topic}" (in the "${industry}" industry, ${regionCode} market), write 3 short, `
            + 'natural questions a consumer would ask an AI assistant or search engine about it. '
            + 'Do NOT mention any specific brand name. Keep each under 15 words, ending with a question mark. '
            + 'Vary the phrasing and angle across the 3 questions. '
            + 'Return this exact JSON structure: { "prompts": ["question one?", "question two?", "question three?"] }',
        },
      ];
      const promptResult = await callLLMJSON(
        env,
        { messages: promptMessages, options: { maxTokens: 400 } },
      );
      prompts = (promptResult?.prompts ?? []).filter((p) => typeof p === 'string' && p.trim());
    } catch (e) {
      log.error('[market-discovery] topic prompt generation failed', e);
      return internalServerError(e.message);
    }

    if (prompts.length === 0) {
      return internalServerError('Failed to generate prompts for this topic');
    }

    // Each prompt gets its own search + answer lookup (execute-prompts), run in
    // parallel — a failed lookup for one prompt is non-fatal (returns sources-less/
    // answer-less), it just narrows that prompt's usable sample.
    const promptResults = await Promise.all(prompts.map(async (prompt) => {
      let mainResult;
      let redditResult;
      let youtubeResult;
      let llmSources;
      try {
        [mainResult, redditResult, youtubeResult, llmSources] = await Promise.all([
          webSearch(env, prompt, 5),
          webSearch(env, prompt, 3, { includeDomains: ['reddit.com'] }),
          webSearch(env, prompt, 3, { includeDomains: ['youtube.com'] }),
          suggestSourcesFromLLM(env, prompt),
        ]);
      } catch (e) {
        log.warn('[market-discovery] getTopicSources search failed for one prompt, returning empty', e);
        return { prompt, answer: null, sources: [] };
      }

      const sources = dedupSources([
        ...(mainResult?.sources ?? []),
        ...(redditResult?.sources ?? []),
        ...(youtubeResult?.sources ?? []),
        ...(llmSources ?? []),
      ]);

      let answer = null;
      try {
        const contextParts = [];
        if (mainResult?.context) {
          contextParts.push(mainResult.context);
        }
        if (redditResult?.context) {
          contextParts.push(`Additional Reddit threads:\n${redditResult.context}`);
        }
        if (youtubeResult?.context) {
          contextParts.push(`Additional YouTube videos:\n${youtubeResult.context}`);
        }
        const searchContext = contextParts.join('\n\n');

        const systemContent = searchContext
          ? `You are a knowledgeable assistant. Use the following web search results as your primary source of facts:\n\n${searchContext}\n\n`
            + 'Answer the user\'s question thoroughly and naturally. Where relevant, reference the source by publication '
            + 'name inline (e.g. "according to Wirecutter" or "Runner\'s World recommends"). Mention specific brand '
            + 'names, product names, and where to buy. Be helpful and direct.'
          : 'You are a knowledgeable assistant. Answer the user\'s question thoroughly. Mention specific brand names, '
            + 'product names, and where to buy. Be helpful and direct.';

        answer = await callLLM(env, {
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: prompt },
          ],
          options: { maxTokens: 2048 },
        });
      } catch (e) {
        // Non-fatal — sources are still useful without an answer. Share of
        // Voice skips any prompt with a null answer (see getShareOfVoice).
        log.warn('[market-discovery] topic answer generation failed for one prompt, returning sources only', e);
      }

      return { prompt, answer, sources };
    }));

    return ok({ topic, prompts: promptResults });
  };

  const getShareOfVoice = async (reqContext) => {
    const body = reqContext.data || {};
    const { brand, results } = body;

    if (!brand?.trim() || !results?.length) {
      return badRequest('brand and results are required');
    }

    const answersSummary = results
      .map((r, i) => `[${i + 1}] Category: ${r.category} | Topic: ${r.topic}\nQ: ${r.prompt}\nA: ${r.answer}`)
      .join('\n\n');

    const messages = [
      {
        role: 'system',
        content: 'You are a brand intelligence analyst specializing in AI Share of Voice measurement. Always '
          + 'respond with valid JSON only — no markdown fences, no preamble.',
      },
      {
        role: 'user',
        content: `Analyze the following ${results.length} AI-generated answers to non-branded industry prompts. Count how many times each brand/product is mentioned or recommended across all answers.

The primary brand we are auditing is: "${brand.trim()}"

Here are all the prompt-answer pairs:
${answersSummary}

Compute Share of Voice (SoV) as: (brand_mentions / total_all_brand_mentions) * 100

Instructions:
- Count each distinct mention of a brand in an answer (if "Adobe Photoshop" and "Adobe Illustrator" both appear, that is 2 mentions for Adobe)
- Group sub-brands under their parent company (e.g., "Photoshop" counts as "Adobe")
- Include only the TOP 10 brands by mention count in the overall rankings (skip the rest)
- Sort rankings by shareOfVoice descending
- Mark the primary brand with isPrimary: true
- Provide a category-level breakdown showing SoV per category — include only TOP 5 brands per category
- Also provide a TOPIC-level breakdown, one entry per distinct topic in the prompt-answer pairs above (every
  topic must appear once, even if the primary brand has 0 mentions there) — include only TOP 5 brands per topic
- shareOfVoice values must be decimal numbers (e.g., 25.5)
- Keep the response CONCISE — do not include brands with very few mentions

Return this exact JSON structure:
{
  "brand": "${brand.trim()}",
  "totalPrompts": ${results.length},
  "totalMentions": <total mentions across all brands>,
  "rankings": [
    { "brand": "Brand Name", "mentions": <count>, "shareOfVoice": <percentage>, "isPrimary": true/false }
  ],
  "categoryBreakdown": [
    {
      "category": "Category Name",
      "rankings": [
        { "brand": "Brand Name", "mentions": <count>, "shareOfVoice": <percentage> }
      ]
    }
  ],
  "topicBreakdown": [
    {
      "topic": "topic name",
      "category": "Category Name",
      "totalMentions": <total mentions across all brands for this topic>,
      "rankings": [
        { "brand": "Brand Name", "mentions": <count>, "shareOfVoice": <percentage>, "isPrimary": true/false }
      ]
    }
  ]
}`,
      },
    ];

    try {
      const result = await callLLMJSON(env, { messages, options: { maxTokens: 16384 } });
      return ok(result);
    } catch (e) {
      log.error('[market-discovery] getShareOfVoice failed', e);
      return internalServerError(e.message);
    }
  };

  return {
    getCategories, getTopicSources, getShareOfVoice,
  };
}

export default MarketDiscoveryController;
