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
import { validateRepoUrl, checkBodySize } from '../../src/utils/validations.js';

// Helper to build Uint8Array of given length
function makeBytes(len) {
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    arr[i] = i % 256;
  }
  return arr;
}

describe('utils/validations', () => {
  describe('validateRepoUrl', () => {
    it('accepts valid GitHub repo URLs', () => {
      expect(validateRepoUrl('https://github.com/adobe/spacecat.git')).to.be.true;
      expect(validateRepoUrl('https://github.com/adobe/spacecat')).to.be.true;
    });

    it('rejects invalid URLs', () => {
      expect(validateRepoUrl('https://gitlab.com/adobe/spacecat')).to.be.false;
      expect(validateRepoUrl('http://github.com/adobe/spacecat')).to.be.false;
      expect(validateRepoUrl('github.com/adobe/spacecat')).to.be.false;
    });
  });

  describe('checkBodySize', () => {
    it('handles strings', () => {
      expect(checkBodySize('abc', 4)).to.be.true; // 3 bytes <= 4
      expect(checkBodySize('abc', 2)).to.be.false; // 3 bytes > 2
    });

    it('handles Uint8Array', () => {
      expect(checkBodySize(makeBytes(10), 12)).to.be.true;
      expect(checkBodySize(makeBytes(10), 5)).to.be.false;
    });

    it('handles objects via JSON', () => {
      const obj = { hello: 'world' }; // {"hello":"world"} is 17 bytes
      expect(checkBodySize(obj, 20)).to.be.true;
      expect(checkBodySize(obj, 10)).to.be.false;
    });

    it('considers null / undefined as empty', () => {
      expect(checkBodySize(null, 1)).to.be.true;
      expect(checkBodySize(undefined, 1)).to.be.true;
    });
  });
});
