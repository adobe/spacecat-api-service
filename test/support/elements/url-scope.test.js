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
  splitScope,
  parseCandidateUrl,
  hostMatches,
  isWithinPathPrefix,
  scopeContains,
  isProperAncestor,
  createScopeMatcher,
} from '../../../src/support/elements/url-scope.js';

describe('url-scope', () => {
  describe('splitScope', () => {
    it('parses a bare host', () => {
      expect(splitScope('intuit.com')).to.deep.equal({ host: 'intuit.com', pathPrefix: '' });
    });

    it('parses a subdomain host', () => {
      expect(splitScope('quickbooks.intuit.com'))
        .to.deep.equal({ host: 'quickbooks.intuit.com', pathPrefix: '' });
    });

    it('parses a host/path scope', () => {
      expect(splitScope('nba.com/kings')).to.deep.equal({ host: 'nba.com', pathPrefix: '/kings' });
    });

    it('parses a full URL, stripping www and the trailing slash', () => {
      expect(splitScope('https://www.nba.com/kings/'))
        .to.deep.equal({ host: 'nba.com', pathPrefix: '/kings' });
    });

    it('lowercases the host and the path prefix', () => {
      expect(splitScope('WWW.NBA.com/Kings'))
        .to.deep.equal({ host: 'nba.com', pathPrefix: '/kings' });
    });

    it('returns null for empty, whitespace-only, and non-string input', () => {
      expect(splitScope('')).to.be.null;
      expect(splitScope('   ')).to.be.null;
      expect(splitScope(undefined)).to.be.null;
      expect(splitScope(null)).to.be.null;
    });

    it('returns null for a bare path (no host)', () => {
      expect(splitScope('/just/a/path')).to.be.null;
    });

    it('returns null when stripping www leaves no host', () => {
      expect(splitScope('www.')).to.be.null;
    });

    it('drops repeated trailing slashes from the path prefix', () => {
      expect(splitScope('nba.com/kings//')).to.deep.equal({ host: 'nba.com', pathPrefix: '/kings' });
    });
  });

  describe('parseCandidateUrl', () => {
    it('extracts host and pathname, stripping www and lowercasing', () => {
      expect(parseCandidateUrl('https://WWW.NBA.com/Kings/Roster'))
        .to.deep.equal({ host: 'nba.com', pathname: '/kings/roster' });
    });

    it('trims trailing slashes from a non-root pathname', () => {
      expect(parseCandidateUrl('https://nba.com/kings/'))
        .to.deep.equal({ host: 'nba.com', pathname: '/kings' });
      expect(parseCandidateUrl('https://nba.com/kings//'))
        .to.deep.equal({ host: 'nba.com', pathname: '/kings' });
    });

    it('reduces the root pathname to the empty string (whole-host form)', () => {
      expect(parseCandidateUrl('https://nba.com/'))
        .to.deep.equal({ host: 'nba.com', pathname: '' });
    });

    it('returns null for an unparseable value', () => {
      expect(parseCandidateUrl('not a url')).to.be.null;
    });
  });

  describe('hostMatches', () => {
    it('matches the host itself and its subdomains', () => {
      expect(hostMatches('openai.com', 'openai.com')).to.be.true;
      expect(hostMatches('help.openai.com', 'openai.com')).to.be.true;
    });

    it('rejects lookalike and unrelated hosts', () => {
      expect(hostMatches('notopenai.com', 'openai.com')).to.be.false;
      expect(hostMatches('reddit.com', 'openai.com')).to.be.false;
    });
  });

  describe('isWithinPathPrefix', () => {
    it('matches everything under an empty prefix', () => {
      expect(isWithinPathPrefix('', '')).to.be.true;
      expect(isWithinPathPrefix('/', '')).to.be.true;
      expect(isWithinPathPrefix('/anything', '')).to.be.true;
    });

    it('matches the prefix itself and deeper segments', () => {
      expect(isWithinPathPrefix('/kings', '/kings')).to.be.true;
      expect(isWithinPathPrefix('/kings/roster', '/kings')).to.be.true;
    });

    it('rejects a sibling path that only shares the prefix string', () => {
      expect(isWithinPathPrefix('/kingsx', '/kings')).to.be.false;
      expect(isWithinPathPrefix('/celtics', '/kings')).to.be.false;
    });
  });

  describe('scopeContains', () => {
    const scope = { host: 'nba.com', pathPrefix: '/kings' };

    it('contains candidates on the host (and subdomains) within the path prefix', () => {
      expect(scopeContains(scope, { host: 'nba.com', pathname: '/kings/roster' })).to.be.true;
      expect(scopeContains(scope, { host: 'shop.nba.com', pathname: '/kings' })).to.be.true;
    });

    it('rejects candidates outside the path prefix or on another host', () => {
      expect(scopeContains(scope, { host: 'nba.com', pathname: '/celtics' })).to.be.false;
      expect(scopeContains(scope, { host: 'espn.com', pathname: '/kings' })).to.be.false;
    });
  });

  describe('isProperAncestor', () => {
    it('recognizes a parent domain as ancestor of a subdomain site', () => {
      expect(isProperAncestor(
        { host: 'intuit.com', pathPrefix: '' },
        { host: 'quickbooks.intuit.com', pathPrefix: '' },
      )).to.be.true;
    });

    it('recognizes the host root as ancestor of a subpath site', () => {
      expect(isProperAncestor(
        { host: 'nba.com', pathPrefix: '' },
        { host: 'nba.com', pathPrefix: '/kings' },
      )).to.be.true;
    });

    it('is false for the scope itself', () => {
      expect(isProperAncestor(
        { host: 'nba.com', pathPrefix: '/kings' },
        { host: 'nba.com', pathPrefix: '/kings' },
      )).to.be.false;
    });

    it('is false when the requested scope is narrower than the site scope', () => {
      expect(isProperAncestor(
        { host: 'quickbooks.intuit.com', pathPrefix: '' },
        { host: 'intuit.com', pathPrefix: '' },
      )).to.be.false;
      expect(isProperAncestor(
        { host: 'nba.com', pathPrefix: '/kings' },
        { host: 'nba.com', pathPrefix: '' },
      )).to.be.false;
    });

    it('is false for unrelated hosts and non-boundary path overlaps', () => {
      expect(isProperAncestor(
        { host: 'espn.com', pathPrefix: '' },
        { host: 'nba.com', pathPrefix: '/kings' },
      )).to.be.false;
      expect(isProperAncestor(
        { host: 'nba.com', pathPrefix: '/ki' },
        { host: 'nba.com', pathPrefix: '/kings' },
      )).to.be.false;
    });
  });

  describe('createScopeMatcher', () => {
    const siteSubdomain = { host: 'quickbooks.intuit.com', pathPrefix: '' };
    const siteSubpath = { host: 'nba.com', pathPrefix: '/kings' };

    it('excludes the site subtree from an ancestor-domain fold (subdomain site)', () => {
      const matches = createScopeMatcher({ host: 'intuit.com', pathPrefix: '' }, siteSubdomain);
      expect(matches({ host: 'turbotax.intuit.com', pathname: '/x' })).to.be.true;
      expect(matches({ host: 'intuit.com', pathname: '/' })).to.be.true;
      expect(matches({ host: 'quickbooks.intuit.com', pathname: '/x' })).to.be.false;
      expect(matches({ host: 'help.quickbooks.intuit.com', pathname: '/y' })).to.be.false;
    });

    it('excludes the site subtree from the host-root fold (subpath site)', () => {
      const matches = createScopeMatcher({ host: 'nba.com', pathPrefix: '' }, siteSubpath);
      expect(matches({ host: 'nba.com', pathname: '/celtics' })).to.be.true;
      expect(matches({ host: 'nba.com', pathname: '/kingsx' })).to.be.true;
      expect(matches({ host: 'nba.com', pathname: '/kings' })).to.be.false;
      expect(matches({ host: 'nba.com', pathname: '/kings/roster' })).to.be.false;
    });

    it('returns exactly the site subtree when the site scope itself is requested', () => {
      const matchesPath = createScopeMatcher(siteSubpath, siteSubpath);
      expect(matchesPath({ host: 'nba.com', pathname: '/kings/roster' })).to.be.true;
      expect(matchesPath({ host: 'nba.com', pathname: '/celtics' })).to.be.false;
      const matchesHost = createScopeMatcher(siteSubdomain, siteSubdomain);
      expect(matchesHost({ host: 'help.quickbooks.intuit.com', pathname: '/x' })).to.be.true;
      expect(matchesHost({ host: 'turbotax.intuit.com', pathname: '/x' })).to.be.false;
    });

    it('applies the plain fold when there is no site scope', () => {
      const matches = createScopeMatcher({ host: 'intuit.com', pathPrefix: '' }, null);
      expect(matches({ host: 'quickbooks.intuit.com', pathname: '/x' })).to.be.true;
      expect(matches({ host: 'reddit.com', pathname: '/x' })).to.be.false;
    });

    it('leaves third-party scopes unaffected by the site scope', () => {
      const matches = createScopeMatcher({ host: 'cambridge.org', pathPrefix: '' }, siteSubpath);
      expect(matches({ host: 'dictionary.cambridge.org', pathname: '/de' })).to.be.true;
    });

    it('narrows a path-bearing third-party scope by its own path prefix', () => {
      const matches = createScopeMatcher({ host: 'cambridge.org', pathPrefix: '/dictionary' }, siteSubpath);
      expect(matches({ host: 'www2.cambridge.org', pathname: '/dictionary/english' })).to.be.true;
      expect(matches({ host: 'cambridge.org', pathname: '/press' })).to.be.false;
    });
  });
});
