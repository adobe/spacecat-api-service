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

import { expect } from 'chai';
import sinon from 'sinon';

import {
  appendLimitedDetails,
  parseStatusCommandArgs,
  parseUtcDateArg,
  postReport,
} from '../../../../src/support/slack/commands/status-command-helpers.js';

describe('status command helpers', () => {
  it('returns null when parseUtcDateArg receives a non-date token', () => {
    expect(parseUtcDateArg('not-a-date')).to.equal(null);
  });

  it('rejects a duplicate bare UUID after a siteId key argument', () => {
    const firstSiteId = '11111111-2222-3333-4444-555555555555';
    const secondSiteId = '22222222-3333-4444-5555-555555555555';
    expect(parseStatusCommandArgs([`siteId=${firstSiteId}`, secondSiteId])).to.deep.equal({
      error: ':warning: Duplicate siteId argument.',
    });
  });

  it('parses baseUrl arguments and normalizes Slack links', () => {
    expect(parseStatusCommandArgs([
      '2026-04-22',
      'baseUrl=<https://www.example.com/path/|example>',
    ])).to.deep.equal({
      dateArg: '2026-04-22',
      baseURL: 'https://example.com/path/',
    });
  });

  it('rejects invalid and duplicate baseUrl arguments', () => {
    expect(parseStatusCommandArgs(['baseUrl='])).to.deep.equal({
      error: ':warning: baseUrl must not be empty.',
    });
    expect(parseStatusCommandArgs(['baseUrl=not-a-url'])).to.deep.equal({
      error: ':warning: Invalid baseUrl. Expected URL.',
    });
    expect(parseStatusCommandArgs(['baseUrl=https://one.com', 'baseUrl=https://two.com']))
      .to.deep.equal({
        error: ':warning: Duplicate baseUrl argument.',
      });
  });

  it('rejects combining siteId and baseUrl', () => {
    const siteId = '11111111-2222-3333-4444-555555555555';

    expect(parseStatusCommandArgs([
      'baseUrl=https://example.com',
      siteId,
    ])).to.deep.equal({
      error: ':warning: Cannot combine siteId and baseUrl arguments.',
    });
    expect(parseStatusCommandArgs([
      `siteId=${siteId}`,
      'baseUrl=https://example.com',
    ])).to.deep.equal({
      error: ':warning: Cannot combine siteId and baseUrl arguments.',
    });
    expect(parseStatusCommandArgs([
      'baseUrl=https://example.com',
      `siteId=${siteId}`,
    ])).to.deep.equal({
      error: ':warning: Cannot combine siteId and baseUrl arguments.',
    });
  });

  it('limits row detail and appends an omitted marker', () => {
    const lines = [];
    appendLimitedDetails(
      lines,
      Array.from({ length: 10 }, (_, i) => i),
      (i) => `row ${i}`,
      (omitted) => `${omitted} omitted`,
    );

    expect(lines).to.deep.equal([
      'row 0',
      'row 1',
      'row 2',
      'row 3',
      'row 4',
      'row 5',
      'row 6',
      'row 7',
      '2 omitted',
    ]);
  });

  it('warns when full report upload fails', async () => {
    const slackContext = {
      channelId: 'C123',
      say: sinon.stub().resolves(),
      client: {
        files: {
          getUploadURLExternal: sinon.stub().resolves({ ok: false, error: 'upload denied' }),
          completeUploadExternal: sinon.stub().resolves({ ok: true }),
        },
      },
    };

    await postReport(
      slackContext,
      ['compact'],
      'report',
      'Report',
      'Full report',
      ['compact', 'full detail'],
    );

    expect(slackContext.say.firstCall.args[0]).to.equal('compact');
    expect(slackContext.say.secondCall.args[0])
      .to.equal(':warning: Full report upload failed: Failed to get upload URL: upload denied');
  });
});
