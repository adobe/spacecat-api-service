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

import Audit from '../../../../src/models/audit/audit.model.js';
import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('AuditModel', () => {
  let instance;

  let mockElectroService;
  let mockRecord;

  beforeEach(() => {
    mockRecord = {
      auditId: 'a12345',
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
    } = createElectroMocks(Audit, mockRecord));

    mockElectroService.entities.patch = stub().returns({ set: stub() });
  });

  describe('constructor', () => {
    it('initializes the Audit instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.record).to.deep.equal(mockRecord);
    });
  });

  describe('auditId', () => {
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

  describe('validateAuditResult', () => {
    it('throws an error if auditResult is not an object or array', () => {
      expect(() => Audit.validateAuditResult(null, 'someAuditType'))
        .to.throw('Audit result must be an object or array');
    });

    it('throws an error if auditResult is an object and does not contain scores', () => {
      expect(() => Audit.validateAuditResult({ foo: 'bar' }, 'lhs-mobile'))
        .to.throw("Missing scores property for audit type 'lhs-mobile'");
    });

    it('throws an error if auditResult is an object and does not contain expected properties', () => {
      mockRecord.auditResult = { scores: { foo: 'bar' } };
      expect(() => Audit.validateAuditResult(mockRecord.auditResult, 'lhs-desktop'))
        .to.throw("Missing expected property 'performance' for audit type 'lhs-desktop'");
    });

    it('returns true if the auditResult represents a runtime error', () => {
      mockRecord.auditResult = { runtimeError: { code: 'someErrorCode' } };
      expect(Audit.validateAuditResult(mockRecord.auditResult, 'someAuditType')).to.be.true;
    });

    it('returns true if auditResult is an object and contains expected properties', () => {
      mockRecord.auditResult = {
        scores: {
          performance: 1, seo: 1, accessibility: 1, 'best-practices': 1,
        },
      };
      expect(Audit.validateAuditResult(mockRecord.auditResult, 'lhs-mobile')).to.be.true;
    });

    it('returns true if auditResult is an array', () => {
      mockRecord.auditResult = [{ scores: { foo: 'bar' } }];
      expect(Audit.validateAuditResult(mockRecord.auditResult, 'experimentation')).to.be.true;
    });
  });
});
