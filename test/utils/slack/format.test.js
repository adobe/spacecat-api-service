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

/* eslint-env mocha */

import { expect } from 'chai';
import sinon from 'sinon';

import {
  addEllipsis,
  formatDate,
  formatScore,
  formatSize,
  formatURL,
  printSiteDetails,
} from '../../../src/utils/slack/format.js';

describe('Utility Functions', () => {
  describe('addEllipsis()', () => {
    it('adds ellipsis to a long string', () => {
      const longString = 'This is a very long string that needs truncating';
      expect(addEllipsis(longString)).to.equal('This is a very lon..');
    });

    it('returns the original string if it is short', () => {
      const shortString = 'Short';
      expect(addEllipsis(shortString)).to.equal('Short');
    });
  });

  describe('formatDate()', () => {
    it('formats valid ISO date string', () => {
      const isoDateString = '2023-01-01T12:00:00.000Z';
      expect(formatDate(isoDateString)).to.equal('2023-01-01 12:00:00');
    });

    it('returns N/A for invalid dates', () => {
      expect(formatDate('invalid-date')).to.equal('N/A');
    });

    it('returns N/A for null input', () => {
      expect(formatDate(null)).to.equal('N/A');
    });
  });

  describe('formatScore()', () => {
    it('formats a number as a percentage', () => {
      expect(formatScore(0.85)).to.equal('85%');
    });

    it('returns "---" for non-numeric values', () => {
      expect(formatScore(NaN)).to.equal('---');
    });
  });

  describe('formatSize()', () => {
    it('formats bytes into the appropriate size format', () => {
      expect(formatSize(1024)).to.equal('1.00 KB');
      expect(formatSize(1048576)).to.equal('1.00 MB');
    });
  });

  describe('formatURL()', () => {
    it('adds https to a URL if missing', () => {
      expect(formatURL('example.com')).to.equal('https://example.com');
    });

    it('replaces http with https in a URL', () => {
      expect(formatURL('http://example.com')).to.equal('https://example.com');
    });

    it('keeps URL unchanged if https is already present', () => {
      expect(formatURL('https://example.com')).to.equal('https://example.com');
    });
  });

  describe('printSiteDetails()', () => {
    let mockSite;

    beforeEach(() => {
      mockSite = {
        getBaseURL: sinon.stub(),
        getGitHubURL: sinon.stub(),
        isLive: sinon.stub(),
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    it('prints details for a live site with GitHub URL', () => {
      mockSite.getBaseURL.returns('https://example.com');
      mockSite.getGitHubURL.returns('https://github.com/example/repo');
      mockSite.isLive.returns(true);

      const expectedOutput = `
      :mars-team: Base URL: https://example.com
      :github-4173: GitHub: https://github.com/example/repo
      :rocket: Is Live: Yes
      :lighthouse: <https://psi.experiencecloud.live?url=https://example.com&strategy=mobile|Run PSI check>
    `;

      expect(printSiteDetails(mockSite)).to.equal(expectedOutput);
    });

    it('prints details for a non-live site without GitHub URL', () => {
      mockSite.getBaseURL.returns('https://example.com');
      mockSite.getGitHubURL.returns(null);
      mockSite.isLive.returns(false);

      const expectedOutput = `
      :mars-team: Base URL: https://example.com
      :github-4173: GitHub: _not set_
      :submarine: Is Live: No
      :lighthouse: <https://psi.experiencecloud.live?url=https://example.com&strategy=mobile|Run PSI check>
    `;

      expect(printSiteDetails(mockSite)).to.equal(expectedOutput);
    });
  });
});
