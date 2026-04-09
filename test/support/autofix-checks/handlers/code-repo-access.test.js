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
import codeRepoAccessHandler from '../../../../src/support/autofix-checks/handlers/code-repo-access.js';

describe('code-repo-access handler', () => {
  const makesite = (code) => ({ getCode: () => code });

  it('returns SKIPPED when site has no code config', () => {
    const result = codeRepoAccessHandler(makesite(null));

    expect(result.type).to.equal('code-repo-access');
    expect(result.status).to.equal('SKIPPED');
  });

  it('returns SKIPPED when code config has no type', () => {
    const result = codeRepoAccessHandler(makesite({}));

    expect(result.status).to.equal('SKIPPED');
  });

  it('returns FAILED for CM Standard repo (type="standard")', () => {
    const result = codeRepoAccessHandler(makesite({
      type: 'standard',
      url: 'https://github.com/cm/repo',
    }));

    expect(result.status).to.equal('FAILED');
    expect(result.message).to.include('standard');
    expect(result.details).to.equal('https://github.com/cm/repo');
  });

  it('returns FAILED for CM BYOG GitHub (type="github" with numeric owner+repo)', () => {
    const result = codeRepoAccessHandler(makesite({
      type: 'github',
      owner: '99552',
      repo: '12345',
    }));

    expect(result.status).to.equal('FAILED');
    expect(result.message).to.include('coming soon');
  });

  it('returns PASSED for AEMY GitHub (type="github" with string owner+repo)', () => {
    const result = codeRepoAccessHandler(makesite({
      type: 'github',
      owner: 'adobe',
      repo: 'my-site',
    }));

    expect(result.status).to.equal('PASSED');
  });

  it('returns PASSED for GitLab', () => {
    const result = codeRepoAccessHandler(makesite({ type: 'gitlab', owner: 'myorg', repo: 'myrepo' }));

    expect(result.status).to.equal('PASSED');
  });

  it('returns PASSED when owner is non-numeric even if repo is numeric', () => {
    const result = codeRepoAccessHandler(makesite({
      type: 'github',
      owner: 'adobe',
      repo: '99552',
    }));

    expect(result.status).to.equal('PASSED');
  });
});
