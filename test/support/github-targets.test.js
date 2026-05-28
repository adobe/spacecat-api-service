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
import { parseTargets, classify, extractClassificationMetadata } from '../../src/support/github-targets.js';

const VALID_TARGETS = JSON.stringify([
  {
    id: 'ghec', match: { enterpriseSlug: ['adobe-prd'] }, appSlug: 'mysticat-bot', webhookSecretEnvVar: 'GITHUB_WEBHOOK_SECRET_GHEC',
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
        id: 'x', match: { enterpriseSlug: ['a'] }, appSlug: 's', webhookSecretEnvVar: 'V',
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
      id: 'ghec', match: { enterpriseSlug: ['a'] }, appSlug: 's', webhookSecretEnvVar: 'V',
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

describe('github-targets classify', () => {
  const targets = parseTargets({ GITHUB_TARGETS: VALID_TARGETS });

  it('skips a positively non-github.com host', () => {
    expect(classify({ host: 'git.corp.adobe.com', enterpriseSlug: null }, targets)).to.deep.equal({ skip: true });
  });

  it('routes an EMU enterprise slug to ghec', () => {
    expect(classify({ host: 'github.com', enterpriseSlug: 'adobe-prd' }, targets).id).to.equal('ghec');
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
