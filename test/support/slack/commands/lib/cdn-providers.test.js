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
  DAILY_ONLY_CDN_FAMILIES,
  SERVICE_PROVIDER_TO_CDN_FAMILY,
  getCdnFamily,
  normalizeProvider,
} from '../../../../../src/support/slack/commands/lib/cdn-providers.js';

describe('cdn-providers', () => {
  it('normalizes providers and falls back to "unknown"', () => {
    expect(normalizeProvider('  Fastly  ')).to.equal('fastly');
    expect(normalizeProvider('')).to.equal('unknown');
    expect(normalizeProvider(null)).to.equal('unknown');
  });

  it('maps every service-provider key in the canonical table to its family', () => {
    expect(Object.keys(SERVICE_PROVIDER_TO_CDN_FAMILY)).to.have.lengthOf(11);
    Object.entries(SERVICE_PROVIDER_TO_CDN_FAMILY).forEach(([provider, family]) => {
      expect(getCdnFamily(provider), `getCdnFamily(${provider})`).to.equal(family);
    });
  });

  it('detects CDN family from free-form provider names', () => {
    [
      ['Amazon CloudFront', 'cloudfront'],
      ['Azure FrontDoor', 'frontdoor'],
      ['Akamai Edge', 'akamai'],
      ['Imperva WAF', 'imperva'],
      ['Incapsula', 'imperva'],
      ['cloudflare', 'cloudflare'],
      ['fastly', 'fastly'],
    ].forEach(([raw, family]) => {
      expect(getCdnFamily(raw), `getCdnFamily(${raw})`).to.equal(family);
    });
  });

  it('returns the normalized name for unknown providers', () => {
    expect(getCdnFamily('some-mystery-cdn')).to.equal('some-mystery-cdn');
    expect(getCdnFamily(null)).to.equal('unknown');
  });

  it('flags cloudflare, imperva, and other as daily-only families', () => {
    expect(DAILY_ONLY_CDN_FAMILIES.has('cloudflare')).to.be.true;
    expect(DAILY_ONLY_CDN_FAMILIES.has('imperva')).to.be.true;
    expect(DAILY_ONLY_CDN_FAMILIES.has('other')).to.be.true;
    expect(DAILY_ONLY_CDN_FAMILIES.has('fastly')).to.be.false;
  });
});
