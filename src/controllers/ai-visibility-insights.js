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

import { AzureChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  badRequest, createResponse, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { getGrpcClients } from '../support/ai-visibility/grpc-transport.js';
import { handleBrandStats, handleBrandTopics } from '../support/ai-visibility/handlers/brands.js';
import { cachedOk } from '../support/cached-response.js';

const SYSTEM_PROMPT = `You are an AI visibility analyst helping marketers understand their brand's presence in AI-generated answers.
Given brand metrics, produce a concise, actionable insight in JSON. Be specific and concrete — avoid generic advice.`;

function detectTrend(byDate) {
  if (!Array.isArray(byDate) || byDate.length < 2) {
    return 'flat';
  }
  const first = byDate[0]?.aiVisibility ?? 0;
  const last = byDate[byDate.length - 1]?.aiVisibility ?? 0;
  if (last > first * 1.05) {
    return 'up';
  }
  if (last < first * 0.95) {
    return 'down';
  }
  return 'flat';
}

function buildPrompt(domain, stats, topicItems) {
  const visibility = stats.aiVisibility ?? stats.visibility ?? 0;
  const visibilityPct = (visibility * 100).toFixed(1);
  const mentions = stats.mentions?.all ?? 0;
  const audience = stats.audience ?? 0;
  const trend = detectTrend(stats.byDate);
  const topTopics = topicItems.slice(0, 6).map((t) => t.name || t.topic || '').filter(Boolean).join(', ');
  const monthCount = (stats.byDate || []).length;

  return `Brand domain: ${domain}
AI Visibility Score: ${visibilityPct}%
Trend over last ${monthCount} months: ${trend}
Total AI mentions: ${mentions}
Estimated audience reached via AI: ${audience}
Top topics this brand appears in AI answers for: ${topTopics || 'none detected yet'}

Return ONLY a JSON object with exactly these fields:
{
  "summary": "<2-3 sentence plain-language summary of this brand's AI visibility position, what the trend means, and why it matters>",
  "trendDirection": "${trend}",
  "topTopic": "<single most strategic topic from the list above, or empty string if none>",
  "action": "<one specific, concrete action the marketer should take this week to improve AI visibility>"
}`;
}

function AiVisibilityInsightsController(context, log, env) {
  if (!isNonEmptyObject(context)) {
    throw new Error('Context required');
  }
  if (!log) {
    throw new Error('Log required');
  }

  const {
    AZURE_OPEN_AI_API_KEY: azureOpenAIApiKey,
    AZURE_OPEN_AI_API_INSTANCE_NAME: azureOpenAIApiInstanceName,
    AZURE_OPEN_AI_API_DEPLOYMENT_NAME: azureOpenAIApiDeploymentName,
    AZURE_OPEN_AI_API_VERSION: azureOpenAIApiVersion,
  } = env || {};

  const getInsights = async (reqContext) => {
    let sp;
    try {
      sp = new URL(reqContext.request.url).searchParams;
    } catch {
      return badRequest('Invalid request URL');
    }

    const domain = sp.get('domain')?.trim();
    if (!domain) {
      return badRequest('domain query parameter is required');
    }

    const region = sp.get('region')?.trim() || 'US';

    let clients;
    try {
      clients = getGrpcClients(reqContext.env);
    } catch (e) {
      log.error('AI Visibility gRPC transport init failed', e);
      return createResponse(
        { error: 'aiVisibilityNotConfigured', message: 'AI Visibility is not configured.' },
        503,
      );
    }

    const statsSp = new URLSearchParams({ domain, region, windowMonths: '4' });
    const topicsSp = new URLSearchParams({ domain, region, limit: '10' });

    let statsBody;
    let topicsBody;
    try {
      const [statsResult, topicsResult] = await Promise.all([
        handleBrandStats(statsSp, clients),
        handleBrandTopics(topicsSp, clients),
      ]);

      if (statsResult.status !== 200) {
        log.warn('Brand stats returned non-200', statsResult);
        return createResponse(statsResult.body, statsResult.status);
      }
      statsBody = statsResult.body;
      topicsBody = topicsResult.status === 200 ? topicsResult.body : { items: [] };
    } catch (e) {
      log.error('AI Visibility data fetch failed', e);
      return internalServerError('Failed to fetch AI visibility data');
    }

    const topicItems = topicsBody?.items ?? [];

    let insight;
    try {
      const model = new AzureChatOpenAI({
        azureOpenAIApiKey,
        azureOpenAIApiInstanceName,
        azureOpenAIApiDeploymentName,
        azureOpenAIApiVersion,
        temperature: 0.3,
        maxTokens: 400,
      });

      const result = await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(buildPrompt(domain, statsBody, topicItems)),
      ]);

      insight = JSON.parse(result.content);
    } catch (e) {
      log.error('AI insight generation failed', e);
      return internalServerError('Failed to generate AI visibility insights');
    }

    return cachedOk({
      domain,
      region,
      aiVisibility: statsBody.aiVisibility ?? statsBody.visibility ?? 0,
      trendDirection: insight.trendDirection ?? detectTrend(statsBody.byDate),
      summary: insight.summary ?? '',
      topTopic: insight.topTopic ?? '',
      action: insight.action ?? '',
    });
  };

  return { getInsights };
}

export default AiVisibilityInsightsController;
