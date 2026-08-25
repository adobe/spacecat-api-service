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
import {
  UnauthorizedProductError,
  throwOnPgConstraintViolation,
} from '../../src/support/errors.js';

describe('errors', () => {
  describe('UnauthorizedProductError', () => {
    it('is an Error subclass with the correct name', () => {
      const err = new UnauthorizedProductError('bad product');
      expect(err).to.be.instanceOf(Error);
      expect(err.name).to.equal('UnauthorizedProductError');
      expect(err.message).to.equal('bad product');
    });
  });

  describe('throwOnPgConstraintViolation', () => {
    const codeMap = {
      23505: { status: 409, message: 'unique conflict' },
      23503: { status: 422, message: 'invalid foreign key reference' },
    };

    it('throws a typed error with the mapped status when the code matches', () => {
      const raw = { code: '23505', message: 'pg detail' };
      let thrown;
      try {
        throwOnPgConstraintViolation(raw, codeMap);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect(thrown.status).to.equal(409);
      expect(thrown.message).to.equal('unique conflict');
      expect(thrown.cause).to.equal(raw);
    });

    it('chains the original error as cause', () => {
      const raw = { code: '23503', message: 'fk detail' };
      let thrown;
      try {
        throwOnPgConstraintViolation(raw, codeMap);
      } catch (e) {
        thrown = e;
      }
      expect(thrown.status).to.equal(422);
      expect(thrown.cause).to.equal(raw);
    });

    it('does not throw when the code is not in the map', () => {
      expect(() => throwOnPgConstraintViolation({ code: '42P01' }, codeMap)).to.not.throw();
    });

    it('does not throw when error is null', () => {
      expect(() => throwOnPgConstraintViolation(null, codeMap)).to.not.throw();
    });

    it('does not throw when error has no code', () => {
      expect(() => throwOnPgConstraintViolation({ message: 'oops' }, codeMap)).to.not.throw();
    });
  });
});
