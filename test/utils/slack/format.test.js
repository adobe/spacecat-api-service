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
  formatLighthouseError,
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
      expect(formatScore(0.85)).to.equal('85');
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
        getId: sinon.stub().returns('some-id'),
        getDeliveryType: sinon.stub().returns('aem_edge'),
        getBaseURL: sinon.stub(),
        getGitHubURL: sinon.stub(),
        getIsLive: sinon.stub(),
        getIsLiveToggledAt: sinon.stub().returns('2011-10-05T14:48:00.000Z'),
      };
    });

    afterEach(() => {
      sinon.restore();
    });

    it('prints details for a live site with GitHub URL', () => {
      mockSite.getBaseURL.returns('https://example.com');
      mockSite.getGitHubURL.returns('https://github.com/example/repo');
      mockSite.getIsLive.returns(true);

      const expectedOutput = `
      :identification_card: some-id
      :cat-egory-white: aem_edge
      :github-4173: https://github.com/example/repo
      :rocket: Is live (2011-10-05 14:48:00)
      :lighthouse: <https://psi.experiencecloud.live?url=https://example.com&strategy=mobile|Run PSI Check>
    `;

      expect(printSiteDetails(mockSite, true, 'mobile')).to.equal(expectedOutput);
    });

    it('prints details for a site with audits disabled', () => {
      mockSite.getBaseURL.returns('https://example.com');

      const expectedOutput = `:warning: Audits have been disabled for site or strategy! This is usually done when PSI audits experience errors due to the target having issues (e.g. DNS or 404).

      :identification_card: some-id
      :cat-egory-white: aem_edge
      :github-4173: _not set_
      :submarine: Is not live
      :lighthouse: <https://psi.experiencecloud.live?url=https://example.com&strategy=mobile|Run PSI Check>
    `;

      expect(printSiteDetails(mockSite, false, 'mobile')).to.equal(expectedOutput);
    });

    it('prints details for a site with latest audit error', () => {
      mockSite.getBaseURL.returns('https://example.com');
      mockSite.getGitHubURL.returns('https://github.com/example/repo');
      mockSite.getIsLive.returns(true);

      const mockAudit = {
        getFullAuditRef: sinon.stub().returns('https://psi-result/1'),
        getIsError: sinon.stub().returns(true),
      };

      const expectedOutput = `
      :identification_card: some-id
      :cat-egory-white: aem_edge
      :github-4173: https://github.com/example/repo
      :rocket: Is live (2011-10-05 14:48:00)
      :lighthouse: :warning: <https://googlechrome.github.io/lighthouse/viewer/?jsonurl=https://psi-result/1|View Latest Audit> or <https://psi.experiencecloud.live?url=https://example.com&strategy=mobile|Run PSI Check>
    `;

      expect(printSiteDetails(mockSite, true, 'mobile', mockAudit)).to.equal(expectedOutput);
    });

    it('prints details for a site with latest audit', () => {
      mockSite.getBaseURL.returns('https://example.com');
      mockSite.getGitHubURL.returns('https://github.com/example/repo');
      mockSite.getIsLive.returns(true);

      const mockAudit = {
        getFullAuditRef: sinon.stub().returns('https://psi-result/1'),
        getIsError: sinon.stub().returns(false),
      };

      const expectedOutput = `
      :identification_card: some-id
      :cat-egory-white: aem_edge
      :github-4173: https://github.com/example/repo
      :rocket: Is live (2011-10-05 14:48:00)
      :lighthouse: <https://googlechrome.github.io/lighthouse/viewer/?jsonurl=https://psi-result/1|View Latest Audit> or <https://psi.experiencecloud.live?url=https://example.com&strategy=mobile|Run PSI Check>
    `;

      expect(printSiteDetails(mockSite, true, 'mobile', mockAudit)).to.equal(expectedOutput);
    });

    it('prints details for a non-live site without GitHub URL', () => {
      mockSite.getBaseURL.returns('https://example.com');
      mockSite.getGitHubURL.returns(null);
      mockSite.getIsLive.returns(false);

      const expectedOutput = `
      :identification_card: some-id
      :cat-egory-white: aem_edge
      :github-4173: _not set_
      :submarine: Is not live
      :lighthouse: <https://psi.experiencecloud.live?url=https://example.com&strategy=mobile|Run PSI Check>
    `;

      expect(printSiteDetails(mockSite, 'mobile')).to.equal(expectedOutput);
    });
  });

  describe('formatLighthouseError()', () => {
    it('formats ERRORED_DOCUMENT_REQUEST with status code', () => {
      const runtimeError = {
        code: 'ERRORED_DOCUMENT_REQUEST',
        message: 'Could not fetch the page. (Status code: 404)',
      };
      expect(formatLighthouseError(runtimeError)).to.equal('Lighthouse Error: Could not fetch the page (Status: 404) [ERRORED_DOCUMENT_REQUEST]');
    });

    it('formats ERRORED_DOCUMENT_REQUEST with missing status code', () => {
      const runtimeError = {
        code: 'ERRORED_DOCUMENT_REQUEST',
        message: 'Could not fetch the page. Brrrzzzzt.',
      };
      expect(formatLighthouseError(runtimeError)).to.equal('Lighthouse Error: Could not fetch the page (Status: unknown) [ERRORED_DOCUMENT_REQUEST]');
    });

    it('formats known error without additional data', () => {
      const runtimeError = {
        code: 'NO_FCP',
        message: 'No first contentful paint.',
      };
      expect(formatLighthouseError(runtimeError)).to.equal('Lighthouse Error: No First Contentful Paint [NO_FCP]');
    });

    it('handles unknown error codes', () => {
      const runtimeError = {
        code: 'UNKNOWN_CODE',
        message: 'An unknown error occurred.',
      };
      expect(formatLighthouseError(runtimeError)).to.equal('Lighthouse Error: Unknown error [UNKNOWN_CODE]');
    });

    // Additional test for the new FAILED_DOCUMENT_REQUEST case
    it('formats FAILED_DOCUMENT_REQUEST with details', () => {
      const runtimeError = {
        code: 'FAILED_DOCUMENT_REQUEST',
        message: 'Failed to load the page. (Details: net::ERR_CERT_COMMON_NAME_INVALID)',
      };
      expect(formatLighthouseError(runtimeError)).to.equal('Lighthouse Error: Failed to load the page (Details: net::ERR_CERT_COMMON_NAME_INVALID) [FAILED_DOCUMENT_REQUEST]');
    });

    // Test for FAILED_DOCUMENT_REQUEST with missing details
    it('formats FAILED_DOCUMENT_REQUEST with missing details', () => {
      const runtimeError = {
        code: 'FAILED_DOCUMENT_REQUEST',
        message: 'Failed to load the page. No further details.',
      };
      expect(formatLighthouseError(runtimeError)).to.equal('Lighthouse Error: Failed to load the page (Details: unknown) [FAILED_DOCUMENT_REQUEST]');
    });
  });
});
