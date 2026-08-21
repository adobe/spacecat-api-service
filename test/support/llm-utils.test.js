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

import { expect } from 'chai';

import { withTimeout, contentToString } from '../../src/support/llm-utils.js';

describe('llm-utils', () => {
  describe('withTimeout', () => {
    it('resolves with the promise value when it settles before the timeout', async () => {
      const result = await withTimeout(Promise.resolve('value'), 50);
      expect(result).to.equal('value');
    });

    it('rejects with a generic message when no label is given', async () => {
      const hung = new Promise(() => {});
      await expect(withTimeout(hung, 10)).to.be.rejectedWith('operation timed out after 10ms');
    });

    it('includes the caller-supplied label in the timeout message', async () => {
      const hung = new Promise(() => {});
      await expect(withTimeout(hung, 10, 'suggestion translation'))
        .to.be.rejectedWith('suggestion translation timed out after 10ms');
    });

    it('propagates a rejection from the underlying promise unchanged', async () => {
      await expect(withTimeout(Promise.reject(new Error('boom')), 50)).to.be.rejectedWith('boom');
    });
  });

  describe('contentToString', () => {
    it('returns a string unchanged', () => {
      expect(contentToString('hello')).to.equal('hello');
    });

    it('concatenates text parts of an array content', () => {
      const parts = [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }];
      expect(contentToString(parts)).to.equal('hello world');
    });

    it('accepts string parts and a `content` field, ignores non-text parts', () => {
      const parts = ['hello ', { type: 'something', other: 'x' }, { content: 'world' }];
      expect(contentToString(parts)).to.equal('hello world');
    });

    it('coerces null/undefined/object to a (possibly empty) string', () => {
      expect(contentToString(null)).to.equal('');
      expect(contentToString(undefined)).to.equal('');
      expect(contentToString(42)).to.equal('42');
    });
  });
});
