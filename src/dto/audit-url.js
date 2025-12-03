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

/**
 * Data transfer object for AuditUrl.
 */
export const AuditUrlDto = {

  /**
   * Converts an AuditUrl object into a JSON object.
   * @param {Readonly<AuditUrl>} auditUrl - AuditUrl object.
   * @returns {{
   *  auditUrlId: string,
   *  siteId: string,
   *  url: string,
   *  byCustomer: boolean,
   *  audits: string[],
   *  createdAt: string,
   *  updatedAt: string,
   *  createdBy: string,
   *  updatedBy: string,
   * }} JSON object.
   */
  toJSON: (auditUrl) => ({
    auditUrlId: auditUrl.getAuditUrlId(),
    siteId: auditUrl.getSiteId(),
    url: auditUrl.getUrl(),
    byCustomer: auditUrl.getByCustomer(),
    audits: auditUrl.getAudits(),
    createdAt: auditUrl.getCreatedAt(),
    updatedAt: auditUrl.getUpdatedAt(),
    createdBy: auditUrl.getCreatedBy(),
    updatedBy: auditUrl.getUpdatedBy(),
  }),
};
