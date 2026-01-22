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

import {
  createResponse,
  badRequest,
  notFound,
  ok,
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isValidUUID,
  isNonEmptyObject,
  isArray,
  isInteger,
} from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';
import { SentimentTopicDto } from '../dto/sentiment-topic.js';
import { SentimentGuidelineDto } from '../dto/sentiment-guideline.js';

const MAX_ITEMS_PER_REQUEST = 100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// Known audit types that can be assigned to topics
const KNOWN_AUDIT_TYPES = [
  'wikipedia-analysis',
  'reddit-analysis',
  'youtube-analysis',
  'twitter-analysis',
  'accessibility',
  'broken-backlinks',
  'cwv',
  'lhs-mobile',
  'lhs-desktop',
];

/**
 * Validates audit types against known audit types.
 * @param {string[]} audits - Array of audit type strings.
 * @returns {string[]} - Array of invalid audit types.
 */
function validateAuditTypes(audits) {
  if (!isArray(audits)) return [];
  return audits.filter((audit) => !KNOWN_AUDIT_TYPES.includes(audit));
}

/**
 * Sentiment controller for managing sentiment topics and guidelines.
 * @param {object} ctx - Context of the request.
 * @param {object} log - Logger instance.
 * @returns {object} Sentiment controller.
 * @constructor
 */
