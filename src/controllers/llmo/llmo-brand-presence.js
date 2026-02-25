/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { ok, badRequest, forbidden } from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Brand Presence API handlers for querying mysticat-data-service PostgreSQL tables.
 * All handlers validate LLMO access and use Site.postgrestService for PostgREST queries.
 */

const SKIP_VALUES = new Set(['all', '', undefined, null]);

function shouldApplyFilter(value) {
  if (value == null) return false;
  if (typeof value === 'string' && SKIP_VALUES.has(value.trim())) return false;
  return hasText(String(value));
}

function parseQueryParams(context) {
  const q = context.data || {};
  return {
    startDate: q.startDate || q.start_date,
    endDate: q.endDate || q.end_date,
    model: q.model,
    category: q.category,
    topic: q.topic,
    region: q.region,
    origin: q.origin,
    promptBranding: q.promptBranding || q.prompt_branding,
    sortBy: q.sortBy || q.sort_by || 'topics',
    sortOrder: q.sortOrder || q.sort_order || 'asc',
    page: Math.max(0, parseInt(q.page, 10) || 0),
    pageSize: Math.min(
      100,
      Math.max(1, parseInt(q.pageSize, 10) || parseInt(q.page_size, 10) || 25),
    ),
    q: q.q,
  };
}

