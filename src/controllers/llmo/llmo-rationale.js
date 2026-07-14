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
  badRequest, notFound,
} from '@adobe/spacecat-shared-http-utils';
import { cachedOk } from '../../support/cached-response.js';

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
 * Reads popularity reasoning from the topics table (mysticat PostgreSQL via
 * PostgREST), replacing the decommissioned Mystique S3 cache.
 *
 * @param {object} context - The request context containing log, dataAccess, and params
 * @returns {Promise<Response>} The rationale response
 */
export async function handleLlmoRationale(context) {
  const { log, dataAccess } = context;
  const { siteId } = context.params;

  // Extract query parameters (category/region/origin accepted for backwards
  // compatibility but not applied — see note below).
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

  const site = await Site.findById(siteId);
  if (!site) {
    return notFound(`Site not found: ${siteId}`);
  }
  const organizationId = site.getOrganizationId();

  log.info(`Getting LLMO rationale for site ${siteId} (org ${organizationId}) - topic: ${topic}, popularity: ${popularity || 'all'}`);

  // Popularity reasoning now lives on the topics table (topics.popularity_reasoning /
  // topics.popularity_volume), filled by the DRS brand-presence import + backfill. This
  // replaces the decommissioned Mystique S3 cache this endpoint used to read. `topics`
  // is org-scoped with no category/region column, so we match on topic name only —
  // category/region query params are intentionally not applied here.
  const { data, error } = await client
    .from('topics')
    .select('name,popularity_volume,popularity_reasoning,updated_at')
    .eq('organization_id', organizationId);

  if (error) {
    log.error(`LLMO rationale PostgREST error for site ${siteId}: ${error.message}`);
    return badRequest(`Error retrieving rationale: ${error.message}`);
  }

  const topics = (data || [])
    .filter((row) => row.popularity_reasoning)
    .map((row) => ({
      topic: row.name,
      reasoning: row.popularity_reasoning,
      popularity: volumeToPopularity(row.popularity_volume),
      volume: row.popularity_volume,
      added_date: row.updated_at,
    }));

  // Only topic (mandatory) + popularity are applied; topics has no category/region/origin.
  const filteredTopics = filterTopics(topics, { topic, popularity });

  log.info(`Filtered ${topics.length} topics down to ${filteredTopics.length} results`);

  return cachedOk(filteredTopics);
}