function SentimentController(ctx, log) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site, SentimentTopic, SentimentGuideline } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Get the authenticated user identifier from the context.
   * @param {object} context - Request context
   * @returns {string} - User identifier
   */
  function getUserIdentifier(context) {
    const authInfo = context.attributes?.authInfo;
    if (authInfo) {
      const profile = authInfo.getProfile();
      return profile?.email || profile?.name || 'system';
    }
    return 'system';
  }

  // ==================== TOPIC ENDPOINTS ====================

  /**
   * List all topics for a site with pagination.
   * GET /sites/{siteId}/sentiment/topics
   */
  const listTopics = async (context) => {
    const { siteId } = context.params;
    const {
      limit = DEFAULT_LIMIT,
      cursor,
      audit, // Optional filter by audit type
      enabled, // Optional filter by enabled status
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const parsedLimit = parseInt(limit, 10);
    if (!isInteger(parsedLimit) || parsedLimit < 1) {
      return badRequest('Limit must be a positive integer');
    }
    const effectiveLimit = Math.min(parsedLimit, MAX_LIMIT);

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view topics');
    }

    try {
      let result;

      if (hasText(audit)) {
        // Filter by audit type
        result = await SentimentTopic.allBySiteIdAndAuditType(siteId, audit, {
          limit: effectiveLimit,
          cursor,
        });
      } else if (enabled === 'true' || enabled === true) {
        // Filter by enabled
        result = await SentimentTopic.allBySiteIdEnabled(siteId, {
          limit: effectiveLimit,
          cursor,
        });
      } else {
        // Get all topics
        result = await SentimentTopic.allBySiteIdPaginated(siteId, {
          limit: effectiveLimit,
          cursor,
        });
      }

      return ok({
        items: (result.data || []).map(SentimentTopicDto.toJSON),
        pagination: {
          limit: effectiveLimit,
          cursor: result.cursor ?? null,
          hasMore: !!result.cursor,
        },
      });
    } catch (error) {
      log.error(`Error listing topics for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to list topics');
    }
  };

  /**
   * Get a specific topic by ID.
   * GET /sites/{siteId}/sentiment/topics/{topicId}
   */
  const getTopic = async (context) => {
    const { siteId, topicId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(topicId)) {
      return badRequest('Topic ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view topics');
    }

    try {
      const topic = await SentimentTopic.findById(siteId, topicId);

      if (!topic) {
        return notFound('Topic not found');
      }

      return ok(SentimentTopicDto.toJSON(topic));
    } catch (error) {
      log.error(`Error getting topic ${topicId} for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to get topic');
    }
  };

  /**
   * Create topics in bulk.
   * POST /sites/{siteId}/sentiment/topics
   */
  const createTopics = async (context) => {
    const { siteId } = context.params;
    const topics = context.data;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isArray(topics) || topics.length === 0) {
      return badRequest('Topics array required');
    }

    if (topics.length > MAX_ITEMS_PER_REQUEST) {
      return badRequest(`Maximum ${MAX_ITEMS_PER_REQUEST} topics per request`);
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can create topics');
    }

    const userId = getUserIdentifier(context);

    const processingPromises = topics.map(async (topicData) => {
      // Validate name
      if (!hasText(topicData.name)) {
        return {
          success: false,
          name: topicData.name || 'undefined',
          reason: 'Name is required',
        };
      }

      // Validate audit types if provided
      if (topicData.audits) {
        const invalidAudits = validateAuditTypes(topicData.audits);
        if (invalidAudits.length > 0) {
          return {
            success: false,
            name: topicData.name,
            reason: `Invalid audit types: ${invalidAudits.join(', ')}. Valid types: ${KNOWN_AUDIT_TYPES.join(', ')}`,
          };
        }
      }

      try {
        const newTopic = await SentimentTopic.create({
          siteId,
          name: topicData.name,
          description: topicData.description,
          topicName: topicData.topicName || '',
          subPrompts: isArray(topicData.subPrompts) ? topicData.subPrompts : [],
          audits: isArray(topicData.audits) ? topicData.audits : [],
          enabled: topicData.enabled !== false,
          createdBy: userId,
          updatedBy: userId,
        });
        return { success: true, data: newTopic };
      } catch (error) {
        log.error(`Error creating topic ${topicData.name}: ${error.message}`);
        return {
          success: false,
          name: topicData.name,
          reason: error.message,
        };
      }
    });

    const processedResults = await Promise.all(processingPromises);

    const results = [];
    const failures = [];
    let successCount = 0;

    processedResults.forEach((result) => {
      if (result.success) {
        results.push(SentimentTopicDto.toJSON(result.data));
        successCount += 1;
      } else {
        failures.push({ name: result.name, reason: result.reason });
      }
    });

    return createResponse({
      metadata: {
        total: topics.length,
        success: successCount,
        failure: failures.length,
      },
      failures,
      items: results,
    }, 201);
  };

  /**
   * Update a topic.
   * PATCH /sites/{siteId}/sentiment/topics/{topicId}
   */
  const updateTopic = async (context) => {
    const { siteId, topicId } = context.params;
    const updates = context.data;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(topicId)) {
      return badRequest('Topic ID required');
    }

    if (!isNonEmptyObject(updates)) {
      return badRequest('Update data required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can update topics');
    }

    // Validate audit types if provided
    if (updates.audits) {
      const invalidAudits = validateAuditTypes(updates.audits);
      if (invalidAudits.length > 0) {
        return badRequest(`Invalid audit types: ${invalidAudits.join(', ')}. Valid types: ${KNOWN_AUDIT_TYPES.join(', ')}`);
      }
    }

    const userId = getUserIdentifier(context);

    try {
      let topic = await SentimentTopic.findById(siteId, topicId);

      if (!topic) {
        return notFound('Topic not found');
      }

      // Update allowed fields
      if (hasText(updates.name)) topic.setName(updates.name);
      if (updates.description !== undefined) topic.setDescription(updates.description);
      if (hasText(updates.topicName)) topic.setTopicName(updates.topicName);
      if (isArray(updates.subPrompts)) topic.setSubPrompts(updates.subPrompts);
      if (isArray(updates.audits)) topic.setAudits(updates.audits);
      if (typeof updates.enabled === 'boolean') topic.setEnabled(updates.enabled);

      topic.setUpdatedBy(userId);
      topic = await topic.save();

      return ok(SentimentTopicDto.toJSON(topic));
    } catch (error) {
      log.error(`Error updating topic ${topicId}: ${error.message}`);
      return internalServerError('Failed to update topic');
    }
  };

  /**
   * Delete a topic.
   * DELETE /sites/{siteId}/sentiment/topics/{topicId}
   */
  const deleteTopic = async (context) => {
    const { siteId, topicId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(topicId)) {
      return badRequest('Topic ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can delete topics');
    }

    try {
      const topic = await SentimentTopic.findById(siteId, topicId);

      if (!topic) {
        return notFound('Topic not found');
      }

      await topic.remove();

      return ok({ message: 'Topic deleted successfully' });
    } catch (error) {
      log.error(`Error deleting topic ${topicId}: ${error.message}`);
      return internalServerError('Failed to delete topic');
    }
  };

  /**
   * Add sub-prompts to a topic.
   * POST /sites/{siteId}/sentiment/topics/{topicId}/prompts
   */
  const addSubPrompts = async (context) => {
    const { siteId, topicId } = context.params;
    const { prompts } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(topicId)) {
      return badRequest('Topic ID required');
    }

    if (!isArray(prompts) || prompts.length === 0) {
      return badRequest('Prompts array required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can modify topics');
    }

    const userId = getUserIdentifier(context);

    try {
      let topic = await SentimentTopic.findById(siteId, topicId);

      if (!topic) {
        return notFound('Topic not found');
      }

      // Add prompts
      prompts.forEach((prompt) => {
        if (hasText(prompt)) {
          topic.addSubPrompt(prompt);
        }
      });

      topic.setUpdatedBy(userId);
      topic = await topic.save();

      return ok(SentimentTopicDto.toJSON(topic));
    } catch (error) {
      log.error(`Error adding prompts to topic ${topicId}: ${error.message}`);
      return internalServerError('Failed to add prompts');
    }
  };

  /**
   * Remove sub-prompts from a topic.
   * DELETE /sites/{siteId}/sentiment/topics/{topicId}/prompts
   */
  const removeSubPrompts = async (context) => {
    const { siteId, topicId } = context.params;
    const { prompts } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(topicId)) {
      return badRequest('Topic ID required');
    }

    if (!isArray(prompts) || prompts.length === 0) {
      return badRequest('Prompts array required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can modify topics');
    }

    const userId = getUserIdentifier(context);

    try {
      let topic = await SentimentTopic.findById(siteId, topicId);

      if (!topic) {
        return notFound('Topic not found');
      }

      // Remove prompts
      prompts.forEach((prompt) => {
        topic.removeSubPrompt(prompt);
      });

      topic.setUpdatedBy(userId);
      topic = await topic.save();

      return ok(SentimentTopicDto.toJSON(topic));
    } catch (error) {
      log.error(`Error removing prompts from topic ${topicId}: ${error.message}`);
      return internalServerError('Failed to remove prompts');
    }
  };

  /**
   * Link audits to a topic.
   * POST /sites/{siteId}/sentiment/topics/{topicId}/audits
   */
  const linkAudits = async (context) => {
    const { siteId, topicId } = context.params;
    const { audits } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(topicId)) {
      return badRequest('Topic ID required');
    }

    if (!isArray(audits) || audits.length === 0) {
      return badRequest('Audits array required');
    }

    // Validate audit types
    const invalidAudits = validateAuditTypes(audits);
    if (invalidAudits.length > 0) {
      return badRequest(`Invalid audit types: ${invalidAudits.join(', ')}. Valid types: ${KNOWN_AUDIT_TYPES.join(', ')}`);
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can modify topics');
    }

    const userId = getUserIdentifier(context);

    try {
      let topic = await SentimentTopic.findById(siteId, topicId);

      if (!topic) {
        return notFound('Topic not found');
      }

      // Link audits
      audits.forEach((audit) => {
        if (hasText(audit)) {
          topic.enableAudit(audit);
        }
      });

      topic.setUpdatedBy(userId);
      topic = await topic.save();

      return ok(SentimentTopicDto.toJSON(topic));
    } catch (error) {
      log.error(`Error linking audits to topic ${topicId}: ${error.message}`);
      return internalServerError('Failed to link audits');
    }
  };

  /**
   * Unlink audits from a topic.
   * DELETE /sites/{siteId}/sentiment/topics/{topicId}/audits
   */
  const unlinkAudits = async (context) => {
    const { siteId, topicId } = context.params;
    const { audits } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(topicId)) {
      return badRequest('Topic ID required');
    }

    if (!isArray(audits) || audits.length === 0) {
      return badRequest('Audits array required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can modify topics');
    }

    const userId = getUserIdentifier(context);

    try {
      let topic = await SentimentTopic.findById(siteId, topicId);

      if (!topic) {
        return notFound('Topic not found');
      }

      // Unlink audits
      audits.forEach((audit) => {
        topic.disableAudit(audit);
      });

      topic.setUpdatedBy(userId);
      topic = await topic.save();

      return ok(SentimentTopicDto.toJSON(topic));
    } catch (error) {
      log.error(`Error unlinking audits from topic ${topicId}: ${error.message}`);
      return internalServerError('Failed to unlink audits');
    }
  };

  // ==================== GUIDELINE ENDPOINTS ====================

  /**
   * List all guidelines for a site with pagination.
   * GET /sites/{siteId}/sentiment/guidelines
   */
  const listGuidelines = async (context) => {
    const { siteId } = context.params;
    const {
      limit = DEFAULT_LIMIT,
      cursor,
      enabled, // Optional filter by enabled status
    } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const parsedLimit = parseInt(limit, 10);
    if (!isInteger(parsedLimit) || parsedLimit < 1) {
      return badRequest('Limit must be a positive integer');
    }
    const effectiveLimit = Math.min(parsedLimit, MAX_LIMIT);

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view guidelines');
    }

    try {
      let result;

      if (enabled === 'true' || enabled === true) {
        // Filter by enabled
        result = await SentimentGuideline.allBySiteIdEnabled(siteId, {
          limit: effectiveLimit,
          cursor,
        });
      } else {
        // Get all guidelines
        result = await SentimentGuideline.allBySiteIdPaginated(siteId, {
          limit: effectiveLimit,
          cursor,
        });
      }

      return ok({
        items: (result.data || []).map(SentimentGuidelineDto.toJSON),
        pagination: {
          limit: effectiveLimit,
          cursor: result.cursor ?? null,
          hasMore: !!result.cursor,
        },
      });
    } catch (error) {
      log.error(`Error listing guidelines for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to list guidelines');
    }
  };

  /**
   * Get a specific guideline by ID.
   * GET /sites/{siteId}/sentiment/guidelines/{guidelineId}
   */
  const getGuideline = async (context) => {
    const { siteId, guidelineId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(guidelineId)) {
      return badRequest('Guideline ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view guidelines');
    }

    try {
      const guideline = await SentimentGuideline.findById(siteId, guidelineId);

      if (!guideline) {
        return notFound('Guideline not found');
      }

      return ok(SentimentGuidelineDto.toJSON(guideline));
    } catch (error) {
      log.error(`Error getting guideline ${guidelineId} for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to get guideline');
    }
  };

  /**
   * Create guidelines in bulk.
   * POST /sites/{siteId}/sentiment/guidelines
   */
  const createGuidelines = async (context) => {
    const { siteId } = context.params;
    const guidelines = context.data;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!isArray(guidelines) || guidelines.length === 0) {
      return badRequest('Guidelines array required');
    }

    if (guidelines.length > MAX_ITEMS_PER_REQUEST) {
      return badRequest(`Maximum ${MAX_ITEMS_PER_REQUEST} guidelines per request`);
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can create guidelines');
    }

    const userId = getUserIdentifier(context);

    const processingPromises = guidelines.map(async (guidelineData) => {
      // Validate name
      if (!hasText(guidelineData.name)) {
        return {
          success: false,
          name: guidelineData.name || 'undefined',
          reason: 'Name is required',
        };
      }

      // Validate instruction
      if (!hasText(guidelineData.instruction)) {
        return {
          success: false,
          name: guidelineData.name,
          reason: 'Instruction is required',
        };
      }

      try {
        const newGuideline = await SentimentGuideline.create({
          siteId,
          name: guidelineData.name,
          instruction: guidelineData.instruction,
          enabled: guidelineData.enabled !== false,
          createdBy: userId,
          updatedBy: userId,
        });
        return { success: true, data: newGuideline };
      } catch (error) {
        log.error(`Error creating guideline ${guidelineData.name}: ${error.message}`);
        return {
          success: false,
          name: guidelineData.name,
          reason: error.message,
        };
      }
    });

    const processedResults = await Promise.all(processingPromises);

    const results = [];
    const failures = [];
    let successCount = 0;

    processedResults.forEach((result) => {
      if (result.success) {
        results.push(SentimentGuidelineDto.toJSON(result.data));
        successCount += 1;
      } else {
        failures.push({ name: result.name, reason: result.reason });
      }
    });

    return createResponse({
      metadata: {
        total: guidelines.length,
        success: successCount,
        failure: failures.length,
      },
      failures,
      items: results,
    }, 201);
  };

  /**
   * Update a guideline.
   * PATCH /sites/{siteId}/sentiment/guidelines/{guidelineId}
   */
  const updateGuideline = async (context) => {
    const { siteId, guidelineId } = context.params;
    const updates = context.data;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(guidelineId)) {
      return badRequest('Guideline ID required');
    }

    if (!isNonEmptyObject(updates)) {
      return badRequest('Update data required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can update guidelines');
    }

    const userId = getUserIdentifier(context);

    try {
      let guideline = await SentimentGuideline.findById(siteId, guidelineId);

      if (!guideline) {
        return notFound('Guideline not found');
      }

      // Update allowed fields
      if (hasText(updates.name)) guideline.setName(updates.name);
      if (hasText(updates.instruction)) guideline.setInstruction(updates.instruction);
      if (typeof updates.enabled === 'boolean') guideline.setEnabled(updates.enabled);

      guideline.setUpdatedBy(userId);
      guideline = await guideline.save();

      return ok(SentimentGuidelineDto.toJSON(guideline));
    } catch (error) {
      log.error(`Error updating guideline ${guidelineId}: ${error.message}`);
      return internalServerError('Failed to update guideline');
    }
  };

  /**
   * Delete a guideline.
   * DELETE /sites/{siteId}/sentiment/guidelines/{guidelineId}
   */
  const deleteGuideline = async (context) => {
    const { siteId, guidelineId } = context.params;

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    if (!hasText(guidelineId)) {
      return badRequest('Guideline ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can delete guidelines');
    }

    try {
      const guideline = await SentimentGuideline.findById(siteId, guidelineId);

      if (!guideline) {
        return notFound('Guideline not found');
      }

      await guideline.remove();

      return ok({ message: 'Guideline deleted successfully' });
    } catch (error) {
      log.error(`Error deleting guideline ${guidelineId}: ${error.message}`);
      return internalServerError('Failed to delete guideline');
    }
  };

  // ==================== COMBINED CONFIG ENDPOINT ====================

  /**
   * Get full sentiment config (topics and guidelines independently).
   * GET /sites/{siteId}/sentiment/config
   */
  const getConfig = async (context) => {
    const { siteId } = context.params;
    const { audit } = context.data || {};

    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const site = await Site.findById(siteId);
    if (!site) {
      return notFound('Site not found');
    }

    if (!await accessControlUtil.hasAccess(site)) {
      return forbidden('Only users belonging to the organization can view config');
    }

    try {
      // Get topics (optionally filtered by audit)
      let topicsResult;
      if (hasText(audit)) {
        topicsResult = await SentimentTopic.allBySiteIdAndAuditType(siteId, audit, {});
      } else {
        topicsResult = await SentimentTopic.allBySiteIdEnabled(siteId, {});
      }

      // Get all enabled guidelines (independent of topics)
      const guidelinesResult = await SentimentGuideline.allBySiteIdEnabled(siteId, {});

      return ok({
        topics: (topicsResult.data || []).map(SentimentTopicDto.toJSON),
        guidelines: (guidelinesResult.data || []).map(SentimentGuidelineDto.toJSON),
      });
    } catch (error) {
      log.error(`Error getting config for site ${siteId}: ${error.message}`);
      return internalServerError('Failed to get config');
    }
  };

  return {
    // Topics
    listTopics,
    getTopic,
    createTopics,
    updateTopic,
    deleteTopic,
    addSubPrompts,
    removeSubPrompts,
    linkAudits,
    unlinkAudits,
    // Guidelines
    listGuidelines,
    getGuideline,
    createGuidelines,
    updateGuideline,
    deleteGuideline,
    // Combined
    getConfig,
  };
}

export default SentimentController;
