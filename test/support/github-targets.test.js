/*
 * Copyright 2025 Adobe. All rights reserved.
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
  extractClassificationMetadata, parseDestinations, classifyDestination,
} from '../../src/support/github-targets.js';

const VALID_DESTINATIONS = JSON.stringify({
  ghec: { match: { enterprise_slug: ['adobe-prd'] }, webhook_secret: 'whsec-ghec', reviewer_login: 'emu_reviewer' },
  'github-public': { match: { default: true }, webhook_secret: 'whsec-public', reviewer_login: 'MysticatBot' },
});

describe('github-targets parseDestinations', () => {
  it('returns null when GITHUB_DESTINATIONS is unset (legacy mode signal)', () => {
    expect(parseDestinations({})).to.be.null;
  });

  it('returns null when env is null (optional-chaining guard)', () => {
    expect(parseDestinations(null)).to.be.null;
  });

  it('parses a valid registry into a keyed object', () => {
    const dests = parseDestinations({ GITHUB_DESTINATIONS: VALID_DESTINATIONS });
    expect(dests).to.have.all.keys('ghec', 'github-public');
    expect(dests.ghec.webhook_secret).to.equal('whsec-ghec');
    expect(dests.ghec.reviewer_login).to.equal('emu_reviewer');
    expect(dests['github-public'].match).to.deep.equal({ default: true });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: 'not json' })).to.throw('not valid JSON');
  });

  it('throws when not a plain object (array)', () => {
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: '[]' })).to.throw('must be a non-empty JSON object');
  });

  it('throws when the object is empty', () => {
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: '{}' })).to.throw('must be a non-empty JSON object');
  });

  it('throws when a target_id key is not a valid worker target_id', () => {
    const bad = JSON.stringify({
      GitHub_Public: { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('target_id');
  });

  it('throws when an entry has both default and enterprise_slug (per-entry check)', () => {
    // Only one entry total, so the registry-level "exactly one default" check
    // does NOT fire first. The per-entry "exactly one of" check must catch it.
    const bad = JSON.stringify({
      x: { match: { default: true, enterprise_slug: ['a'] }, webhook_secret: 's', reviewer_login: 'r' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('exactly one');
  });

  it('throws when an entry has neither default nor a non-empty enterprise_slug', () => {
    const bad = JSON.stringify({
      x: { match: {}, webhook_secret: 's', reviewer_login: 'r' },
      'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('exactly one');
  });

  it('throws when enterprise_slug contains non-string entries', () => {
    const bad = JSON.stringify({
      ghec: { match: { enterprise_slug: [123, null] }, webhook_secret: 's', reviewer_login: 'r' },
      'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('strings');
  });

  it('throws when there is not exactly one default entry (zero)', () => {
    const noDefault = JSON.stringify({
      ghec: { match: { enterprise_slug: ['a'] }, webhook_secret: 's', reviewer_login: 'r' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: noDefault })).to.throw('exactly one');
  });

  it('throws when there is more than one default entry', () => {
    const twoDefaults = JSON.stringify({
      a: { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
      b: { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: twoDefaults })).to.throw('exactly one');
  });

  it('throws when webhook_secret is missing or empty', () => {
    const bad = JSON.stringify({
      'github-public': { match: { default: true }, webhook_secret: '', reviewer_login: 'r' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('webhook_secret');
  });

  it('throws when reviewer_login is missing', () => {
    const bad = JSON.stringify({
      'github-public': { match: { default: true }, webhook_secret: 's' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('reviewer_login');
  });

  it('throws when reviewer_login has an invalid charset', () => {
    const bad = JSON.stringify({
      'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'bad login!' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('reviewer_login');
  });

  it('throws when reviewer_login exceeds 64 chars', () => {
    const bad = JSON.stringify({
      'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'a'.repeat(65) },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('reviewer_login');
  });

  it('throws when two entries share the same enterprise_slug value', () => {
    const dupSlug = JSON.stringify({
      ghec1: { match: { enterprise_slug: ['adobe-prd', 'shared-slug'] }, webhook_secret: 's1', reviewer_login: 'r1' },
      ghec2: { match: { enterprise_slug: ['shared-slug'] }, webhook_secret: 's2', reviewer_login: 'r2' },
      'github-public': { match: { default: true }, webhook_secret: 's3', reviewer_login: 'r3' },
    });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: dupSlug })).to.throw('shared-slug');
  });

  it('accepts a slug[bot] reviewer_login', () => {
    const ok = JSON.stringify({
      'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'some-app[bot]' },
    });
    const dests = parseDestinations({ GITHUB_DESTINATIONS: ok });
    expect(dests['github-public'].reviewer_login).to.equal('some-app[bot]');
  });

  it('throws when an entry is not an object', () => {
    const bad = JSON.stringify({ 'github-public': 'not-an-object' });
    expect(() => parseDestinations({ GITHUB_DESTINATIONS: bad })).to.throw('must be an object');
  });
});

describe('github-targets extractClassificationMetadata', () => {
  it('returns null for non-JSON', () => {
    expect(extractClassificationMetadata('not json')).to.be.null;
  });

  it('extracts host and enterpriseSlug from a github.com enterprise body', () => {
    const body = JSON.stringify({
      enterprise: { slug: 'adobe-prd' },
      repository: { html_url: 'https://github.com/Adobe-AEM-Sites/aem-sites-architecture' },
    });
    expect(extractClassificationMetadata(body)).to.deep.equal({ host: 'github.com', enterpriseSlug: 'adobe-prd' });
  });

  it('returns host=null when repository.html_url is absent (e.g. ping)', () => {
    const body = JSON.stringify({ zen: 'Keep it simple', hook_id: 1 });
    expect(extractClassificationMetadata(body)).to.deep.equal({ host: null, enterpriseSlug: null });
  });

  it('returns host of a non-github.com html_url', () => {
    const body = JSON.stringify({ repository: { html_url: 'https://git.corp.adobe.com/experience-platform/mystique' } });
    expect(extractClassificationMetadata(body).host).to.equal('git.corp.adobe.com');
  });

  it('returns null for valid JSON that is not an object', () => {
    expect(extractClassificationMetadata('123')).to.be.null;
    expect(extractClassificationMetadata('null')).to.be.null;
  });

  it('returns host=null for a malformed repository.html_url', () => {
    const body = JSON.stringify({ repository: { html_url: 'not-a-valid-url' } });
    expect(extractClassificationMetadata(body).host).to.be.null;
  });
});

describe('github-targets classifyDestination', () => {
  const destinations = parseDestinations({ GITHUB_DESTINATIONS: VALID_DESTINATIONS });

  it('skips a positively non-github.com host', () => {
    expect(classifyDestination({ host: 'git.corp.adobe.com', enterpriseSlug: null }, destinations))
      .to.deep.equal({ skip: true });
  });

  it('routes an EMU enterprise slug to ghec with its inline secret + reviewer', () => {
    const result = classifyDestination({ host: 'github.com', enterpriseSlug: 'adobe-prd' }, destinations);
    expect(result).to.deep.include({
      target_id: 'ghec', webhook_secret: 'whsec-ghec', reviewer_login: 'emu_reviewer',
    });
  });

  it('routes a github.com body with no enterprise to github-public (default catch-all)', () => {
    expect(classifyDestination({ host: 'github.com', enterpriseSlug: null }, destinations).target_id)
      .to.equal('github-public');
  });

  it('routes a github.com body with a NON-EMU enterprise slug to github-public', () => {
    expect(classifyDestination({ host: 'github.com', enterpriseSlug: 'some-other-enterprise' }, destinations).target_id)
      .to.equal('github-public');
  });

  it('routes a null host (ping / no repository) to github-public, NOT skip', () => {
    expect(classifyDestination({ host: null, enterpriseSlug: null }, destinations).target_id)
      .to.equal('github-public');
  });

  it('prefers an enterprise match over the default even when both could apply', () => {
    // Match rules are mutually exclusive by construction; this asserts the
    // enterprise branch is evaluated before the default branch.
    const result = classifyDestination({ host: 'github.com', enterpriseSlug: 'adobe-prd' }, destinations);
    expect(result.target_id).to.equal('ghec');
  });

  it('returns an object with exactly the keys target_id, webhook_secret, reviewer_login (no leakage)', () => {
    // Contract lock: a successful classification MUST NOT leak internal fields
    // such as match or any future entry property. Sorted comparison is stable.
    const result = classifyDestination({ host: 'github.com', enterpriseSlug: 'adobe-prd' }, destinations);
    expect(Object.keys(result).sort()).to.deep.equal(['reviewer_login', 'target_id', 'webhook_secret']);
  });

  it('returns { skip: true } when no default entry exists (defensive backstop for an unvalidated registry)', () => {
    // parseDestinations guarantees exactly one default, so this only happens
    // when classifyDestination is handed a hand-built registry. A github.com
    // host with no enterprise match and no default must skip, not throw.
    const noDefault = { ghec: { match: { enterprise_slug: ['adobe-prd'] }, webhook_secret: 's', reviewer_login: 'r' } };
    expect(classifyDestination({ host: 'github.com', enterpriseSlug: null }, noDefault))
      .to.deep.equal({ skip: true });
  });
});
