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

import {
  badRequest, notFound, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { cachedOk } from '../../support/cached-response.js';

// Max topic rows returned from the DB path (defense-in-depth against an
// unexpectedly broad match; a single topic name maps to far fewer rows).
const MAX_TOPIC_ROWS = 1000;

/**
 * Escapes LIKE/ILIKE metacharacters (`%`, `_`, `\`) in user input so a topic
 * containing them matches literally instead of acting as a wildcard.
 * @param {string} value
 * @returns {string}
 */
function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Filters topics based on provided query parameters.
 * @param {Array} topics - Array of topic objects to filter
 * @param {object} filters - Filter parameters (topic, category, region, origin, popularity)
 * @returns {Array} Filtered array of topics
 */
function filterTopics(topics, filters) {
  const {
    topic, category, region, origin, popularity,
  } = filters;

  return topics.filter((topicObj) => {
    // Mandatory filter - must match (case-insensitive partial match)
    if (topic && !topicObj.topic?.toLowerCase().includes(topic.toLowerCase())) {
      return false;
    }

    // Optional filters - only apply if provided
    if (category && !topicObj.category?.toLowerCase().includes(category.toLowerCase())) {
      return false;
    }

    if (region && !topicObj.region?.toLowerCase().includes(region.toLowerCase())) {
      return false;
    }

    if (origin && !topicObj.origin?.toLowerCase().includes(origin.toLowerCase())) {
      return false;
    }

    if (popularity && !topicObj.popularity?.toLowerCase().includes(popularity.toLowerCase())) {
      return false;
    }

    return true;
  });
}

// LLM-estimated volume encoding → popularity label (see DRS popularity estimator).
const VOLUME_TO_POPULARITY = { '-30': 'High', '-20': 'Medium', '-10': 'Low' };

/**
 * Maps the LLM-estimated volume encoding to a popularity label.
 * @param {number} volume - -30 High, -20 Medium, -10 Low.
 * @returns {string} High | Medium | Low | N/A
 */
function volumeToPopularity(volume) {
  return VOLUME_TO_POPULARITY[String(volume)] || 'N/A';
}

/**
 * Handles the LLMO rationale retrieval logic after site validation.
 *
 * Reads popularity reasoning from the topics table (`popularity_volume` /
 * `popularity_reasoning`, filled by the DRS brand-presence import + backfill),
 * replacing the decommissioned Mystique S3 cache this endpoint used to read.
 *
 * @param {object} context - Request context (log, dataAccess, params, data)
 * @param {object} [site] - Site resolved by getSiteAndValidateLlmo (avoids a re-lookup)
 * @returns {Promise<Response>} The rationale response
 */
export async function handleLlmoRationale(context, site) {
  const { log, dataAccess } = context;
  const { siteId } = context.params;

  // category/region/origin are accepted for backwards compatibility but not
  // applied — topics is org-scoped with no such columns.
  const { topic, popularity } = context.data;

  // Validate mandatory parameters
  if (!topic) {
    return badRequest('topic parameter is required');
  }

  const { Site } = dataAccess;
  if (!Site?.postgrestService) {
    log.error('LLMO rationale requires PostgREST (DATA_SERVICE_PROVIDER=postgres)');
    return badRequest('Rationale data is not available. PostgreSQL data service is required.');
  }
  const client = Site.postgrestService;

  // Reuse the site resolved by getSiteAndValidateLlmo when provided (avoids a
  // second Site.findById round-trip); fall back to a lookup for standalone callers.
  const resolvedSite = site ?? await Site.findById(siteId);
  if (!resolvedSite) {
    return notFound(`Site not found: ${siteId}`);
  }
  const organizationId = resolvedSite.getOrganizationId();
  if (!organizationId) {
    log.error(`LLMO rationale: site ${siteId} has no organizationId`);
    return badRequest('Site is not associated with an organization');
  }

  log.info(`Getting LLMO rationale for site ${siteId} (org ${organizationId}) - topic: ${topic}, popularity: ${popularity || 'all'}`);

  // `topics` is org-scoped with no category/region column, so we match on topic
  // name — filtered server-side via ILIKE (case-insensitive substring) to keep
  // the result set bounded, and require a non-null rationale. LIKE metacharacters
  // in the user-supplied topic are escaped so they match literally, and an
  // explicit limit guards against an unexpectedly broad match.
  const { data, error } = await client
    .from('topics')
    .select('name,popularity_volume,popularity_reasoning,updated_at')
    .eq('organization_id', organizationId)
    .not('popularity_reasoning', 'is', null)
    .ilike('name', `%${escapeLikePattern(topic)}%`)
    .limit(MAX_TOPIC_ROWS);

  if (error) {
    // Server-side failure (not the client's fault) → 500; keep PostgREST detail
    // server-side only (avoid leaking schema names to the client).
    log.error(`LLMO rationale PostgREST error for site ${siteId}: ${error.message}`);
    return internalServerError('Error retrieving rationale');
  }

  const topics = (data || []).map((row) => ({
    topic: row.name,
    reasoning: row.popularity_reasoning,
    popularity: volumeToPopularity(row.popularity_volume),
    volume: row.popularity_volume,
    added_date: row.updated_at,
  }));

  // topic is filtered server-side; apply the optional popularity filter here
  // (it's derived from volume, so not expressible as a column predicate).
  const filteredTopics = filterTopics(topics, { popularity });

  log.info(`Filtered ${topics.length} topics down to ${filteredTopics.length} results`);

  return cachedOk(filteredTopics);
}
