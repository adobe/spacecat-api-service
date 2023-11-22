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

const { v4: uuidv4 } = require('uuid');
const { randomDate } = require('./util.js');

// Function to generate random audit data
function generateRandomAudit(siteId) {
  const auditTypes = ['lhs', 'cwv'];
  const selectedType = auditTypes[Math.floor(Math.random() * auditTypes.length)];

  let auditResult = {};
  const auditedAt = randomDate(new Date(2020, 0, 1), new Date()).toISOString();
  const fullAuditRef = `s3://audit-results/${uuidv4()}.json`;

  function getRandomDecimal(precision) {
    return parseFloat(Math.random().toFixed(precision));
  }

  function getRandomInt(max) {
    return Math.floor(Math.random() * max);
  }

  if (selectedType === 'lhs') {
    auditResult = {
      performance: getRandomDecimal(2),
      accessibility: getRandomDecimal(2),
      bestPractices: getRandomDecimal(2),
      SEO: getRandomDecimal(2),
    };
  } else if (selectedType === 'cwv') {
    auditResult = {
      LCP: getRandomInt(4000), // LCP in milliseconds
      FID: getRandomInt(100), // FID in milliseconds
      CLS: getRandomDecimal(2), // CLS score
    };
  }

  return {
    siteId,
    SK: `${selectedType}#${auditedAt}`,
    auditType: selectedType,
    auditedAt,
    auditResult,
    fullAuditRef,
  };
}

module.exports = { generateRandomAudit };
