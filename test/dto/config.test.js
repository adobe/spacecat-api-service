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

import { expect } from 'chai';
import sinon from 'sinon';
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

import { ConfigDto } from '../../src/dto/config.js';

describe('ConfigDto', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('returns null when config is nullish', () => {
    expect(ConfigDto.toJSON(null)).to.equal(null);
    expect(ConfigDto.toJSON(undefined)).to.equal(null);
  });

  it('returns sanitized config without brandProfile', () => {
    const fakeConfig = {
      foo: 'bar',
    };
    const toJSONStub = sinon.stub(Config, 'toDynamoItem').returns({
      foo: 'bar',
      brandProfile: { discovery: {} },
    });

    const result = ConfigDto.toJSON(fakeConfig);

    expect(result).to.deep.equal({ foo: 'bar' });
    expect(toJSONStub.calledOnceWithExactly(fakeConfig)).to.be.true;
  });
});
