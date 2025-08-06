/*
 * Copyright 2024 Adobe. All rights reserved.
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
import * as sharedUtils from '@adobe/spacecat-shared-utils';
import { extractDomainFromUrl, getNormalizedUrl } from '../../src/support/utils.js';

// Mock SPACECAT_USER_AGENT
sinon.stub(sharedUtils, 'SPACECAT_USER_AGENT').value('SpaceCat/1.0');

describe('extractDomainFromUrl', () => {
  let log;
  let say;

  beforeEach(() => {
    log = {
      info: sinon.stub(),
      warn: sinon.stub(),
    };
    say = sinon.stub();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should return original URL when no paths, query, or hash are present', () => {
    const url = 'https://example.com';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal(url);
    expect(log.info.called).to.be.false;
    expect(log.warn.called).to.be.false;
  });

  it('should extract domain when URL has path', () => {
    const url = 'https://example.com/path/to/page';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal('https://example.com');
    expect(log.info.calledWith('URL had paths/query/hash, extracted domain: https://example.com')).to.be.true;
  });

  it('should extract domain when URL has query parameters', () => {
    const url = 'https://example.com?param=value&other=123';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal('https://example.com');
    expect(log.info.calledWith('URL had paths/query/hash, extracted domain: https://example.com')).to.be.true;
  });

  it('should extract domain when URL has hash fragment', () => {
    const url = 'https://example.com/page#section';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal('https://example.com');
    expect(log.info.calledWith('URL had paths/query/hash, extracted domain: https://example.com')).to.be.true;
  });

  it('should extract domain when URL has path, query, and hash', () => {
    const url = 'https://example.com/path?param=value#section';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal('https://example.com');
    expect(log.info.calledWith('URL had paths/query/hash, extracted domain: https://example.com')).to.be.true;
  });

  it('should handle root path correctly', () => {
    const url = 'https://example.com/';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal(url); // Root path should not trigger extraction
    expect(log.info.called).to.be.false;
  });

  it('should handle empty query and hash correctly', () => {
    const url = 'https://example.com?';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal('https://example.com');
    expect(log.info.calledWith('URL had paths/query/hash, extracted domain: https://example.com')).to.be.true;
  });

  it('should handle empty hash correctly', () => {
    const url = 'https://example.com#';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal('https://example.com');
    expect(log.info.calledWith('URL had paths/query/hash, extracted domain: https://example.com')).to.be.true;
  });

  it('should call say function when provided and URL has paths', () => {
    const url = 'https://example.com/path';
    const result = extractDomainFromUrl(url, log, say);

    expect(result).to.equal('https://example.com');
    expect(say.calledWith(':information_source: URL redirected to https://example.com/path, using domain: https://example.com')).to.be.true;
  });

  it('should not call say function when URL has no paths', () => {
    const url = 'https://example.com';
    const result = extractDomainFromUrl(url, log, say);

    expect(result).to.equal(url);
    expect(say.called).to.be.false;
  });

  it('should handle invalid URL gracefully', () => {
    const url = 'not-a-valid-url';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal(url);
    expect(log.warn.calledWith('Could not parse URL not-a-valid-url: Invalid URL')).to.be.true;
  });

  it('should handle URL with port', () => {
    const url = 'https://example.com:8080/path';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal('https://example.com:8080');
    expect(log.info.calledWith('URL had paths/query/hash, extracted domain: https://example.com:8080')).to.be.true;
  });

  it('should handle HTTP URLs', () => {
    const url = 'http://example.com/path';
    const result = extractDomainFromUrl(url, log);

    expect(result).to.equal('http://example.com');
    expect(log.info.calledWith('URL had paths/query/hash, extracted domain: http://example.com')).to.be.true;
  });
});

describe('getNormalizedUrl', () => {
  let log;
  let fetchStub;

  beforeEach(() => {
    log = {
      info: sinon.stub(),
      warn: sinon.stub(),
    };
    fetchStub = sinon.stub();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should return HTTPS URL when HEAD request succeeds', async () => {
    const mockResponse = {
      ok: true,
      url: 'https://example.com',
    };
    fetchStub.resolves(mockResponse);

    // Mock the global fetch
    global.fetch = fetchStub;

    const result = await getNormalizedUrl('http://example.com', 'desktop', log);

    expect(result).to.equal('https://example.com');
    expect(fetchStub.calledWith('http://example.com', {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Referer: 'https://www.adobe.com/',
        'User-Agent': 'SpaceCat/1.0',
      },
      method: 'HEAD',
    })).to.be.true;
  });

  it('should return HTTPS URL when GET request succeeds', async () => {
    const mockHeadResponse = {
      ok: false,
    };
    const mockGetResponse = {
      ok: true,
      url: 'https://example.com',
      headers: {
        get: sinon.stub().returns(null),
      },
    };
    fetchStub.onFirstCall().resolves(mockHeadResponse);
    fetchStub.onSecondCall().resolves(mockGetResponse);

    global.fetch = fetchStub;

    const result = await getNormalizedUrl('http://example.com', 'desktop', log);

    expect(result).to.equal('https://example.com');
    expect(fetchStub.callCount).to.equal(2);
  });

  it('should handle redirects', async () => {
    const mockResponse = {
      ok: true,
      url: 'https://redirected.example.com',
    };
    fetchStub.resolves(mockResponse);

    global.fetch = fetchStub;

    const result = await getNormalizedUrl('http://example.com', 'desktop', log);

    expect(result).to.equal('https://redirected.example.com');
  });

  it('should handle Location header redirects', async () => {
    const mockHeadResponse = {
      ok: false,
    };
    const mockGetResponse = {
      ok: true,
      url: 'https://example.com',
      headers: {
        get: sinon.stub().returns('https://redirected.example.com'),
      },
    };
    fetchStub.onFirstCall().resolves(mockHeadResponse);
    fetchStub.onSecondCall().resolves(mockGetResponse);

    global.fetch = fetchStub;

    const result = await getNormalizedUrl('http://example.com', 'desktop', log);

    expect(result).to.equal('https://redirected.example.com');
  });

  it('should handle recursive redirects', async () => {
    const mockResponse1 = {
      ok: false,
      url: 'https://redirect1.example.com',
    };
    const mockResponse2 = {
      ok: true,
      url: 'https://final.example.com',
    };
    fetchStub.onFirstCall().resolves(mockResponse1);
    fetchStub.onSecondCall().resolves(mockResponse2);

    global.fetch = fetchStub;

    const result = await getNormalizedUrl('http://example.com', 'desktop', log);

    expect(result).to.equal('https://final.example.com');
    expect(log.info.calledWith('Redirected to https://redirect1.example.com')).to.be.true;
  });

  it('should throw error when both HEAD and GET requests fail', async () => {
    const mockHeadResponse = {
      ok: false,
    };
    const mockGetResponse = {
      ok: false,
      status: 404,
    };
    fetchStub.onFirstCall().resolves(mockHeadResponse);
    fetchStub.onSecondCall().resolves(mockGetResponse);

    global.fetch = fetchStub;

    try {
      await getNormalizedUrl('http://example.com', 'desktop', log);
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error.message).to.include('HTTP error! status: 404');
    }
  });

  it('should handle fetch errors gracefully', async () => {
    fetchStub.rejects(new Error('Network error'));

    global.fetch = fetchStub;

    try {
      await getNormalizedUrl('http://example.com', 'desktop', log);
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error.message).to.include('Failed to retrieve URL (http://example.com): Network error');
    }
  });

  it('should handle invalid URL parsing', async () => {
    const mockResponse = {
      ok: true,
      url: 'https://example.com',
    };
    fetchStub.resolves(mockResponse);

    global.fetch = fetchStub;

    const result = await getNormalizedUrl('invalid-url', 'desktop', log);

    expect(result).to.equal('https://example.com');
    expect(log.warn.calledWith('Failed to parse URL invalid-url: Invalid URL')).to.be.true;
  });
});
