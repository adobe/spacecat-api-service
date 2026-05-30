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
  parseTargets, classify, extractClassificationMetadata, parseDestinations, classifyDestination,
} from '../../src/support/github-targets.js';

const VALID_DESTINATIONS = JSON.stringify({
  ghec: { match: { enterprise_slug: ['adobe-prd'] }, webhook_secret: 'whsec-ghec', reviewer_login: 'emu_reviewer' },
  'github-public': { match: { default: true }, webhook_secret: 'whsec-public', reviewer_login: 'MysticatBot' },
});

const VALID_TARGETS = JSON.stringify([
  {
    id: 'ghec', match: { enterpriseSlug: ['adobe-prd'] }, appSlug: 'mysticat-bot', reviewerLogin: 'emu_reviewer', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET_GHEC',
  },
  {
    id: 'github-public', match: { default: true }, appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET',
  },
]);

describe('github-targets parseTargets', () => {
  it('returns null when GITHUB_TARGETS is unset (legacy mode signal)', () => {
    expect(parseTargets({})).to.be.null;
  });

  it('parses a valid registry into an ordered array', () => {
    const targets = parseTargets({ GITHUB_TARGETS: VALID_TARGETS });
    expect(targets).to.have.length(2);
    expect(targets[0].id).to.equal('ghec');
    expect(targets[1].id).to.equal('github-public');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTargets({ GITHUB_TARGETS: 'not json' })).to.throw('not valid JSON');
  });

  it('throws when not a non-empty array', () => {
    expect(() => parseTargets({ GITHUB_TARGETS: '{}' })).to.throw('non-empty JSON array');
    expect(() => parseTargets({ GITHUB_TARGETS: '[]' })).to.throw('non-empty JSON array');
  });

  it('throws on duplicate ids', () => {
    const dup = JSON.stringify([
      {
        id: 'x', match: { enterpriseSlug: ['a'] }, appSlug: 's', reviewerLogin: 'r', webhookSecretEnvVar: 'V',
      },
      {
        id: 'x', match: { default: true }, appSlug: 's', webhookSecretEnvVar: 'W',
      },
    ]);
    expect(() => parseTargets({ GITHUB_TARGETS: dup })).to.throw('duplicate id');
  });

  it('throws when an entry is missing appSlug or webhookSecretEnvVar', () => {
    const noSlug = JSON.stringify([{ id: 'github-public', match: { default: true }, webhookSecretEnvVar: 'V' }]);
    expect(() => parseTargets({ GITHUB_TARGETS: noSlug })).to.throw('appSlug');
    const noSecret = JSON.stringify([{ id: 'github-public', match: { default: true }, appSlug: 's' }]);
    expect(() => parseTargets({ GITHUB_TARGETS: noSecret })).to.throw('webhookSecretEnvVar');
  });

  it('throws when an entry has neither default nor a non-empty enterpriseSlug', () => {
    const bad = JSON.stringify([{
      id: 'x', match: {}, appSlug: 's', webhookSecretEnvVar: 'V',
    }]);
    expect(() => parseTargets({ GITHUB_TARGETS: bad })).to.throw('match.default');
  });

  it('throws when the default entry is not last', () => {
    const defaultFirst = JSON.stringify([
      {
        id: 'github-public', match: { default: true }, appSlug: 's', webhookSecretEnvVar: 'V',
      },
      {
        id: 'ghec', match: { enterpriseSlug: ['a'] }, appSlug: 's', webhookSecretEnvVar: 'W',
      },
    ]);
    expect(() => parseTargets({ GITHUB_TARGETS: defaultFirst })).to.throw('must be last');
  });

  it('throws when there is not exactly one default', () => {
    const noDefault = JSON.stringify([{
      id: 'ghec', match: { enterpriseSlug: ['a'] }, appSlug: 's', reviewerLogin: 'r', webhookSecretEnvVar: 'V',
    }]);
    expect(() => parseTargets({ GITHUB_TARGETS: noDefault })).to.throw('exactly one');
  });

  it('throws when enterpriseSlug contains non-string entries', () => {
    const bad = JSON.stringify([
      {
        id: 'ghec', match: { enterpriseSlug: [123, null] }, appSlug: 's', webhookSecretEnvVar: 'V',
      },
      {
        id: 'github-public', match: { default: true }, appSlug: 's', webhookSecretEnvVar: 'W',
      },
    ]);
    expect(() => parseTargets({ GITHUB_TARGETS: bad })).to.throw('strings');
  });

  it('throws when webhookSecretEnvVar is not a valid env var name', () => {
    const bad = JSON.stringify([
      {
        id: 'github-public', match: { default: true }, appSlug: 's', webhookSecretEnvVar: '__proto__',
      },
    ]);
    expect(() => parseTargets({ GITHUB_TARGETS: bad })).to.throw('valid env var name');
  });

  it('throws when an entry is missing a string id', () => {
    const bad = JSON.stringify([{ match: { default: true }, appSlug: 's', webhookSecretEnvVar: 'V' }]);
    expect(() => parseTargets({ GITHUB_TARGETS: bad })).to.throw('missing a string "id"');
  });

  it('throws when an entry id is not a valid worker target_id', () => {
    const bad = JSON.stringify([{
      id: 'GitHub_Public', match: { default: true }, appSlug: 's', webhookSecretEnvVar: 'V',
    }]);
    expect(() => parseTargets({ GITHUB_TARGETS: bad })).to.throw('target_id');
  });
});

