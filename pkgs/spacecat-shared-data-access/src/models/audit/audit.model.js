/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { isArray, isObject } from '@adobe/spacecat-shared-utils';

import { ValidationError } from '../../errors/index.js';
import BaseModel from '../base/base.model.js';

/**
 * Audit - A class representing an Audit entity.
 * Provides methods to access and manipulate Audit-specific data.
 *
 * @class Audit
 * @extends BaseModel
 */
class Audit extends BaseModel {
  static AUDIT_TYPES = {
    APEX: 'apex',
    CWV: 'cwv',
    LHS_MOBILE: 'lhs-mobile',
    LHS_DESKTOP: 'lhs-desktop',
    404: '404',
    SITEMAP: 'sitemap',
    CANONICAL: 'canonical',
    BROKEN_BACKLINKS: 'broken-backlinks',
    BROKEN_INTERNAL_LINKS: 'broken-internal-links',
    EXPERIMENTATION: 'experimentation',
    CONVERSION: 'conversion',
    ORGANIC_KEYWORDS: 'organic-keywords',
    ORGANIC_TRAFFIC: 'organic-traffic',
    EXPERIMENTATION_ESS_DAILY: 'experimentation-ess-daily',
    EXPERIMENTATION_ESS_MONTHLY: 'experimentation-ess-monthly',
    EXPERIMENTATION_OPPORTUNITIES: 'experimentation-opportunities',
    META_TAGS: 'meta-tags',
    COSTS: 'costs',
    STRUCTURED_DATA: 'structured-data',
    STRUCTURED_DATA_AUTO_SUGGEST: 'structured-data-auto-suggest',
    FORMS_OPPORTUNITIES: 'forms-opportunities',
    SITE_DETECTION: 'site-detection',
    ALT_TEXT: 'alt-text',
  };

  static AUDIT_TYPE_PROPERTIES = {
    [Audit.AUDIT_TYPES.LHS_DESKTOP]: ['performance', 'seo', 'accessibility', 'best-practices'],
    [Audit.AUDIT_TYPES.LHS_MOBILE]: ['performance', 'seo', 'accessibility', 'best-practices'],
  };

  static AUDIT_CONFIG = {
    TYPES: Audit.AUDIT_TYPES,
    PROPERTIES: Audit.AUDIT_TYPE_PROPERTIES,
  };

  /**
   * The destinations for the audit steps. Used with AuditBuilder to determine the destination
   * an audit step should trigger.
   * @type {{CONTENT_SCRAPER: string, IMPORT_WORKER: string}}
   */
  static AUDIT_STEP_DESTINATIONS = {
    CONTENT_SCRAPER: 'content-scraper',
    IMPORT_WORKER: 'import-worker',
  };

  /**
   * The configurations for the audit step destinations. Used with AuditBuilder to configure
   * the destination queue URL and payload formatting.
   * @type {{
   *   [Audit.AUDIT_STEP_DESTINATIONS.CONTENT_SCRAPER]: {
   *     getQueueUrl: function,
   *     formatPayload: function
   *   },
   *   [Audit.AUDIT_STEP_DESTINATIONS.IMPORT_WORKER]: {
   *     getQueueUrl: function,
   *     formatPayload: function
   *   }
   * }}
   */
  static AUDIT_STEP_DESTINATION_CONFIGS = {
    [Audit.AUDIT_STEP_DESTINATIONS.IMPORT_WORKER]: {
      getQueueUrl: (context) => context.env?.IMPORT_WORKER_QUEUE_URL,
      /**
       * Formats the payload for the import worker queue.
       * @param {object} stepResult - The result of the audit step.
       * @param {string} stepResult.type - The import type to trigger.
       * @param {string} stepResult.siteId - The site ID for which the import is triggered.
       * @param {object} auditContext - The audit context.
       * @param {object} auditContext.next - The next audit step to run.
       * @param {string} auditContext.auditId - The audit ID.
       * @param {string} auditContext.auditType - The audit type.
       * @param {string} auditContext.fullAuditRef - The full audit reference.
       * @param {string} auditContext.<string> - Optional. Any additional context properties
       * as needed by the audit type.
       *
       * @returns {object} - The formatted payload.
       */
      formatPayload: (stepResult, auditContext) => ({
        type: stepResult.type,
        siteId: stepResult.siteId,
        auditContext,
      }),
    },
    [Audit.AUDIT_STEP_DESTINATIONS.CONTENT_SCRAPER]: {
      getQueueUrl: (context) => context.env?.CONTENT_SCRAPER_QUEUE_URL,
      /**
       * Formats the payload for the content scraper queue.
       * @param {object} stepResult - The result of the audit step.
       * @param {object[]} stepResult.urls - The list of URLs to scrape.
       * @param {string} stepResult.urls[].url - The URL to scrape.
       * @param {string} stepResult.siteId - The site ID. Will be used as the job ID.
       * @param {string} stepResult.processingType - The scraping processing type to trigger.
       * @param {object} auditContext - The audit context.
       * @param {object} auditContext.next - The next audit step to run.
       * @param {string} auditContext.auditId - The audit ID.
       * @param {string} auditContext.auditType - The audit type.
       * @param {string} auditContext.fullAuditRef - The full audit reference.
       *
       * @returns {object} - The formatted payload.
       */
      formatPayload: (stepResult, auditContext) => ({
        urls: stepResult.urls,
        jobId: stepResult.siteId,
        processingType: stepResult.processingType || 'default',
        auditContext,
      }),
    },
  };

  /**
   * Validates if the auditResult contains the required properties for the given audit type.
   * @param {object} auditResult - The audit result to validate.
   * @param {string} auditType - The type of the audit.
   * @returns {boolean} - True if valid, false otherwise.
   */
  static validateAuditResult = (auditResult, auditType) => {
    if (!isObject(auditResult) && !isArray(auditResult)) {
      throw new ValidationError('Audit result must be an object or array');
    }

    if (isObject(auditResult.runtimeError)) {
      return true;
    }

    if ((
      auditType === Audit.AUDIT_CONFIG.TYPES.LHS_MOBILE
        || auditType === Audit.AUDIT_CONFIG.TYPES.LHS_DESKTOP
    )
      && !isObject(auditResult.scores)) {
      throw new ValidationError(`Missing scores property for audit type '${auditType}'`);
    }

    const expectedProperties = Audit.AUDIT_CONFIG.PROPERTIES[auditType];

    if (expectedProperties) {
      for (const prop of expectedProperties) {
        if (!(prop in auditResult.scores)) {
          throw new ValidationError(`Missing expected property '${prop}' for audit type '${auditType}'`);
        }
      }
    }

    return true;
  };

  getScores() {
    return this.getAuditResult()?.scores;
  }
}

export default Audit;
