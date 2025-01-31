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

import ImportUrl from '../../../../src/models/import-url/import-url.model.js';
import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('ImportUrlModel', () => {
  let instance;

  let mockElectroService;
  let mockRecord;

  beforeEach(() => {
    mockRecord = {
      importUrlId: 'sug12345',
      importJobId: 'ij12345',
      file: 'someFile',
      path: 'somePath',
      reason: 'someReason',
      status: 'PENDING',
      url: 'https://example.com',
    };

    ({
      mockElectroService,
      model: instance,
    } = createElectroMocks(ImportUrl, mockRecord));

    mockElectroService.entities.patch = stub().returns({ set: stub() });
  });

  describe('constructor', () => {
    it('initializes the ImportUrl instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.record).to.deep.equal(mockRecord);
    });
  });

  describe('importUrlId', () => {
    it('gets importUrlId', () => {
      expect(instance.getId()).to.equal('sug12345');
    });
  });

  describe('importJobId', () => {
    it('gets importJobId', () => {
      expect(instance.getImportJobId()).to.equal('ij12345');
    });

    it('sets importJobId', () => {
      instance.setImportJobId('699120e9-7adb-4c97-b1c2-403b6ea9e057');
      expect(instance.getImportJobId()).to.equal('699120e9-7adb-4c97-b1c2-403b6ea9e057');
    });
  });

  describe('file', () => {
    it('gets file', () => {
      expect(instance.getFile()).to.equal('someFile');
    });

    it('sets file', () => {
      instance.setFile('newFile');
      expect(instance.getFile()).to.equal('newFile');
    });
  });

  describe('path', () => {
    it('gets path', () => {
      expect(instance.getPath()).to.equal('somePath');
    });

    it('sets path', () => {
      instance.setPath('newPath');
      expect(instance.getPath()).to.equal('newPath');
    });
  });

  describe('reason', () => {
    it('gets reason', () => {
      expect(instance.getReason()).to.equal('someReason');
    });

    it('sets reason', () => {
      instance.setReason('newReason');
      expect(instance.getReason()).to.equal('newReason');
    });
  });

  describe('status', () => {
    it('gets status', () => {
      expect(instance.getStatus()).to.equal('PENDING');
    });

    it('sets status', () => {
      instance.setStatus('COMPLETE');
      expect(instance.getStatus()).to.equal('COMPLETE');
    });
  });

  describe('url', () => {
    it('gets url', () => {
      expect(instance.getUrl()).to.equal('https://example.com');
    });

    it('sets url', () => {
      instance.setUrl('https://example.org');
      expect(instance.getUrl()).to.equal('https://example.org');
    });
  });
});
