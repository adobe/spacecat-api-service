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

import { retrieveMainContent } from '../../../src/agents/org-detector/tools/main-content-retriever.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('org-detection-agent/main content retriever', () => {
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

    apiUrl = 'https://spacecat.com';
    apiKey = 'test-api-key';
  });

  afterEach(() => {
    nock.cleanAll();
    sandbox.restore();
  });

  it('returns null if scrape returns no data', async () => {
    // Arrange
    nock(apiUrl)
      .post('/scrape')
      .reply(200, null);

    // Act
    const result = await retrieveMainContent('https://spacecat.com', apiKey, apiUrl, context.log);

    // Assert
    expect(result).to.be.null;
  });

  it('returns null if the API content is empty', async () => {
    // Arrange
    nock(apiUrl)
      .post('/scrape')
      .reply(200, {
        results: [
          {
            content: '',
          },
        ],
      });

    // Act
    const result = await retrieveMainContent('https://spacecat.com', apiKey, apiUrl, context.log);

    // Assert
    expect(result).to.be.null;
    expect(context.log.info).to.have.been.calledWith('Could not retrieve the main content of URL: https://spacecat.com');
  });

  it('returns null if no <main> element is found', async () => {
    // Arrange
    nock(apiUrl)
      .post('/scrape')
      .reply(200, {
        results: [
          {
            content: '<html><body><h1>Header</h1></body></html>',
          },
        ],
      });

    // Act
    const result = await retrieveMainContent('https://spacecat.com', apiKey, apiUrl, context.log);

    // Assert
    expect(result).to.be.null;
    expect(context.log.info).to.have.been.calledWith('No `<main>` element found in the parsed content.');
  });

  it('returns trimmed text content of the main element', async () => {
    // Arrange
    const mainHtml = '<main>some content </main>';
    nock(apiUrl)
      .post('/scrape')
      .reply(200, {
        results: [
          {
            content: `<html><body>${mainHtml}</body></html>`,
          },
        ],
      });

    // Act
    const result = await retrieveMainContent('https://spacecat.com', apiKey, apiUrl, context.log);

    // Assert
    expect(result).to.equal('some content');
  });
});
