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

import { Audit } from '@adobe/spacecat-shared-data-access';

/**
 * Data transfer object for Site.
 */
export const AuditDto = {
  /**
   * Converts an Audit object into a JSON object.
   * @param {Readonly<Audit>} audit - Audit object.
   * @returns {{
   * auditResult: string,
   * auditType: string,
   * auditedAt: string,
   * fullAuditRef: string,
   * isLive: boolean,
   * siteId: string
   * }} JSON object.
   */
  toJSON: (audit) => ({
    auditResult: audit.getAuditResult(),
    auditType: audit.getAuditType(),
    auditedAt: audit.getAuditedAt(),
    fullAuditRef: audit.getFullAuditRef(),
    isLive: audit.getIsLive(),
    isError: audit.getIsError(),
    siteId: audit.getSiteId(),
  }),

  /**
   * Converts an Audit object into a JSON object.
   * @param {Readonly<Audit>} audit - Audit object.
   * @returns {{
   * auditResult: string,
   * auditType: string,
   * auditedAt: string,
   * fullAuditRef: string,
   * isLive: boolean,
   * siteId: string
   * }} JSON object.
   */
  toAbbreviatedJSON: (audit) => {
    if (audit.getAuditType() !== Audit.AUDIT_TYPES.LHS_DESKTOP
      && audit.getAuditType() !== Audit.AUDIT_TYPES.LHS_MOBILE) {
      return AuditDto.toJSON(audit);
    }
    return {
      auditResult: {
        finalUrl: audit.getAuditResult()?.finalUrl,
        runtimeError: audit.getAuditResult()?.runtimeError,
        scores: audit.getAuditResult()?.scores,
        totalBlockingTime: audit.getAuditResult()?.totalBlockingTime,
      },
      auditType: audit.getAuditType(),
      auditedAt: audit.getAuditedAt(),
      fullAuditRef: audit.getFullAuditRef(),
      isLive: audit.getIsLive(),
      isError: audit.getIsError(),
      siteId: audit.getSiteId(),
    };
  },
};
