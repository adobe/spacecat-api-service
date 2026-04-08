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

/* eslint-env mocha */

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import nock from 'nock';
import {
  parseHlxRSO,
  fetchHlxConfig,
  getContentSource,
  resolveHlxConfigFromGitHubURL,
} from '../../src/support/hlx-config.js';

use(sinonChai);

describe('hlx-config', () => {
  const log = {
    info: sinon.stub(),
    error: sinon.stub(),
    warn: sinon.stub(),
    debug: sinon.stub(),
  };

  afterEach(() => {
    nock.cleanAll();
    sinon.resetHistory();
  });

  describe('parseHlxRSO', () => {
    it('should parse a valid aem.live domain', () => {
      const result = parseHlxRSO('main--bufferin--lion-corporation.aem.live');
      expect(result).to.deep.equal({
        ref: 'main', site: 'bufferin', owner: 'lion-corporation', tld: 'aem.live',
      });
    });

    it('should parse a valid hlx.live domain', () => {
      const result = parseHlxRSO('main--site--owner.hlx.live');
      expect(result).to.deep.equal({
        ref: 'main', site: 'site', owner: 'owner', tld: 'hlx.live',
      });
    });

    it('should return null for non-matching domain', () => {
      expect(parseHlxRSO('www.example.com')).to.be.null;
    });

    it('should return null for partial match', () => {
      expect(parseHlxRSO('main--site.aem.live')).to.be.null;
    });
  });

  describe('fetchHlxConfig', () => {
    it('should return config from admin API on 200', async () => {
      nock('https://admin.hlx.page')
        .get('/config/owner/aggregated/site.json')
        .reply(200, { cdn: { prod: { host: 'test.aem.live' } } });

      const hlxConfig = { hlxVersion: 5, rso: { owner: 'owner', site: 'site' } };
      const result = await fetchHlxConfig(hlxConfig, 'token', log);
      expect(result).to.deep.equal({ cdn: { prod: { host: 'test.aem.live' } } });
    });

    it('should return null on 404', async () => {
      nock('https://admin.hlx.page')
        .get('/config/owner/aggregated/site.json')
        .reply(404);

      const hlxConfig = { hlxVersion: 5, rso: { owner: 'owner', site: 'site' } };
      const result = await fetchHlxConfig(hlxConfig, 'token', log);
      expect(result).to.be.null;
    });

    it('should return null and log error on non-200/non-404 status', async () => {
      nock('https://admin.hlx.page')
        .get('/config/owner/aggregated/site.json')
        .reply(500, 'Internal Server Error', { 'x-error': 'something broke' });

      const hlxConfig = { hlxVersion: 5, rso: { owner: 'owner', site: 'site' } };
      const result = await fetchHlxConfig(hlxConfig, 'token', log);
      expect(result).to.be.null;
      expect(log.error).to.have.been.called;
    });

    it('should return null and log error on network failure', async () => {
      nock('https://admin.hlx.page')
        .get('/config/owner/aggregated/site.json')
        .replyWithError('connection refused');

      const hlxConfig = { hlxVersion: 5, rso: { owner: 'owner', site: 'site' } };
      const result = await fetchHlxConfig(hlxConfig, 'token', log);
      expect(result).to.be.null;
      expect(log.error).to.have.been.called;
    });

    it('should skip for hlxVersion < 5', async () => {
      const hlxConfig = { hlxVersion: 4, rso: { owner: 'owner', site: 'site' } };
      const result = await fetchHlxConfig(hlxConfig, 'token', log);
      expect(result).to.be.null;
    });
  });

  describe('getContentSource', () => {
    it('should parse onedrive content source from fstab.yaml', async () => {
      nock('https://raw.githubusercontent.com')
        .get('/owner/repo/main/fstab.yaml')
        .reply(200, 'mountpoints:\n  /: https://adobe.sharepoint.com/sites/test');

      const hlxConfig = { rso: { ref: 'main', site: 'repo', owner: 'owner' } };
      const result = await getContentSource(hlxConfig, log);
      expect(result).to.deep.equal({
        source: { type: 'onedrive', url: 'https://adobe.sharepoint.com/sites/test' },
      });
    });

    it('should parse google drive content source from fstab.yaml', async () => {
      nock('https://raw.githubusercontent.com')
        .get('/owner/repo/main/fstab.yaml')
        .reply(200, 'mountpoints:\n  /: https://drive.google.com/drive/folders/abc');

      const hlxConfig = { rso: { ref: 'main', site: 'repo', owner: 'owner' } };
      const result = await getContentSource(hlxConfig, log);
      expect(result.source.type).to.equal('drive.google');
    });

    it('should return null when mountpoint URL is invalid', async () => {
      nock('https://raw.githubusercontent.com')
        .get('/owner/repo/main/fstab.yaml')
        .reply(200, 'mountpoints:\n  /: not-a-valid-url');

      const hlxConfig = { rso: { ref: 'main', site: 'repo', owner: 'owner' } };
      const result = await getContentSource(hlxConfig, log);
      expect(result).to.be.null;
      expect(log.debug).to.have.been.called;
    });

    it('should return null when fstab.yaml has no mountpoints', async () => {
      nock('https://raw.githubusercontent.com')
        .get('/owner/repo/main/fstab.yaml')
        .reply(200, 'folders:\n  /: /content/dam');

      const hlxConfig = { rso: { ref: 'main', site: 'repo', owner: 'owner' } };
      const result = await getContentSource(hlxConfig, log);
      expect(result).to.be.null;
    });

    it('should return null when fstab.yaml not found', async () => {
      nock('https://raw.githubusercontent.com')
        .get('/owner/repo/main/fstab.yaml')
        .reply(404);

      const hlxConfig = { rso: { ref: 'main', site: 'repo', owner: 'owner' } };
      const result = await getContentSource(hlxConfig, log);
      expect(result).to.be.null;
    });
  });

  describe('resolveHlxConfigFromGitHubURL', () => {
    it('should resolve full config when admin API returns data', async () => {
      nock('https://admin.hlx.page')
        .get('/config/adobe/aggregated/test-repo.json')
        .reply(200, {
          cdn: { prod: { host: 'main--test-repo--adobe.aem.live' } },
          code: { owner: 'adobe', repo: 'test-repo' },
          content: { source: { type: 'onedrive', url: 'https://sharepoint.com/test' } },
        });

      const result = await resolveHlxConfigFromGitHubURL(
        'https://github.com/adobe/test-repo',
        'token',
        log,
      );

      expect(result.hlxConfig.rso).to.deep.equal({
        ref: 'main', site: 'test-repo', owner: 'adobe', tld: 'aem.live',
      });
      expect(result.hlxConfig.cdn).to.be.an('object');
      expect(result.hlxConfig.code).to.be.an('object');
      expect(result.code).to.deep.equal({
        type: 'github', owner: 'adobe', repo: 'test-repo', ref: 'main', url: 'https://github.com/adobe/test-repo',
      });
    });

    it('should fall back to fstab when admin API returns 404', async () => {
      nock('https://admin.hlx.page')
        .get('/config/adobe/aggregated/test-repo.json')
        .reply(404);

      nock('https://raw.githubusercontent.com')
        .get('/adobe/test-repo/main/fstab.yaml')
        .reply(200, 'mountpoints:\n  /: https://adobe.sharepoint.com/sites/test');

      const result = await resolveHlxConfigFromGitHubURL(
        'https://github.com/adobe/test-repo',
        'token',
        log,
      );

      expect(result.hlxConfig.rso).to.deep.equal({ owner: 'adobe', site: 'test-repo', ref: 'main' });
      expect(result.hlxConfig.content.source.type).to.equal('onedrive');
    });

    it('should return basic config when both APIs fail', async () => {
      nock('https://admin.hlx.page')
        .get('/config/adobe/aggregated/test-repo.json')
        .reply(404);

      nock('https://raw.githubusercontent.com')
        .get('/adobe/test-repo/main/fstab.yaml')
        .reply(404);

      const result = await resolveHlxConfigFromGitHubURL(
        'https://github.com/adobe/test-repo',
        'token',
        log,
      );

      expect(result.hlxConfig.rso).to.deep.equal({ owner: 'adobe', site: 'test-repo', ref: 'main' });
      expect(result.hlxConfig.content).to.be.undefined;
      expect(result.code.type).to.equal('github');
    });

    it('should handle fstab.yaml fetch throwing an error', async () => {
      nock('https://admin.hlx.page')
        .get('/config/adobe/aggregated/test-repo.json')
        .reply(404);

      nock('https://raw.githubusercontent.com')
        .get('/adobe/test-repo/main/fstab.yaml')
        .replyWithError('network timeout');

      const result = await resolveHlxConfigFromGitHubURL(
        'https://github.com/adobe/test-repo',
        'token',
        log,
      );

      expect(result.hlxConfig.rso).to.deep.equal({ owner: 'adobe', site: 'test-repo', ref: 'main' });
      expect(result.hlxConfig.content).to.be.undefined;
      expect(result.code.type).to.equal('github');
      expect(log.error).to.have.been.called;
    });
  });
});
