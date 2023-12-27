/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { createAudit } from '@adobe/spacecat-shared-data-access/src/models/audit.js';

/**
 * Data transfer object for Site.
 */
export const AuditDto = {

  /**
   * Converts a JSON object into an Audit object.
   * @param {object } jsonObject - JSON object.
   * @returns {Readonly<Audit>} Audit object.
   */
  fromJson: (jsonObject) => {
    const auditData = {
      auditResult: jsonObject.auditResult,
      auditType: jsonObject.auditType,
      auditedAt: jsonObject.auditedAt,
      expiresAt: jsonObject.expiresAt,
      fullAuditRef: jsonObject.fullAuditRef,
      isLive: jsonObject.isLive,
      siteId: jsonObject.siteId,
    };

    return createAudit(auditData);
  },

  /**
   * Converts an Audit object into a JSON object.
   * @param {Readonly<Audit>} audit - Audit object.
   * @returns {{
   * auditResult: string,
   * auditType: string,
   * auditedAt: string,
   * expiresAt: string,
   * fullAuditRef: string,
   * isLive: boolean,
   * siteId: string
   * }} JSON object.
   */
  toJSON: (audit) => ({
    auditResult: audit.getAuditResult(),
    previousAuditResult: audit.getPreviousAuditResult() || {},
    auditType: audit.getAuditType(),
    auditedAt: audit.getAuditedAt(),
    expiresAt: audit.getExpiresAt().toISOString(),
    fullAuditRef: audit.getFullAuditRef(),
    isLive: audit.isLive(),
    isError: audit.isError(),
    siteId: audit.getSiteId(),
  }),

  /**
   * Converts an Audit object into a JSON object.
   * @param {Readonly<Audit>} audit - Audit object.
   * @returns {{
   * auditResult: string,
   * auditType: string,
   * auditedAt: string,
   * expiresAt: string,
   * fullAuditRef: string,
   * isLive: boolean,
   * siteId: string
   * }} JSON object.
   */
  toAbbreviatedJSON: (audit) => ({
    auditResult: {
      finalUrl: audit.getAuditResult()?.finalUrl,
      runtimeError: audit.getAuditResult()?.runtimeError,
      scores: audit.getAuditResult()?.scores,
      totalBlockingTime: audit.getAuditResult()?.totalBlockingTime,
    },
    previousAuditResult: {
      finalUrl: audit.getPreviousAuditResult()?.finalUrl,
      runtimeError: audit.getPreviousAuditResult()?.runtimeError,
      scores: audit.getPreviousAuditResult()?.scores,
      totalBlockingTime: audit.getPreviousAuditResult()?.totalBlockingTime,
      fullAuditRef: audit.getPreviousAuditResult()?.fullAuditRef,
      auditedAt: audit.getPreviousAuditResult()?.auditedAt,
    },
    auditType: audit.getAuditType(),
    auditedAt: audit.getAuditedAt(),
    expiresAt: audit.getExpiresAt().toISOString(),
    fullAuditRef: audit.getFullAuditRef(),
    isLive: audit.isLive(),
    isError: audit.isError(),
    siteId: audit.getSiteId(),
  }),
};
