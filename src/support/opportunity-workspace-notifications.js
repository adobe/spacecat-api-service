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

import { isValidEmail } from '@adobe/spacecat-shared-utils';
import { sendEmail } from './email-service.js';

/**
 * @typedef {Object} StatusChange
 * @property {string} type - 'opportunity', 'strategy', or 'assignment'
 * @property {string} strategyId
 * @property {string} strategyName
 * @property {string} [opportunityId]
 * @property {string} [opportunityName]
 * @property {string} statusBefore
 * @property {string} statusAfter
 * @property {string[]} recipients - deduplicated valid email addresses
 * @property {string} [createdBy] - strategy owner email (optional)
 * @property {string} [assignee] - opportunity assignee email (opportunity/assignment changes only)
 * @property {string[]} [opportunityNames] - opportunity names for strategy changes
 * @property {string} [assigneeBefore] - previous assignee (assignment changes only)
 * @property {string} [assigneeAfter] - new assignee (assignment changes only)
 */

/**
 * Resolves email to display name using TrialUser lookup.
 * Falls back to email if user not found or lookup fails.
 * @param {Object} dataAccess - Context dataAccess (with TrialUser).
 * @param {string} email - Email address to resolve.
 * @returns {Promise<string>} Display name or email.
 */
async function resolveUserName(dataAccess, email) {
  if (!dataAccess?.TrialUser) return email;
  try {
    const user = await dataAccess.TrialUser.findByEmailId(email);
    if (user) {
      const first = user.getFirstName();
      const last = user.getLastName();
      const cleanFirst = (first && first !== '-') ? first : '';
      const cleanLast = (last && last !== '-') ? last : '';
      const fullName = `${cleanFirst} ${cleanLast}`.trim();
      return fullName || email;
    }
  } catch { /* best-effort */ }
  return email;
}

/**
 * Extracts hostname from a base URL (e.g. https://www.chevrolet.com -> www.chevrolet.com).
 * @param {string} baseUrl - Full base URL.
 * @returns {string} Hostname or empty string.
 */
