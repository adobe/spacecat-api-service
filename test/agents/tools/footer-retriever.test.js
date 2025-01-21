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
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import nock from 'nock';

import { retrieveFooter } from '../../../src/agents/org-detector/tools/footer-retriever.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('org-detection-agent/footer retriever', () => {
  let context;
  let apiUrl;
  let apiKey;

  beforeEach('setup', () => {
    context = {
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
      },
    };

    apiUrl = 'https://fake-scrape-api.com';
    apiKey = 'test-api-key';
  });

  afterEach(() => {
    nock.cleanAll();
    sandbox.restore();
  });

  it('returns null if the scrape API returns a non-OK response', async () => {
    // Arrange
    nock(apiUrl)
      .post('/scrape')
      .reply(500);

    // Act
    const result = await retrieveFooter('https://spacecat.com', apiKey, apiUrl, context.log);

    // Assert
    expect(result).to.be.null;
  });

  it('returns null if scrape api response is empty', async () => {
    // Arrange
    nock(apiUrl)
      .post('/scrape')
      .reply(200, null);

    // Act
    const result = await retrieveFooter('spacecat.com', apiKey, apiUrl, context.log);

    // Assert
    expect(result).to.be.null;
  });

  it('returns null if footer is not found in the content', async () => {
    // Arrange
    nock(apiUrl)
      .post('/scrape')
      .reply(200, {
        results: [
          {
            content: '<div>No footer here</div>',
          },
        ],
      });

    // Act
    const result = await retrieveFooter('spacecat.com', apiKey, apiUrl, context.log);

    // Assert
    expect(result).to.be.null;
  });

  it('returns null if scrape api content field is null', async () => {
    // Arrange
    nock(apiUrl)
      .post('/scrape')
      .reply(200, {
        results: [
          {
            content: null,
          },
        ],
      });

    // Act
    const result = await retrieveFooter('spacecat.com', apiKey, apiUrl, context.log);

    // Assert
    expect(result).to.be.null;
  });

  it('returns the <footer> element when found', async () => {
    // Arrange
    const footerHtml = '<footer>Some site footer content</footer>';
    nock(apiUrl)
      .post('/scrape')
      .reply(200, {
        results: [
          {
            content: `<div>Header</div>${footerHtml}<div>More content</div><footer>Some site footer content</footer>`,
          },
        ],
      });

    // Act
    const result = await retrieveFooter('blog.spacecat.com', apiKey, apiUrl, context.log);

    // Assert
    expect(result).to.equal(footerHtml);
  });
});
