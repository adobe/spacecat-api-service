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

import Opportunity from '../../../../src/models/opportunity/opportunity.model.js';
import { createElectroMocks } from '../../util.js';

chaiUse(chaiAsPromised);
chaiUse(sinonChai);

describe('OpportunityModel', () => {
  let instance;

  let mockElectroService;
  let mockEntityRegistry;
  let mockRecord;

  beforeEach(() => {
    mockRecord = {
      opportunityId: 'op12345',
      siteId: 'site67890',
      auditId: 'audit001',
      title: 'Test Opportunity',
      description: 'This is a test opportunity.',
      runbook: 'http://runbook.url',
      guidance: 'Follow these steps.',
      type: 'SEO',
      status: 'NEW',
      origin: 'ESS_OPS',
      tags: ['tag1', 'tag2'],
      data: {
        additionalInfo: 'info',
      },
    };

    ({
      mockElectroService,
      mockEntityRegistry,
      model: instance,
    } = createElectroMocks(Opportunity, mockRecord));

    mockElectroService.entities.patch = stub().returns({ set: stub() });
  });

  describe('constructor', () => {
    it('initializes the Opportunity instance correctly', () => {
      expect(instance).to.be.an('object');
      expect(instance.record).to.deep.equal(mockRecord);
    });
  });

  describe('addSuggestions', () => {
    it('adds related suggestions to the opportunity', async () => {
      const mockSuggestionCollection = {
        createMany: stub().returns(Promise.resolve({ id: 'suggestion-1' })),
      };
      mockEntityRegistry.getCollection.withArgs('SuggestionCollection').returns(mockSuggestionCollection);

      const suggestion = await instance.addSuggestions([{ text: 'Suggestion text' }]);
      expect(suggestion).to.deep.equal({ id: 'suggestion-1' });
      expect(mockEntityRegistry.getCollection.calledWith('SuggestionCollection')).to.be.true;
      expect(mockSuggestionCollection.createMany.calledOnceWith([{ text: 'Suggestion text', opportunityId: 'op12345' }])).to.be.true;
    });
  });

  describe('getSiteId and setSiteId', () => {
    it('returns the site ID of the opportunity', () => {
      expect(instance.getSiteId()).to.equal('site67890');
    });

    it('sets the site ID of the opportunity', () => {
      instance.setSiteId('ef39921f-9a02-41db-b491-02c98987d956');
      expect(instance.record.siteId).to.equal('ef39921f-9a02-41db-b491-02c98987d956');
    });
  });

  describe('getAuditId and setAuditId', () => {
    it('returns the audit ID of the opportunity', () => {
      expect(instance.getAuditId()).to.equal('audit001');
    });

    it('sets the audit ID of the opportunity', () => {
      instance.setAuditId('ef39921f-9a02-41db-b491-02c98987d956');
      expect(instance.record.auditId).to.equal('ef39921f-9a02-41db-b491-02c98987d956');
    });
  });

  describe('getRunbook and setRunbook', () => {
    it('returns the runbook reference', () => {
      expect(instance.getRunbook()).to.equal('http://runbook.url');
    });

    it('sets the runbook reference', () => {
      instance.setRunbook('http://new.runbook.url');
      expect(instance.record.runbook).to.equal('http://new.runbook.url');
    });
  });

  describe('getGuidance and setGuidance', () => {
    it('returns the guidance information', () => {
      expect(instance.getGuidance()).to.equal('Follow these steps.');
    });

    it('sets the guidance information', () => {
      instance.setGuidance({ text: 'New guidance text' });
      expect(instance.record.guidance).to.eql({ text: 'New guidance text' });
    });
  });

  describe('getTitle and setTitle', () => {
    it('returns the title of the opportunity', () => {
      expect(instance.getTitle()).to.equal('Test Opportunity');
    });

    it('sets the title of the opportunity', () => {
      instance.setTitle('New Opportunity Title');
      expect(instance.record.title).to.equal('New Opportunity Title');
    });
  });

  describe('getDescription and setDescription', () => {
    it('returns the description of the opportunity', () => {
      expect(instance.getDescription()).to.equal('This is a test opportunity.');
    });

    it('sets the description of the opportunity', () => {
      instance.setDescription('Updated description.');
      expect(instance.record.description).to.equal('Updated description.');
    });
  });

  describe('getType', () => {
    it('returns the type of the opportunity', () => {
      expect(instance.getType()).to.equal('SEO');
    });
  });

  describe('getStatus and setStatus', () => {
    it('returns the status of the opportunity', () => {
      expect(instance.getStatus()).to.equal('NEW');
    });

    it('sets the status of the opportunity', () => {
      instance.setStatus('IN_PROGRESS');
      expect(instance.record.status).to.equal('IN_PROGRESS');
    });
  });

  describe('getOrigin and setOrigin', () => {
    it('returns the origin of the opportunity', () => {
      expect(instance.getOrigin()).to.equal('ESS_OPS');
    });

    it('sets the origin of the opportunity', () => {
      instance.setOrigin('AI');
      expect(instance.record.origin).to.equal('AI');
    });
  });

  describe('getTags and setTags', () => {
    it('returns the tags of the opportunity', () => {
      expect(instance.getTags()).to.deep.equal(['tag1', 'tag2']);
    });

    it('sets the tags of the opportunity', () => {
      instance.setTags(['newTag1', 'newTag2']);
      expect(instance.record.tags).to.deep.equal(['newTag1', 'newTag2']);
    });
  });

  describe('getData and setData', () => {
    it('returns additional data for the opportunity', () => {
      expect(instance.getData()).to.deep.equal({ additionalInfo: 'info' });
    });

    it('sets additional data for the opportunity', () => {
      instance.setData({ newInfo: 'updatedInfo' });
      expect(instance.record.data).to.deep.equal({ newInfo: 'updatedInfo' });
    });
  });
});