function toISOWeekKey(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - day + 3);
  const week1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const weekNum = 1 + Math.floor((thursday - week1) / 604800000);
  return `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Creates brand presence handlers. Requires getSiteAndValidateLlmo.
 * getSiteAndValidateLlmo already checks LLMO config and org access.
 */
export function createBrandPresenceHandlers(getSiteAndValidateLlmo) {
  const runWithPostgrest = async (context, handler) => {
    const { log, dataAccess } = context;
    const { Site } = dataAccess;

    if (!Site?.postgrestService) {
      log.error('Brand presence APIs require PostgREST (DATA_SERVICE_PROVIDER=postgres)');
      return badRequest('Brand presence data is not available. PostgreSQL data service is required.');
    }

    try {
      await getSiteAndValidateLlmo(context);
      return await handler(context, Site.postgrestService);
    } catch (error) {
      if (error.message?.includes('belonging to the organization')) {
        return forbidden('Only users belonging to the organization can view its sites');
      }
      if (error.message?.includes('LLM Optimizer is not enabled')) {
        return badRequest(error.message);
      }
      log.error(`Brand presence API error: ${error.message}`);
      return badRequest(error.message);
    }
  };

  const getFilterDimensions = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const params = parseQueryParams(ctx);
      let q = client
        .from('brand_presence_executions')
        .select('category_name, topics, region_code, origin, model')
        .eq('site_id', siteId);
      if (shouldApplyFilter(params.startDate)) q = q.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) q = q.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) q = q.eq('model', params.model);

      const { data, error } = await q.limit(5000);

      if (error) return badRequest(error.message);

      const categories = [...new Set((data || []).map((r) => r.category_name).filter(Boolean))];
      const topics = [...new Set((data || []).flatMap((r) => (r.topics ? r.topics.split(',').map((t) => t.trim()) : [])).filter(Boolean))];
      const regions = [...new Set((data || []).map((r) => r.region_code).filter(Boolean))];
      const origins = [...new Set((data || []).map((r) => r.origin).filter(Boolean))];
      const models = [...new Set((data || []).map((r) => r.model).filter(Boolean))];

      return ok({
        categories,
        topics,
        regions,
        origins,
        models,
      });
    });
    return result;
  };

  const getWeeks = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const { data, error } = await client
        .from('brand_presence_executions')
        .select('execution_date')
        .eq('site_id', siteId)
        .order('execution_date', { ascending: false })
        .limit(1000);

      if (error) return badRequest(error.message);

      const weekKeys = (data || []).map((r) => toISOWeekKey(r.execution_date));
      const weeks = [...new Set(weekKeys)].slice(0, 52);

      return ok(weeks);
    });
    return result;
  };

  const getMetadata = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const { data: totalData } = await client
        .from('brand_presence_executions')
        .select('id')
        .eq('site_id', siteId)
        .limit(1);

      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const weekAgoStr = weekAgo.toISOString().slice(0, 10);

      const { data: lastWeekData } = await client
        .from('brand_presence_executions')
        .select('id')
        .eq('site_id', siteId)
        .gte('execution_date', weekAgoStr)
        .limit(1);

      return ok({
        has_data: (totalData?.length ?? 0) > 0,
        has_data_last_week: (lastWeekData?.length ?? 0) > 0,
      });
    });
    return result;
  };

  const getStats = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const params = parseQueryParams(ctx);

      let q = client
        .from('brand_presence_executions')
        .select('visibility_score, mentions, id')
        .eq('site_id', siteId);

      if (shouldApplyFilter(params.startDate)) q = q.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) q = q.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) q = q.eq('model', params.model);
      if (shouldApplyFilter(params.category)) q = q.eq('category_name', params.category);
      if (shouldApplyFilter(params.topic)) q = q.eq('topics', params.topic);
      if (shouldApplyFilter(params.region)) q = q.eq('region_code', params.region);
      if (shouldApplyFilter(params.origin)) q = q.eq('origin', params.origin);

      const { data, error } = await q.limit(10000);

      if (error) return badRequest(error.message);

      const records = data || [];
      const visibilityScores = records
        .filter((r) => r.visibility_score != null)
        .map((r) => r.visibility_score);
      const avgVisibility = visibilityScores.length
        ? Math.round(visibilityScores.reduce((a, b) => a + b, 0) / visibilityScores.length)
        : 0;
      const brandMentions = records.filter((r) => r.mentions === true).length;

      const execIds = records.map((r) => r.id).filter(Boolean);
      const citedExecutionIds = new Set();
      if (execIds.length > 0) {
        const { data: sourcesData } = await client
          .from('brand_presence_sources')
          .select('execution_id')
          .in('execution_id', execIds)
          .eq('content_type', 'owned');
        (sourcesData || []).forEach((s) => citedExecutionIds.add(s.execution_id));
      }
      const citations = records.filter((r) => citedExecutionIds.has(r.id)).length;

      return ok({
        visibility_score: avgVisibility,
        brand_mentions: brandMentions,
        citations,
        top_competitors: [],
        top_topics: [],
      });
    });
    return result;
  };

  const getSentimentOverview = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const params = parseQueryParams(ctx);

      let q = client
        .from('brand_presence_executions')
        .select('execution_date, sentiment')
        .eq('site_id', siteId);

      if (shouldApplyFilter(params.startDate)) q = q.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) q = q.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) q = q.eq('model', params.model);
      if (shouldApplyFilter(params.category)) q = q.eq('category_name', params.category);
      if (shouldApplyFilter(params.topic)) q = q.eq('topics', params.topic);
      if (shouldApplyFilter(params.region)) q = q.eq('region_code', params.region);
      if (shouldApplyFilter(params.origin)) q = q.eq('origin', params.origin);

      const { data, error } = await q.limit(50000);

      if (error) return badRequest(error.message);

      const byWeek = {};
      (data || []).forEach((r) => {
        const d = new Date(r.execution_date);
        const weekStart = new Date(d);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const weekKey = weekStart.toISOString().slice(0, 10);
        if (!byWeek[weekKey]) {
          byWeek[weekKey] = {
            week: weekKey,
            total_prompts: 0,
            prompts_with_sentiment: 0,
            positive: 0,
            neutral: 0,
            negative: 0,
          };
        }
        byWeek[weekKey].total_prompts += 1;
        if (r.sentiment) {
          byWeek[weekKey].prompts_with_sentiment += 1;
          if (r.sentiment === 'positive') byWeek[weekKey].positive += 1;
          else if (r.sentiment === 'neutral') byWeek[weekKey].neutral += 1;
          else if (r.sentiment === 'negative') byWeek[weekKey].negative += 1;
        }
      });

      const weeks = Object.values(byWeek).sort((a, b) => a.week.localeCompare(b.week));
      return ok(weeks);
    });
    return result;
  };

  const getWeeklyTrends = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const params = parseQueryParams(ctx);

      let q = client
        .from('brand_metrics_weekly')
        .select('week, model, brand_name, category_name, region_code, mentions_count, citations_count, prompt_count')
        .eq('site_id', siteId);

      if (shouldApplyFilter(params.startDate)) q = q.gte('week', params.startDate);
      if (shouldApplyFilter(params.endDate)) q = q.lte('week', params.endDate);
      if (shouldApplyFilter(params.model)) q = q.eq('model', params.model);
      if (shouldApplyFilter(params.category)) q = q.eq('category_name', params.category);
      if (shouldApplyFilter(params.region)) q = q.eq('region_code', params.region);

      const { data, error } = await q.order('week', { ascending: true }).limit(500);

      if (error) return badRequest(error.message);

      return ok(data || []);
    });
    return result;
  };

  const getTopics = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const params = parseQueryParams(ctx);

      const orderCol = params.sortBy || 'topics';
      const orderAsc = (params.sortOrder || 'asc').toLowerCase() !== 'desc';
      const offset = params.page * params.pageSize;
      const limit = params.pageSize;

      let q = client
        .from('brand_presence_topics_by_date')
        .select('*')
        .eq('site_id', siteId);

      if (shouldApplyFilter(params.startDate)) q = q.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) q = q.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) q = q.eq('model', params.model);
      if (shouldApplyFilter(params.category)) q = q.eq('category_name', params.category);
      if (shouldApplyFilter(params.topic)) q = q.eq('topics', params.topic);
      if (shouldApplyFilter(params.region)) q = q.eq('region_code', params.region);
      if (shouldApplyFilter(params.origin)) q = q.eq('origin', params.origin);

      const { data, error } = await q
        .order(orderCol, { ascending: orderAsc })
        .range(offset, offset + limit - 1);

      if (error) return badRequest(error.message);

      return ok(data || []);
    });
    return result;
  };

  const getTopicPrompts = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId, topic } = ctx.params;
      const params = parseQueryParams(ctx);

      const orderCol = params.sortBy || 'prompt';
      const orderAsc = (params.sortOrder || 'asc').toLowerCase() !== 'desc';

      let q = client
        .from('brand_presence_prompts_by_date')
        .select('*')
        .eq('site_id', siteId)
        .eq('topics', decodeURIComponent(topic));

      if (shouldApplyFilter(params.startDate)) q = q.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) q = q.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) q = q.eq('model', params.model);
      if (shouldApplyFilter(params.category)) q = q.eq('category_name', params.category);
      if (shouldApplyFilter(params.region)) q = q.eq('region_code', params.region);
      if (shouldApplyFilter(params.origin)) q = q.eq('origin', params.origin);

      const { data, error } = await q.order(orderCol, { ascending: orderAsc }).limit(500);

      if (error) return badRequest(error.message);

      return ok(data || []);
    });
    return result;
  };

  const getSearch = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const params = parseQueryParams(ctx);
      const searchTerm = (params.q || '').trim();

      if (searchTerm.length < 2) {
        return badRequest('Search query must be at least 2 characters');
      }

      const limit = params.pageSize;

      let topicsQ = client
        .from('brand_presence_topics_by_date')
        .select('topics, category_name, region_code, origin, executions_count, mentions_count')
        .eq('site_id', siteId)
        .ilike('topics', `%${searchTerm}%`);

      if (shouldApplyFilter(params.startDate)) topicsQ = topicsQ.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) topicsQ = topicsQ.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) topicsQ = topicsQ.eq('model', params.model);
      if (shouldApplyFilter(params.category)) topicsQ = topicsQ.eq('category_name', params.category);
      if (shouldApplyFilter(params.region)) topicsQ = topicsQ.eq('region_code', params.region);
      if (shouldApplyFilter(params.origin)) topicsQ = topicsQ.eq('origin', params.origin);

      const { data: topicsData, error: topicsError } = await topicsQ.limit(limit);

      if (topicsError) return badRequest(topicsError.message);

      let promptsQ = client
        .from('brand_presence_prompts_by_date')
        .select('prompt, category_name, region_code, origin')
        .eq('site_id', siteId)
        .ilike('prompt', `%${searchTerm}%`);

      if (shouldApplyFilter(params.startDate)) promptsQ = promptsQ.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) promptsQ = promptsQ.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) promptsQ = promptsQ.eq('model', params.model);
      if (shouldApplyFilter(params.category)) promptsQ = promptsQ.eq('category_name', params.category);
      if (shouldApplyFilter(params.region)) promptsQ = promptsQ.eq('region_code', params.region);
      if (shouldApplyFilter(params.origin)) promptsQ = promptsQ.eq('origin', params.origin);

      const { data: promptsData, error: promptsError } = await promptsQ.limit(limit);

      if (promptsError) return badRequest(promptsError.message);

      const topicResults = (topicsData || []).map((r) => ({
        match_type: 'topic',
        matched: r.topics,
        category_name: r.category_name,
        region_code: r.region_code,
        origin: r.origin,
        executions_count: r.executions_count,
        mentions_count: r.mentions_count,
      }));
      const promptResults = (promptsData || []).map((r) => ({
        match_type: 'prompt',
        matched: r.prompt,
        category_name: r.category_name,
        region_code: r.region_code,
        origin: r.origin,
      }));

      const combined = [...topicResults, ...promptResults].slice(0, limit);
      return ok(combined);
    });
    return result;
  };

  const getShareOfVoice = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const params = parseQueryParams(ctx);

      let q = client
        .from('executions_competitor_data')
        .select('*')
        .eq('site_id', siteId);

      if (shouldApplyFilter(params.startDate)) q = q.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) q = q.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) q = q.eq('model', params.model);
      if (shouldApplyFilter(params.category)) q = q.eq('category_name', params.category);
      if (shouldApplyFilter(params.region)) q = q.eq('region_code', params.region);

      const { data, error } = await q.limit(1000);

      if (error) return badRequest(error.message);

      return ok(data || []);
    });
    return result;
  };

  const getCompetitorTrends = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const params = parseQueryParams(ctx);

      let q = client
        .from('executions_competitor_data')
        .select('*')
        .eq('site_id', siteId);

      if (shouldApplyFilter(params.startDate)) q = q.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) q = q.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) q = q.eq('model', params.model);
      if (shouldApplyFilter(params.category)) q = q.eq('category_name', params.category);
      if (shouldApplyFilter(params.region)) q = q.eq('region_code', params.region);

      const { data, error } = await q.order('execution_date', { ascending: true }).limit(2000);

      if (error) return badRequest(error.message);

      return ok(data || []);
    });
    return result;
  };

  const getPrompts = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const params = parseQueryParams(ctx);

      const offset = params.page * params.pageSize;
      const limit = params.pageSize;

      let q = client
        .from('brand_presence_prompts_by_date')
        .select('*')
        .eq('site_id', siteId);

      if (shouldApplyFilter(params.startDate)) q = q.gte('execution_date', params.startDate);
      if (shouldApplyFilter(params.endDate)) q = q.lte('execution_date', params.endDate);
      if (shouldApplyFilter(params.model)) q = q.eq('model', params.model);
      if (shouldApplyFilter(params.category)) q = q.eq('category_name', params.category);
      if (shouldApplyFilter(params.topic)) q = q.eq('topics', params.topic);
      if (shouldApplyFilter(params.region)) q = q.eq('region_code', params.region);
      if (shouldApplyFilter(params.origin)) q = q.eq('origin', params.origin);

      const { data, error } = await q
        .order('topics', { ascending: true })
        .order('prompt', { ascending: true })
        .range(offset, offset + limit - 1);

      if (error) return badRequest(error.message);

      return ok(data || []);
    });
    return result;
  };

  const getSources = async (context) => {
    const result = await runWithPostgrest(context, async (ctx, client) => {
      const { siteId } = ctx.params;
      const q = ctx.data || {};
      const executionId = q.executionId || q.execution_id;

      if (shouldApplyFilter(executionId)) {
        const { data, error } = await client
          .from('brand_presence_sources')
          .select('*')
          .eq('execution_id', executionId);

        if (error) return badRequest(error.message);
        return ok(data || []);
      }

      const { data: execs } = await client
        .from('brand_presence_executions')
        .select('id')
        .eq('site_id', siteId);

      if (!execs?.length) return ok([]);

      const execIds = execs.map((e) => e.id).slice(0, 100);
      const { data, error } = await client
        .from('brand_presence_sources')
        .select('*')
        .in('execution_id', execIds);

      if (error) return badRequest(error.message);
      return ok(data || []);
    });
    return result;
  };

  return {
    getFilterDimensions,
    getWeeks,
    getMetadata,
    getStats,
    getSentimentOverview,
    getWeeklyTrends,
    getTopics,
    getTopicPrompts,
    getSearch,
    getShareOfVoice,
    getCompetitorTrends,
    getPrompts,
    getSources,
  };
}
