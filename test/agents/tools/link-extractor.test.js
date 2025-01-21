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
import { extractLinks } from '../../../src/agents/org-detector/tools/link-extractor.js';

use(sinonChai);
use(chaiAsPromised);

const sandbox = sinon.createSandbox();

describe('org-detection-agent/link extractor', () => {
  let context;

  beforeEach('setup', () => {
    context = {
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns an empty array if HTML is invalid', () => {
    // Act
    const links = extractLinks('', 'https://spacecat.com', context.log);

    // Assert
    expect(context.log.error).to.have.been.calledWith(
      'Extract Links: Invalid HTML input. Expected a non-empty string.',
    );
    expect(links).to.deep.equal([]);
  });

  it('returns an empty array if domain is invalid', () => {
    // Act
    const links = extractLinks('<html></html>', '', context.log);

    // Assert
    expect(context.log.error).to.have.been.calledWith(
      'Extract Links: Invalid domain input. Expected a non-empty string.',
    );
    expect(links).to.deep.equal([]);
  });

  it('extracts full absolute links correctly', () => {
    // Arrange
    const html = `
      <html>
        <body>
          <a href="https://spacecat.com/path1">Link1</a>
          <a href="http://spacecat.com/path2">Link2</a>
          <a href="//someothersite.com/path3">Link3</a>
        </body>
      </html>
    `;

    // Act
    const links = extractLinks(html, 'https://spacecat.com', context.log);

    // Assert
    expect(links).to.deep.equal([
      'https://spacecat.com/path1',
      'http://spacecat.com/path2',
      'https://spacecat.com//someothersite.com/path3',
    ]);
    expect(context.log.info).to.have.been.calledWith(
      'Extract Links: Successfully extracted 3 links.',
    );
  });

  it('converts relative links correctly', () => {
    // Arrange
    const html = `
      <html>
        <body>
          <a href="/path1">Relative Link1</a>
          <a href="subpage">Relative Link2</a>
          <a>Broken Link3</a>
        </body>
      </html>
    `;

    // Act
    const links = extractLinks(html, 'https://spacecat.com', context.log);

    // Assert
    expect(links).to.deep.equal([
      'https://spacecat.com/path1',
      'https://spacecat.com/subpage',
    ]);
    expect(context.log.info).to.have.been.calledWith(
      'Extract Links: Successfully extracted 2 links.',
    );
  });

  it('continues extraction while skipping anchors with no href', () => {
    // Arrange
    const html = `
      <html>
        <body>
          <a href="#">Anchor with hash</a>
          <a>Missing href anchor</a>
          <a href="/path">Valid relative link</a>
        </body>
      </html>
    `;

    // Act
    const links = extractLinks(html, 'https://spacecat.com/', context.log);

    // Assert
    expect(links).to.deep.equal([
      'https://spacecat.com/#',
      'https://spacecat.com/path',
    ]);
    expect(context.log.info).to.have.been.calledWithMatch(/Successfully extracted 2 links/);
  });
});
