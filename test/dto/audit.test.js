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

/* eslint-env mocha */

import { createAudit } from '@adobe/spacecat-shared-data-access/src/models/audit.js';
import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AuditDto } from '../../src/dto/audit.js';

use(chaiAsPromised);

describe('Audit DTO', () => {
  it('toAbbreviatedJSON returns all broken backlinks in the JSON', () => {
    const now = new Date();
    const fullAuditResult = {
      'https://www.test.com': {
        brokenBacklinks: [
          {
            title: 'backlink title',
            url_from: 'url-from',
            url_to: 'url-to',
          },
          {
            title: 'backlink title 2',
            url_from: 'url-from-2',
            url_to: 'url-to-2',
          },
        ],
        fullAuditRef: 'full-audit-ref',
      },
    };
    const fullPreviousAuditResult = {
      'https://www.test.com': {
        brokenBacklinks: [],
        fullAuditRef: 'full-audit-ref',
      },
    };
    const audit = createAudit({
      auditResult: fullAuditResult,
      previousAuditResult: fullPreviousAuditResult,
      auditType: 'broken-backlinks',
      auditedAt: now.toISOString(),
      expiresAt: now,
      fullAuditRef: 'full-audit-ref',
      isLive: true,
      isError: false,
      siteId: 'site-id',
    });

    const auditJson = AuditDto.toAbbreviatedJSON(audit);

    expect(auditJson).to.deep.equal({
      auditResult: fullAuditResult,
      previousAuditResult: fullPreviousAuditResult,
      auditType: 'broken-backlinks',
      auditedAt: now.toISOString(),
      expiresAt: now.toISOString(),
      fullAuditRef: 'full-audit-ref',
      isLive: true,
      isError: false,
      siteId: 'site-id',
    });
  });
});
