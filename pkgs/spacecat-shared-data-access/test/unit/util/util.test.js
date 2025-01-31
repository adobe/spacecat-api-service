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

// utils.test.js
// This suite tests all utility functions from the provided utils file.
// Requires Mocha for tests, Chai for assertions, and Sinon for spying/stubbing.

import { expect } from 'chai';
import {
  capitalize,
  collectionNameToEntityName,
  decapitalize,
  entityNameToAllPKValue,
  entityNameToCollectionName,
  entityNameToIdName,
  idNameToEntityName,
  incrementVersion,
  keyNamesToIndexName,
  modelNameToEntityName,
  referenceToBaseMethodName,
  sanitizeIdAndAuditFields,
  sanitizeTimestamps,
  zeroPad,
} from '../../../src/util/util.js';
import Reference from '../../../src/models/base/reference.js';

describe('Utilities', () => {
  describe('capitalize', () => {
    it('Convert first character to uppercase', () => {
      expect(capitalize('hello')).to.equal('Hello');
    });

    it('Return empty string if input empty', () => {
      expect(capitalize('')).to.equal('');
    });

    it('Not alter already capitalized strings', () => {
      expect(capitalize('Hello')).to.equal('Hello');
    });
  });

  describe('decapitalize', () => {
    it('Convert first character to lowercase', () => {
      expect(decapitalize('Hello')).to.equal('hello');
    });

    it('Return empty string if input empty', () => {
      expect(decapitalize('')).to.equal('');
    });

    it('Not alter already lowercased strings', () => {
      expect(decapitalize('hello')).to.equal('hello');
    });
  });

  describe('collectionNameToEntityName', () => {
    it('Remove "Collection" suffix from a given string', () => {
      expect(collectionNameToEntityName('UserCollection')).to.equal('User');
    });

    it('Return the original string if no "Collection" present', () => {
      expect(collectionNameToEntityName('User')).to.equal('User');
    });
  });

  describe('entityNameToCollectionName', () => {
    it('Append "Collection" to a singular form of entity name', () => {
      expect(entityNameToCollectionName('User')).to.equal('UserCollection');
    });

    it('Handle plural entity names by converting to singular first', () => {
      expect(entityNameToCollectionName('Users')).to.equal('UserCollection');
    });
  });

  describe('entityNameToIdName', () => {
    it('Convert entityName to a lowercaseId format', () => {
      expect(entityNameToIdName('User')).to.equal('userId');
    });

    it('Handle already lowercase entityName', () => {
      expect(entityNameToIdName('user')).to.equal('userId');
    });
  });

  describe('entityNameToAllPKValue', () => {
    it('Convert entity name to ALL_ upper plural form', () => {
      expect(entityNameToAllPKValue('User')).to.equal('ALL_USERS');
    });

    it('Handle already plural entity name', () => {
      expect(entityNameToAllPKValue('Users')).to.equal('ALL_USERS');
    });
  });

  describe('referenceToBaseMethodName', () => {
    it('Generate "get" + pluralized capitalized target if type is has_many', () => {
      const reference = new Reference('has_many', 'users');
      expect(referenceToBaseMethodName(reference)).to.equal('getUsers');
    });

    it('Generate "get" + singular capitalized target if type is not has_many', () => {
      const reference = new Reference('has_one', 'users');
      expect(referenceToBaseMethodName(reference)).to.equal('getUser');
    });

    it('Handle already capitalized target', () => {
      const reference = new Reference('has_many', 'User');
      expect(referenceToBaseMethodName(reference)).to.equal('getUsers');
    });
  });

  describe('idNameToEntityName', () => {
    it('Convert idName to singular, capitalized entityName', () => {
      expect(idNameToEntityName('userId')).to.equal('User');
    });

    it('Handle plural-like idNames', () => {
      expect(idNameToEntityName('usersId')).to.equal('User');
    });
  });

  describe('incrementVersion', () => {
    it('Increment version by 1 if it is an integer', () => {
      expect(incrementVersion(1)).to.equal(2);
    });

    it('Return 1 if version is not an integer', () => {
      expect(incrementVersion('not-a-number')).to.equal(1);
    });

    it('Return 1 if version is undefined', () => {
      expect(incrementVersion(undefined)).to.equal(1);
    });
  });

  describe('keyNamesToIndexName', () => {
    it('Create index name by capitalizing and joining key names', () => {
      expect(keyNamesToIndexName(['user', 'status'])).to.equal('byUserAndStatus');
    });

    it('Handle single key name', () => {
      expect(keyNamesToIndexName(['user'])).to.equal('byUser');
    });
  });

  describe('modelNameToEntityName', () => {
    it('Decapitalize model name', () => {
      expect(modelNameToEntityName('UserModel')).to.equal('userModel');
    });

    it('Handle already lowercase', () => {
      expect(modelNameToEntityName('usermodel')).to.equal('usermodel');
    });
  });

  describe('sanitizeTimestamps', () => {
    it('Remove createdAt and updatedAt fields', () => {
      const data = { foo: 'bar', createdAt: 'yesterday', updatedAt: 'today' };
      expect(sanitizeTimestamps(data)).to.deep.equal({ foo: 'bar' });
    });

    it('Return object unchanged if no timestamps present', () => {
      const data = { foo: 'bar' };
      expect(sanitizeTimestamps(data)).to.deep.equal({ foo: 'bar' });
    });
  });

  describe('sanitizeIdAndAuditFields', () => {
    it('Remove entity ID and timestamps', () => {
      const data = {
        userId: '123',
        foo: 'bar',
        createdAt: 'yesterday',
        updatedAt: 'today',
      };
      expect(sanitizeIdAndAuditFields('User', data)).to.deep.equal({ foo: 'bar' });
    });

    it('Handle entityName that results in different idName', () => {
      const data = {
        productId: 'abc',
        name: 'Gadget',
        createdAt: 'yesterday',
        updatedAt: 'today',
      };
      expect(sanitizeIdAndAuditFields('Product', data)).to.deep.equal({ name: 'Gadget' });
    });

    it('Return object unchanged if no ID or timestamps present', () => {
      const data = { foo: 'bar' };
      expect(sanitizeIdAndAuditFields('User', data)).to.deep.equal({ foo: 'bar' });
    });
  });

  describe('zeroPad', () => {
    it('adds leading zeros to a number', () => {
      expect(zeroPad(123, 5)).to.equal('00123');
    });
    it('skips padding when number is longer than length', () => {
      expect(zeroPad(123, 1)).to.equal('123');
    });
  });
});
