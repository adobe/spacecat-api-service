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

import { v4 as uuidv4 } from 'uuid';

import { getRandomDecimal, getRandomInt, randomDate } from './util.js';

function generateRandomAudit(siteId, auditType) {
  let auditResult = {};
  const auditedAt = randomDate(new Date(2020, 0, 1), new Date()).toISOString();
  const expiresAt = new Date(auditedAt);
  expiresAt.setDate(expiresAt.getDate() + 30);
  const fullAuditRef = `s3://audit-results/${uuidv4()}.json`;

  if (auditType === 'lhs-mobile') {
    auditResult = {
      scores: {
        performance: getRandomDecimal(2),
        seo: getRandomDecimal(2),
        accessibility: getRandomDecimal(2),
        'best-practices': getRandomDecimal(2),
      },
    };
  } else if (auditType === 'cwv') {
    auditResult = {
      scores: {
        LCP: getRandomInt(4000), // LCP in milliseconds
        FID: getRandomInt(100), // FID in milliseconds
        CLS: getRandomDecimal(2), // CLS score
      },
    };
  }

  return {
    siteId,
    SK: `${auditType}#${auditedAt}`,
    auditType,
    auditedAt,
    auditResult,
    isLive: true,
    expiresAt: Math.floor(expiresAt.getTime() / 1000), // AWS expects unix epoch in seconds
    fullAuditRef,
  };
}

export { generateRandomAudit };