describe('github-targets parseTargets reviewerLogin', () => {
  const withReviewer = (reviewerLogin) => JSON.stringify([
    {
      id: 'ghec', match: { enterpriseSlug: ['adobe-prd'] }, appSlug: 'mysticat-bot', reviewerLogin, webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET_GHEC',
    },
    {
      id: 'github-public', match: { default: true }, appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET',
    },
  ]);

  it('parses reviewerLogin on a non-default entry', () => {
    const targets = parseTargets({ GITHUB_TARGETS: withReviewer('emu_reviewer') });
    expect(targets[0].reviewerLogin).to.equal('emu_reviewer');
  });

  it('accepts a slug[bot] reviewerLogin', () => {
    const targets = parseTargets({ GITHUB_TARGETS: withReviewer('some-app[bot]') });
    expect(targets[0].reviewerLogin).to.equal('some-app[bot]');
  });

  it('allows the default entry to omit reviewerLogin', () => {
    const targets = parseTargets({ GITHUB_TARGETS: withReviewer('emu_reviewer') });
    expect(targets[1].reviewerLogin).to.be.undefined;
  });

  it('throws when a non-default entry omits reviewerLogin', () => {
    const noReviewer = JSON.stringify([
      {
        id: 'ghec', match: { enterpriseSlug: ['adobe-prd'] }, appSlug: 's', webhookSecretEnvVar: 'V',
      },
      {
        id: 'github-public', match: { default: true }, appSlug: 's', webhookSecretEnvVar: 'W',
      },
    ]);
    expect(() => parseTargets({ GITHUB_TARGETS: noReviewer })).to.throw('reviewerLogin');
  });

  it('throws when reviewerLogin has an invalid charset', () => {
    expect(() => parseTargets({ GITHUB_TARGETS: withReviewer('bad login!') })).to.throw('reviewerLogin');
  });

  it('throws when reviewerLogin exceeds 64 chars', () => {
    expect(() => parseTargets({ GITHUB_TARGETS: withReviewer('a'.repeat(65)) })).to.throw('reviewerLogin');
  });
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

  it('throws when an entry has both default and enterprise_slug', () => {
    const bad = JSON.stringify({
      x: { match: { default: true, enterprise_slug: ['a'] }, webhook_secret: 's', reviewer_login: 'r' },
      'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'r' },
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

  it('accepts a slug[bot] reviewer_login', () => {
    const ok = JSON.stringify({
      'github-public': { match: { default: true }, webhook_secret: 's', reviewer_login: 'some-app[bot]' },
    });
    const dests = parseDestinations({ GITHUB_DESTINATIONS: ok });
    expect(dests['github-public'].reviewer_login).to.equal('some-app[bot]');
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
});

describe('github-targets classify', () => {
  const targets = parseTargets({ GITHUB_TARGETS: VALID_TARGETS });

  it('skips a positively non-github.com host', () => {
    expect(classify({ host: 'git.corp.adobe.com', enterpriseSlug: null }, targets)).to.deep.equal({ skip: true });
  });

  it('routes an EMU enterprise slug to ghec', () => {
    expect(classify({ host: 'github.com', enterpriseSlug: 'adobe-prd' }, targets)).to.deep.include({
      id: 'ghec', appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET_GHEC',
    });
  });

  it('routes a github.com body with no enterprise to github-public (catch-all)', () => {
    expect(classify({ host: 'github.com', enterpriseSlug: null }, targets).id).to.equal('github-public');
  });

  it('routes a github.com body with a NON-EMU enterprise slug to github-public', () => {
    expect(classify({ host: 'github.com', enterpriseSlug: 'some-other-enterprise' }, targets).id).to.equal('github-public');
  });

  it('routes a null host (ping / no repository) to github-public, NOT skip', () => {
    expect(classify({ host: null, enterpriseSlug: null }, targets).id).to.equal('github-public');
  });
});
