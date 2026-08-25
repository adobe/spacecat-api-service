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

import {
  ALLOWED_DETECTED_CDNS,
  detectedCdnPatchGuard,
} from '../../src/support/detected-cdn-validation.js';

describe('detectedCdnPatchGuard', () => {
  // Returns a stand-in 400 response so we can assert when the guard rejects.
  const badRequest = (message) => ({ status: 400, message });

  it('returns null when the patch has no llmo', () => {
    expect(detectedCdnPatchGuard({}, badRequest)).to.equal(null);
    expect(detectedCdnPatchGuard({ slack: {} }, badRequest)).to.equal(null);
  });

  it('returns null when configPatch is nullish', () => {
    expect(detectedCdnPatchGuard(undefined, badRequest)).to.equal(null);
    expect(detectedCdnPatchGuard(null, badRequest)).to.equal(null);
  });

  it('returns null when llmo is not a plain object', () => {
    expect(detectedCdnPatchGuard({ llmo: null }, badRequest)).to.equal(null);
    expect(detectedCdnPatchGuard({ llmo: 'aem-cs-fastly' }, badRequest)).to.equal(null);
    expect(detectedCdnPatchGuard({ llmo: ['aem-cs-fastly'] }, badRequest)).to.equal(null);
  });

  it('returns null when llmo is present but does not set detectedCdn', () => {
    expect(detectedCdnPatchGuard({ llmo: { brand: 'Test' } }, badRequest)).to.equal(null);
  });

  it('accepts every allowed enum value', () => {
    for (const value of ALLOWED_DETECTED_CDNS) {
      expect(
        detectedCdnPatchGuard({ llmo: { detectedCdn: value } }, badRequest),
        `expected ${value} to be accepted`,
      ).to.equal(null);
    }
  });

  it('rejects an array value', () => {
    const result = detectedCdnPatchGuard(
      { llmo: { detectedCdn: ['aem-cs-fastly'] } },
      badRequest,
    );
    expect(result).to.not.equal(null);
    expect(result.error.status).to.equal(400);
    expect(result.error.message).to.contain('config.llmo.detectedCdn must be one of');
  });

  it('rejects a stringified array (prod marriottvacationclubs.com case)', () => {
    const result = detectedCdnPatchGuard(
      { llmo: { detectedCdn: '["Adobe-managed Fastly"]' } },
      badRequest,
    );
    expect(result).to.not.equal(null);
    expect(result.error.status).to.equal(400);
    expect(result.error.message).to.contain('config.llmo.detectedCdn must be one of');
  });

  it('rejects a human display name', () => {
    const result = detectedCdnPatchGuard(
      { llmo: { detectedCdn: 'Adobe-managed Fastly' } },
      badRequest,
    );
    expect(result).to.not.equal(null);
    expect(result.error.status).to.equal(400);
    expect(result.error.message).to.contain('config.llmo.detectedCdn must be one of');
  });

  it('rejects an empty string and null', () => {
    expect(detectedCdnPatchGuard({ llmo: { detectedCdn: '' } }, badRequest))
      .to.not.equal(null);
    expect(detectedCdnPatchGuard({ llmo: { detectedCdn: null } }, badRequest))
      .to.not.equal(null);
  });
});
