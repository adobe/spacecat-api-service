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

import LatestAudit from '../../../../src/models/latest-audit/latest-audit.model.js';

import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('LatestAuditCollection', () => {
  let instance;

  let mockElectroService;
  let mockEntityRegistry;
  let mockLogger;
  let model;
  let schema;

  const mockRecord = {
    latestAuditId: 's12345',
  };

  beforeEach(() => {
    ({
      mockElectroService,
      mockEntityRegistry,
      mockLogger,
      collection: instance,
      model,
      schema,
    } = createElectroMocks(LatestAudit, mockRecord));
  });

  describe('constructor', () => {
    it('initializes the LatestAuditCollection instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.electroService).to.equal(mockElectroService);
      expect(instance.entityRegistry).to.equal(mockEntityRegistry);
      expect(instance.schema).to.equal(schema);
      expect(instance.log).to.equal(mockLogger);

      expect(model).to.be.an('object');
    });
  });

  describe('create', () => {
    it('creates a new latest audit', async () => {
      const result = await instance.create(mockRecord);

      expect(result).to.be.an('object');
      expect(result.record.latestAuditId).to.equal(mockRecord.latestAuditId);
    });
  });

  describe('allByAuditType', () => {
    it('returns all latest audits by audit type', async () => {
      const auditType = 'lhs-mobile';

      instance.all = stub().resolves([mockRecord]);

      const audits = await instance.allByAuditType(auditType);

      expect(audits).to.be.an('array');
      expect(audits.length).to.equal(1);
      expect(instance.all).to.have.been.calledWithExactly({ auditType });
    });
  });

  describe('findById', () => {
    it('finds latest audit by id', async () => {
      const siteId = '78fec9c7-2141-4600-b7b1-ea5c78752b91';
      const auditType = 'lhs-mobile';

      instance.findByIndexKeys = stub().returns({ go: stub().resolves({ data: [mockRecord] }) });

      const audit = await instance.findById(siteId, auditType);

      expect(audit).to.be.an('object');
      expect(instance.findByIndexKeys).to.have.been.calledWithExactly({ siteId, auditType });
    });
  });
});
