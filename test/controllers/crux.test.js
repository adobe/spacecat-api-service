/*
 * Copyright 2023 Adobe. All rights reserved.
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
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

describe('CRUX Controller', () => {
  const sandbox = sinon.createSandbox();
  const mockContext = {
    env: {
      CRUX_API_KEY: 'test-api-key',
    },
  };

  beforeEach(() => {
    sandbox.restore();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getCRUXDataByURL', () => {
    it('should throw error if context is not provided', async () => {
      const cruxControllerMock = await esmock('../../src/controllers/crux.js', {
        '../../src/support/crux-client.js': {
          fetchCruxData: sandbox.stub().resolves({}),
        },
      });

      expect(() => cruxControllerMock()).to.throw('Context required');
    });

    it('should throw error if CRUX_API_KEY is not set', async () => {
      const cruxControllerMock = await esmock('../../src/controllers/crux.js', {
        '../../src/support/crux-client.js': {
          fetchCruxData: sandbox.stub().resolves({}),
        },
      });

      const contextWithoutKey = { env: {} };
      const controller = cruxControllerMock(contextWithoutKey);
      return expect(controller.getCRUXDataByURL({ params: { url: 'https://example.com', formFactor: 'desktop' } }))
        .to.be.rejectedWith('CRUX_API_KEY is not set');
    });

    it('should return CRUX data for valid URL and form factor', async () => {
      const cruxControllerMock = await esmock('../../src/controllers/crux.js', {
        '../../src/support/crux-client.js': {
          fetchCruxData: sandbox.stub().resolves({
            key: { url: 'https://example.com', formFactor: 'DESKTOP' },
            metrics: {
              first_contentful_paint: { percentiles: { p75: 1000 } },
            },
          }),
        },
      });

      const controller = cruxControllerMock(mockContext);
      const result = await controller.getCRUXDataByURL({
        params: {
          url: 'https://example.com',
          formFactor: 'desktop',
        },
      });

      expect(result.ok).to.be.true;
      const resultData = await result.json();
      expect(resultData).to.deep.equal({
        key: { url: 'https://example.com', formFactor: 'DESKTOP' },
        metrics: {
          first_contentful_paint: { percentiles: { p75: 1000 } },
        },
      });
    });
  });
});