function extractHostnameFromBaseURL(baseUrl) {
  if (!baseUrl) return '';
  try {
    const url = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`);
    return url.hostname;
  } catch {
    return '';
  }
}

/**
 * Builds an index of strategy opportunities keyed by opportunityId for fast lookup.
 * @param {Object} strategyData - Parsed strategy workspace data.
 * @returns {Map<string, Map<string, Object>>}
 *   Map of strategyId -> Map of opportunityId -> opportunity object.
 */
function buildOpportunityIndex(strategyData) {
  const index = new Map();
  if (!strategyData?.strategies) return index;

  for (const strategy of strategyData.strategies) {
    const oppMap = new Map();
    for (const opp of strategy.opportunities || []) {
      oppMap.set(opp.opportunityId, opp);
    }
    index.set(strategy.id, oppMap);
  }
  return index;
}

/**
 * Builds an index of strategies keyed by id.
 * @param {Object} strategyData - Parsed strategy workspace data.
 * @returns {Map<string, Object>} Map of strategyId -> strategy object.
 */
function buildStrategyIndex(strategyData) {
  const index = new Map();
  if (!strategyData?.strategies) return index;
  for (const strategy of strategyData.strategies) {
    index.set(strategy.id, strategy);
  }
  return index;
}

/**
 * Filters and deduplicates an array of candidate email strings.
 * Logs a warning for each invalid email.
 * @param {string[]} candidates - Array of potential email strings.
 * @param {Object} log - Logger instance.
 * @returns {string[]} Array of valid, unique emails.
 */
function filterValidEmails(candidates, log) {
  const seen = new Set();
  const result = [];
  for (const email of candidates) {
    if (!email || typeof email !== 'string') {
      // Skip non-string or empty values
    } else if (!isValidEmail(email)) {
      log.warn(`Skipping invalid email recipient: ${email}`);
    } else {
      const lower = email.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(email);
      }
    }
  }
  return result;
}

/**
 * Detects status changes between previous and next strategy workspace data.
 * Returns an array of StatusChange objects describing what changed.
 *
 * @param {Object|null} prevData - Previous strategy workspace data (or null for first save).
 * @param {Object} nextData - New strategy workspace data being saved.
 * @param {Object} log - Logger instance.
 * @returns {StatusChange[]} Array of detected changes.
 */
export function detectStatusChanges(prevData, nextData, log) {
  const changes = [];
  if (!nextData) return changes;

  // Build name lookup from opportunity library
  const libraryOppNames = new Map();
  for (const opp of (nextData.opportunities || [])) {
    libraryOppNames.set(opp.id, opp.name);
  }

  // When prevData is null (first save), use empty structure as baseline
  const effectivePrevData = prevData || { strategies: [] };

  const prevStrategyIndex = buildStrategyIndex(effectivePrevData);
  const prevOppIndex = buildOpportunityIndex(effectivePrevData);

  for (const nextStrategy of nextData.strategies || []) {
    const prevStrategy = prevStrategyIndex.get(nextStrategy.id);

    if (!prevStrategy) {
      // New strategy (first save or newly added) -- treat current status as a change
      const candidateEmails = [
        ...(nextStrategy.opportunities || []).map((o) => o.assignee),
        nextStrategy.createdBy,
      ];
      const opportunityNames = (nextStrategy.opportunities || [])
        .map((o) => o.name || libraryOppNames.get(o.opportunityId) || o.opportunityId);

      changes.push({
        type: 'strategy',
        strategyId: nextStrategy.id,
        strategyName: nextStrategy.name,
        statusBefore: '',
        statusAfter: nextStrategy.status,
        recipients: filterValidEmails(candidateEmails, log),
        createdBy: nextStrategy.createdBy || '',
        opportunityNames,
      });

      // Also emit changes for each opportunity in the new strategy
      for (const opp of nextStrategy.opportunities || []) {
        const oppCandidates = [opp.assignee, nextStrategy.createdBy];
        changes.push({
          type: 'opportunity',
          strategyId: nextStrategy.id,
          strategyName: nextStrategy.name,
          opportunityId: opp.opportunityId,
          opportunityName: opp.name || libraryOppNames.get(opp.opportunityId) || opp.opportunityId,
          statusBefore: '',
          statusAfter: opp.status,
          recipients: filterValidEmails(oppCandidates, log),
          createdBy: nextStrategy.createdBy || '',
          assignee: opp.assignee || '',
        });
      }
    } else {
      // Existing strategy -- check strategy-level status change
      if (prevStrategy.status !== nextStrategy.status) {
        const candidateEmails = [
          ...(nextStrategy.opportunities || []).map((o) => o.assignee),
          nextStrategy.createdBy,
        ];
        const opportunityNames = (nextStrategy.opportunities || [])
          .map((o) => o.name || libraryOppNames.get(o.opportunityId) || o.opportunityId);

        changes.push({
          type: 'strategy',
          strategyId: nextStrategy.id,
          strategyName: nextStrategy.name,
          statusBefore: prevStrategy.status,
          statusAfter: nextStrategy.status,
          recipients: filterValidEmails(candidateEmails, log),
          createdBy: nextStrategy.createdBy || '',
          opportunityNames,
        });
      }

      // Check opportunity-level status changes and assignment changes
      const prevOpps = prevOppIndex.get(nextStrategy.id);
      for (const nextOpp of nextStrategy.opportunities || []) {
        const prevOpp = prevOpps?.get(nextOpp.opportunityId);
        if (!prevOpp) {
          // New opportunity added to existing strategy with assignee -> emit assignment change
          if (nextOpp.assignee) {
            changes.push({
              type: 'assignment',
              strategyId: nextStrategy.id,
              strategyName: nextStrategy.name,
              opportunityId: nextOpp.opportunityId,
              opportunityName: (nextOpp.name
                || libraryOppNames.get(nextOpp.opportunityId) || nextOpp.opportunityId),
              assigneeBefore: '',
              assigneeAfter: nextOpp.assignee,
              statusAfter: nextOpp.status,
              recipients: filterValidEmails([nextOpp.assignee, nextStrategy.createdBy], log),
              createdBy: nextStrategy.createdBy || '',
              assignee: nextOpp.assignee,
            });
          }
          // Skip status change for new opportunities (no prev status)
        } else {
          if (prevOpp.status !== nextOpp.status) {
            const candidateEmails = [
              nextOpp.assignee,
              nextStrategy.createdBy,
            ];

            changes.push({
              type: 'opportunity',
              strategyId: nextStrategy.id,
              strategyName: nextStrategy.name,
              opportunityId: nextOpp.opportunityId,
              opportunityName: (nextOpp.name
                || libraryOppNames.get(nextOpp.opportunityId) || nextOpp.opportunityId),
              statusBefore: prevOpp.status,
              statusAfter: nextOpp.status,
              recipients: filterValidEmails(candidateEmails, log),
              createdBy: nextStrategy.createdBy || '',
              assignee: nextOpp.assignee || '',
            });
          }
          // Assignee changed (empty->user or user->user); assignee removed -> no assignment change
          if (prevOpp.assignee !== nextOpp.assignee && nextOpp.assignee) {
            changes.push({
              type: 'assignment',
              strategyId: nextStrategy.id,
              strategyName: nextStrategy.name,
              opportunityId: nextOpp.opportunityId,
              opportunityName: (nextOpp.name
                || libraryOppNames.get(nextOpp.opportunityId) || nextOpp.opportunityId),
              assigneeBefore: prevOpp.assignee || '',
              assigneeAfter: nextOpp.assignee,
              statusAfter: nextOpp.status,
              recipients: filterValidEmails([nextOpp.assignee, nextStrategy.createdBy], log),
              createdBy: nextStrategy.createdBy || '',
              assignee: nextOpp.assignee,
            });
          }
        }
      }
    }
  }

  return changes;
}

/**
 * Sends email notifications for detected status changes.
 *
 * @param {Object} context - The request context (env, log, dataAccess).
 * @param {Object} params
 * @param {StatusChange[]} params.changes - Detected status changes.
 * @param {string} params.siteId - The site ID.
 * @param {string} [params.siteBaseUrl] - Site base URL for strategy_url.
 * @param {string} [params.changedBy] - Email or identifier of who made the change.
 * @returns {Promise<{sent: number, failed: number, skipped: number}>}
 *   Summary counts. Never throws.
 */
export async function sendStatusChangeNotifications(context, {
  changes, siteBaseUrl,
}) {
  const { log, dataAccess } = context;
  const summary = { sent: 0, failed: 0, skipped: 0 };

  const oppTemplateName = 'llmo_opportunity_status_update';
  const stratTemplateName = 'llmo_strategy_update';

  const hostname = extractHostnameFromBaseURL(siteBaseUrl || '');
  const strategyUrl = hostname
    ? `https://llmo.now/${hostname}/insights/opportunity-workspace`
    : '';

  for (const change of changes) {
    if (change.recipients.length === 0) {
      log.warn(`No valid recipients for ${change.type} status change (${change.strategyId}/${change.opportunityId || 'strategy'}), skipping`);
      summary.skipped += 1;
    } else {
      const isOpportunity = change.type === 'opportunity';
      const isAssignment = change.type === 'assignment';
      const templateName = (isOpportunity || isAssignment) ? oppTemplateName : stratTemplateName;

      const createdBy = change.createdBy || '';
      if (!createdBy) {
        log.warn(`Strategy owner (createdBy) is unknown for strategy ${change.strategyId}`);
      }

      const strategyOwnerName = createdBy
        // eslint-disable-next-line no-await-in-loop
        ? await resolveUserName(dataAccess, createdBy)
        : '-';
      const strategyOwnerEmail = createdBy || '-';

      const assigneeEmail = (isOpportunity || isAssignment) ? (change.assignee || '') : '';
      const assigneeName = assigneeEmail
        // eslint-disable-next-line no-await-in-loop
        ? await resolveUserName(dataAccess, assigneeEmail)
        : '';

      for (const recipient of change.recipients) {
        // eslint-disable-next-line no-await-in-loop
        const recipientName = await resolveUserName(dataAccess, recipient);

        let templateData;
        if (isOpportunity || isAssignment) {
          templateData = {
            recipient_name: recipientName,
            recipient_email: recipient,
            assignee_name: assigneeName,
            assignee_email: assigneeEmail,
            strategy_owner_name: strategyOwnerName,
            strategy_owner_email: strategyOwnerEmail,
            opportunity_name: change.opportunityName || '',
            opportunity_status: change.statusAfter,
            strategy_name: change.strategyName,
            strategy_url: strategyUrl,
          };
        } else {
          templateData = {
            recipient_name: recipientName,
            recipient_email: recipient,
            strategy_name: change.strategyName,
            strategy_status: change.statusAfter,
            strategy_url: strategyUrl,
            strategy_owner_name: strategyOwnerName,
            strategy_owner_email: strategyOwnerEmail,
            opportunity_list: change.opportunityNames || [],
          };
        }

        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await sendEmail(context, {
            recipients: [recipient],
            templateName,
            templateData,
          });

          if (result.success) {
            summary.sent += 1;
            log.info(`Sent ${change.type} status change email to ${recipient} for ${change.strategyId}`);
          } else {
            summary.failed += 1;
            log.error(`Failed to send ${change.type} status change email to ${recipient}: ${result.error}`);
          }
        } catch (error) {
          summary.failed += 1;
          log.error(`Error sending ${change.type} status change email to ${recipient}: ${error.message}`);
        }
      }
    }
  }

  return summary;
}

