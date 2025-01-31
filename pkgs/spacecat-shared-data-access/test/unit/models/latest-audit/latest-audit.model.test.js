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

describe('LatestAuditModel', () => {
  let instance;

  let mockElectroService;
  let mockRecord;

  beforeEach(() => {
    mockRecord = {
      latestAuditId: 'a12345',
      auditId: 'x12345',
      auditResult: { foo: 'bar' },
      auditType: 'someAuditType',
      auditedAt: '2024-01-01T00:00:00.000Z',
      fullAuditRef: 'someFullAuditRef',
      isLive: true,
      isError: false,
      siteId: 'site12345',
    };

    ({
      mockElectroService,
      model: instance,
    } = createElectroMocks(LatestAudit, mockRecord));

    mockElectroService.entities.patch = stub().returns({ set: stub() });
  });

  describe('constructor', () => {
    it('initializes the Latest instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.record).to.deep.equal(mockRecord);
    });
  });

  describe('latestAuditId', () => {
    it('gets auditId', () => {
      expect(instance.getId()).to.equal('a12345');
    });
  });

  describe('auditResult', () => {
    it('gets auditResult', () => {
      expect(instance.getAuditResult()).to.deep.equal({ foo: 'bar' });
    });
  });

  describe('auditType', () => {
    it('gets auditType', () => {
      expect(instance.getAuditType()).to.equal('someAuditType');
    });
  });

  describe('auditedAt', () => {
    it('gets auditedAt', () => {
      expect(instance.getAuditedAt()).to.equal('2024-01-01T00:00:00.000Z');
    });
  });

  describe('fullAuditRef', () => {
    it('gets fullAuditRef', () => {
      expect(instance.getFullAuditRef()).to.equal('someFullAuditRef');
    });
  });

  describe('isLive', () => {
    it('gets isLive', () => {
      expect(instance.getIsLive()).to.be.true;
    });
  });

  describe('isError', () => {
    it('gets isError', () => {
      expect(instance.getIsError()).to.be.false;
    });
  });

  describe('auditId', () => {
    it('gets auditId', () => {
      expect(instance.getAuditId()).to.equal('x12345');
    });
  });

  describe('siteId', () => {
    it('gets siteId', () => {
      expect(instance.getSiteId()).to.equal('site12345');
    });
  });

  describe('getScores', () => {
    it('returns the scores from the audit result', () => {
      mockRecord.auditResult = { scores: { foo: 'bar' } };
      expect(instance.getScores()).to.deep.equal({ foo: 'bar' });
    });
  });
});
