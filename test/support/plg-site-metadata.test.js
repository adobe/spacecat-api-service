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

/* eslint-env mocha */

import { expect } from 'chai';
import {
  extractSiteMetadataFromHtml,
  getPlgMetadataFetchUrl,
  normalizeMetaField,
  PLG_META_DESCRIPTION_MAX,
  PLG_META_TITLE_MAX,
} from '../../src/support/plg-site-metadata.js';

describe('plg-site-metadata', () => {
  describe('normalizeMetaField', () => {
    it('returns null for empty input', () => {
      expect(normalizeMetaField(null, 100)).to.be.null;
      expect(normalizeMetaField('', 100)).to.be.null;
    });

    it('strips angle-bracket chunks and collapses spaces', () => {
      expect(normalizeMetaField('  hello <b>world</b>  ', 100)).to.equal('hello world');
    });

    it('truncates to maxLen', () => {
      const long = 'x'.repeat(PLG_META_TITLE_MAX + 10);
      const out = normalizeMetaField(long, PLG_META_TITLE_MAX);
      expect(out?.length).to.equal(PLG_META_TITLE_MAX);
    });
  });

  describe('extractSiteMetadataFromHtml', () => {
    it('reads title and meta description', () => {
      const html = '<html><head><title>  My Title  </title>'
        + '<meta name="description" content="Desc here" /></head></html>';
      const { title, description } = extractSiteMetadataFromHtml(html);
      expect(title).to.equal('My Title');
      expect(description).to.equal('Desc here');
    });

    it('falls back to og tags', () => {
      const html = '<html><head>'
        + '<meta property="og:title" content="OG Title" />'
        + '<meta property="og:description" content="OG Desc" />'
        + '</head></html>';
      const { title, description } = extractSiteMetadataFromHtml(html);
      expect(title).to.equal('OG Title');
      expect(description).to.equal('OG Desc');
    });

    it('prefers title element over og:title when both exist', () => {
      const html = '<html><head><title>Real</title>'
        + '<meta property="og:title" content="OG" /></head></html>';
      expect(extractSiteMetadataFromHtml(html).title).to.equal('Real');
    });

    it('respects max lengths', () => {
      const longTitle = 't'.repeat(PLG_META_TITLE_MAX + 50);
      const longDesc = 'd'.repeat(PLG_META_DESCRIPTION_MAX + 50);
      const html = `<html><head><title>${longTitle}</title>`
        + `<meta name="description" content="${longDesc}" /></head></html>`;
      const { title, description } = extractSiteMetadataFromHtml(html);
      expect(title?.length).to.equal(PLG_META_TITLE_MAX);
      expect(description?.length).to.equal(PLG_META_DESCRIPTION_MAX);
    });
  });

  describe('getPlgMetadataFetchUrl', () => {
    it('uses overrideBaseURL from fetch config when set', () => {
      const site = {
        getBaseURL: () => 'https://example.com',
        getConfig: () => ({
          getFetchConfig: () => ({ overrideBaseURL: 'https://www.example.com' }),
        }),
      };
      expect(getPlgMetadataFetchUrl(site)).to.equal('https://www.example.com');
    });

    it('uses base URL when no override', () => {
      const site = {
        getBaseURL: () => 'https://example.com',
        getConfig: () => ({ getFetchConfig: () => ({}) }),
      };
      expect(getPlgMetadataFetchUrl(site)).to.equal('https://example.com');
    });
  });
});