/**
 * Main entry point: detects status changes and sends notifications.
 * Safe to call in a fire-and-forget manner; never throws.
 *
 * @param {Object} context - The request context (env, log, dataAccess, etc.).
 * @param {Object} params
 * @param {Object|null} params.prevData - Previous strategy data.
 * @param {Object} params.nextData - New strategy data.
 * @param {string} params.siteId - The site ID.
 * @param {string} [params.siteBaseUrl] - Site base URL for strategy_url.
 * @param {string} [params.changedBy] - Who made the change (email or 'system').
 * @returns {Promise<{sent: number, failed: number, skipped: number, changes: number}>}
 */
export async function notifyStrategyChanges(context, {
  prevData, nextData, siteId, siteBaseUrl, changedBy,
}) {
  const { log } = context;

  try {
    const changes = detectStatusChanges(prevData, nextData, log);

    if (changes.length === 0) {
      log.info(`No status changes detected for site ${siteId}, skipping notifications`);
      return {
        sent: 0, failed: 0, skipped: 0, changes: 0,
      };
    }

    log.info(`Detected ${changes.length} status change(s) for site ${siteId}, sending notifications`);
    const summary = await sendStatusChangeNotifications(context, {
      changes, siteId, siteBaseUrl, changedBy,
    });

    return { ...summary, changes: changes.length };
  } catch (error) {
    log.error(`Error in notifyStrategyChanges for site ${siteId}: ${error.message}`);
    return {
      sent: 0, failed: 0, skipped: 0, changes: 0,
    };
  }
}
