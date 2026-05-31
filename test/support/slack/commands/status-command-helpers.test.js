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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import nock from 'nock';

import {
  appendLimitedDetails,
  parseStatusCommandArgs,
  parseUtcDateArg,
  postReport,
  splitLinesIntoFileChunks,
} from '../../../../src/support/slack/commands/status-command-helpers.js';

use(sinonChai);

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

  describe('splitLinesIntoFileChunks', () => {
    it('returns a single chunk when the lines fit under the limit', () => {
      const chunks = splitLinesIntoFileChunks(['one', 'two', 'three'], 1024);
      expect(chunks).to.deep.equal([['one', 'two', 'three']]);
    });

    it('returns no chunks for an empty input', () => {
      expect(splitLinesIntoFileChunks([], 1024)).to.deep.equal([]);
    });

    it('splits across multiple chunks when total bytes exceed the limit', () => {
      const lines = Array.from({ length: 6 }, (_, i) => `line-${i}-${'x'.repeat(50)}`);
      // Each line is ~57 bytes + newline; 4 lines per ~250 byte chunk.
      const chunks = splitLinesIntoFileChunks(lines, 250);
      expect(chunks.length).to.be.greaterThan(1);
      expect(chunks.flat()).to.deep.equal(lines);
      for (const chunk of chunks) {
        const bytes = chunk.reduce(
          (sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1,
          0,
        );
        // A single oversized line is allowed to overflow on its own,
        // but no chunk should pack more lines than the limit allows.
        if (chunk.length > 1) {
          expect(bytes).to.be.at.most(250);
        }
      }
    });

    it('keeps a single oversized line in its own chunk', () => {
      const big = 'x'.repeat(500);
      const chunks = splitLinesIntoFileChunks(['head', big, 'tail'], 100);
      expect(chunks).to.deep.equal([['head'], [big], ['tail']]);
    });
  });

  describe('postReport upload chunking', () => {
    const UPLOAD_URL = 'https://files-upload.slack.test/upload';
    const buildSlackContext = () => ({
      channelId: 'C123',
      say: sinon.stub().resolves(),
      client: {
        files: {
          getUploadURLExternal: sinon.stub().resolves({
            ok: true, upload_url: UPLOAD_URL, file_id: 'F1',
          }),
          completeUploadExternal: sinon.stub().resolves({ ok: true }),
        },
      },
    });

    beforeEach(() => {
      nock('https://files-upload.slack.test')
        .persist()
        .post('/upload')
        .reply(200, 'OK');
    });
    afterEach(() => {
      nock.cleanAll();
    });

    it('uploads a single file when the full report fits under the byte limit', async () => {
      const slackContext = buildSlackContext();
      const fullLines = Array.from({ length: 5 }, (_, i) => `line-${i}`);

      await postReport(slackContext, ['compact'], 'rpt', 'Title', 'Comment', fullLines);

      expect(slackContext.client.files.getUploadURLExternal).to.have.been.calledOnce;
      expect(slackContext.client.files.getUploadURLExternal.firstCall.args[0].filename)
        .to.equal('rpt.txt');
      expect(slackContext.client.files.completeUploadExternal.firstCall.args[0].initial_comment)
        .to.equal('Comment');
    });

    it('splits a large report into multiple uploaded files with part-of suffixes', async () => {
      const slackContext = buildSlackContext();
      const big = 'x'.repeat(80 * 1024);
      const fullLines = Array.from({ length: 4 }, () => big); // ~320KB total

      await postReport(slackContext, ['compact'], 'big-rpt', 'Big', 'Comment', fullLines);

      const filenames = slackContext.client.files.getUploadURLExternal
        .getCalls().map((c) => c.args[0].filename);
      expect(filenames.length).to.be.greaterThan(1);
      filenames.forEach((name, idx) => {
        expect(name).to.equal(`big-rpt-part-${idx + 1}-of-${filenames.length}.txt`);
      });
      const comments = slackContext.client.files.completeUploadExternal
        .getCalls().map((c) => c.args[0].initial_comment);
      comments.forEach((comment, idx) => {
        expect(comment).to.equal(`Comment — part ${idx + 1} of ${comments.length}`);
      });
    });

    it('continues uploading remaining parts when one part fails', async () => {
      const slackContext = buildSlackContext();
      const big = 'x'.repeat(80 * 1024);
      const fullLines = Array.from({ length: 4 }, () => big);
      slackContext.client.files.getUploadURLExternal.onSecondCall()
        .resolves({ ok: false, error: 'upload denied' });

      await postReport(slackContext, ['compact'], 'big-rpt', 'Big', 'Comment', fullLines);

      const totalParts = slackContext.client.files.getUploadURLExternal.callCount;
      expect(totalParts).to.be.greaterThan(1);
      const completed = slackContext.client.files.completeUploadExternal.callCount;
      // Part 1 + Parts 3..N succeed; part 2 fails before completeUpload.
      expect(completed).to.equal(totalParts - 1);
      const warnings = slackContext.say.getCalls()
        .map((c) => c.args[0])
        .filter((m) => typeof m === 'string' && m.startsWith(':warning:'));
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.match(
        new RegExp(`Full report upload \\(part 2/${totalParts}\\) failed: `),
      );
    });
  });
});
