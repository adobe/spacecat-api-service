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

import { expect, use as chaiUse } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { stub } from 'sinon';
import sinonChai from 'sinon-chai';

import ApiKey from '../../../../src/models/api-key/api-key.model.js';
import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('ApiKeyModel', () => {
  let instance;

  let mockElectroService;
  let mockRecord;

  beforeEach(() => {
    mockRecord = {
      apiKeyId: 'sug12345',
      hashedApiKey: 'someHashedApiKey',
      imsUserId: 'someImsUserId',
      imsOrgId: 'someImsOrgId',
      name: 'someName',
      deletedAt: null,
      expiresAt: null,
      revokedAt: null,
      scopes: [
        {
          domains: ['someDomain'],
          actions: ['someAction'],
        },
      ],
    };

    ({
      mockElectroService,
      model: instance,
    } = createElectroMocks(ApiKey, mockRecord));

    mockElectroService.entities.patch = stub().returns({ set: stub() });
  });

  describe('constructor', () => {
    it('initializes the ApiKey instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.record).to.deep.equal(mockRecord);
    });
  });

  describe('apiKeyId', () => {
    it('gets apiKeyId', () => {
      expect(instance.getId()).to.equal('sug12345');
    });
  });

  describe('hashedApiKey', () => {
    it('gets hashedApiKey', () => {
      expect(instance.getHashedApiKey()).to.equal('someHashedApiKey');
    });

    it('sets hashedApiKey', () => {
      const newHashedApiKey = 'newHashedApiKey';
      instance.setHashedApiKey(newHashedApiKey);
      expect(instance.getHashedApiKey()).to.equal(newHashedApiKey);
    });
  });

  describe('imsUserId', () => {
    it('gets imsUserId', () => {
      expect(instance.getImsUserId()).to.equal('someImsUserId');
    });

    it('sets imsUserId', () => {
      const newImsUserId = 'newImsUserId';
      instance.setImsUserId(newImsUserId);
      expect(instance.getImsUserId()).to.equal(newImsUserId);
    });
  });

  describe('imsOrgId', () => {
    it('gets imsOrgId', () => {
      expect(instance.getImsOrgId()).to.equal('someImsOrgId');
    });

    it('sets imsOrgId', () => {
      const newImsOrgId = 'newImsOrgId';
      instance.setImsOrgId(newImsOrgId);
      expect(instance.getImsOrgId()).to.equal(newImsOrgId);
    });
  });

  describe('name', () => {
    it('gets name', () => {
      expect(instance.getName()).to.equal('someName');
    });

    it('sets name', () => {
      const newName = 'newName';
      instance.setName(newName);
      expect(instance.getName()).to.equal(newName);
    });
  });

  describe('scopes', () => {
    it('gets scopes', () => {
      expect(instance.getScopes()).to.deep.equal([
        {
          domains: ['someDomain'],
          actions: ['someAction'],
        },
      ]);
    });

    it('sets scopes', () => {
      const newScopes = [
        {
          domains: ['newDomain'],
          actions: ['newAction'],
        },
      ];
      instance.setScopes(newScopes);
      expect(instance.getScopes()).to.deep.equal(newScopes);
    });
  });

  describe('isValid', () => {
    it('returns true when the ApiKey is valid', () => {
      expect(instance.isValid()).to.equal(true);
    });

    it('returns false when the ApiKey is deleted', () => {
      instance.setDeletedAt('2022-01-01T00:00:00.000Z');
      expect(instance.isValid()).to.equal(false);
    });

    it('returns false when the ApiKey is revoked', () => {
      instance.setRevokedAt('2022-01-01T00:00:00.000Z');
      expect(instance.isValid()).to.equal(false);
    });

    it('returns false when the ApiKey is expired', () => {
      instance.setExpiresAt('2022-01-01T00:00:00.000Z');
      expect(instance.isValid()).to.equal(false);
    });
  });

  describe('deletedAt', () => {
    it('gets deletedAt', () => {
      expect(instance.getDeletedAt()).to.equal(null);
    });

    it('sets deletedAt', () => {
      const deletedAtIsoDate = '2024-01-01T00:00:00.000Z';
      instance.setDeletedAt(deletedAtIsoDate);
      expect(instance.getDeletedAt()).to.equal(deletedAtIsoDate);
    });
  });

  describe('expiresAt', () => {
    it('gets expiresAt', () => {
      expect(instance.getExpiresAt()).to.equal(null);
    });

    it('sets expiresAt', () => {
      const expiresAtIsoDate = '2024-01-01T00:00:00.000Z';
      instance.setExpiresAt(expiresAtIsoDate);
      expect(instance.getExpiresAt()).to.equal(expiresAtIsoDate);
    });
  });

  describe('revokedAt', () => {
    it('gets revokedAt', () => {
      expect(instance.getRevokedAt()).to.equal(null);
    });

    it('sets revokedAt', () => {
      const revokedAtIsoDate = '2024-01-01T00:00:00.000Z';
      instance.setRevokedAt(revokedAtIsoDate);
      expect(instance.getRevokedAt()).to.equal(revokedAtIsoDate);
    });
  });
});
