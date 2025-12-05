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
  ok, badRequest, notFound,
} from '@adobe/spacecat-shared-http-utils';

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

/**
 * Handles the LLMO rationale retrieval logic after site validation.
 * This function contains all the logic that comes after getSiteAndValidateLlmo().
 *
 * @param {object} context - The request context containing log, s3, env, and params
 * @returns {Promise<Response>} The rationale response
 */
export async function handleLlmoRationale(context) {
  const { log, s3, env } = context;
  const { siteId } = context.params;

  // Extract query parameters
  const {
    topic, category, region, origin, popularity,
  } = context.data;

  // Validate mandatory parameters
  if (!topic) {
    return badRequest('topic parameter is required');
  }

  if (!s3 || !s3.s3Client) {
    return badRequest('S3 storage is not configured for this environment');
  }

  log.info(`Getting LLMO rationale for site ${siteId} with filters - topic: ${topic}, category: ${category || 'all'}, region: ${region || 'all'}, origin: ${origin || 'all'}, popularity: ${popularity || 'all'}`);

  // Construct the S3 key for the topics popularity reasoning cache file
  const bucketName = `spacecat-${env.ENV}-mystique-assets`;
  const s3Key = `llm_cache/${siteId}/prompts/topics_popularity_reasoning_cache.json`;

  try {
    // Fetch the file from S3
    const { GetObjectCommand } = s3;
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const response = await s3.s3Client.send(command);
    const fileContent = await response.Body.transformToString();

    // Parse the JSON content
    const jsonData = JSON.parse(fileContent);

    // Extract topics array from the JSON data
    const topics = jsonData.topics || [];

    // Apply filtering based on query parameters
    const filteredTopics = filterTopics(topics, {
      topic, category, region, origin, popularity,
    });

    log.info(`Filtered ${topics.length} topics down to ${filteredTopics.length} results`);

    return ok(filteredTopics);
  } catch (s3Error) {
    if (s3Error.name === 'NoSuchKey') {
      log.warn(`LLMO rationale file not found for site ${siteId} at ${s3Key}`);
      return notFound(`Rationale file not found for site ${siteId}`);
    }
    if (s3Error.name === 'NoSuchBucket') {
      log.error(`S3 bucket ${bucketName} not found`);
      return badRequest(`Storage bucket not found: ${bucketName}`);
    }
    if (s3Error instanceof SyntaxError) {
      log.error(`Invalid JSON in rationale file for site ${siteId}: ${s3Error.message}`);
      return badRequest('Invalid JSON format in rationale file');
    }

    log.error(`S3 error retrieving rationale for site ${siteId}: ${s3Error.message}`);
    return badRequest(`Error retrieving rationale: ${s3Error.message}`);
  }
}
