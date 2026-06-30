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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

const BRAND = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = '22222222-3333-4444-5555-666666666666';

function fakeLog() {
  return {
    info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
  };
}

function makeTransport(overrides = {}) {
  return {
    createProjectTags: sinon.stub().resolves([{ id: 'tag-1', name: 'category:Footwear' }]),
    ...overrides,
  };
}

function makeDataAccess(findBySliceResult) {
  return {
    BrandSemrushProject: {
      findBySlice: sinon.stub().resolves(findBySliceResult),
    },
  };
}

const validBody = {
  type: 'category', name: 'Footwear', geoTargetId: 2840, languageCode: 'en',
};

describe('serenity tags handler (POST /serenity/tags)', () => {
  afterEach(() => sinon.restore());

  describe('handleCreateTag (flat mode)', () => {
    let handler;
    beforeEach(async () => {
      handler = await import('../../../../src/support/serenity/handlers/tags.js');
    });

    it('registers a category:<NAME> tag on the slice project and returns 201', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        validBody,
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({
        brandId: BRAND,
        geoTargetId: 2840,
        languageCode: 'en',
        type: 'category',
        name: 'Footwear',
        tag: 'category:Footwear',
      });
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-1', ['category:Footwear']);
    });

    it('supports the topic dimension (also free-form)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const res = await handler.handleCreateTag(
        transport,
        dataAccess,
        BRAND,
        WORKSPACE,
        { ...validBody, type: 'topic', name: 'Running Shoes' },
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body.tag).to.equal('topic:Running Shoes');
      expect(transport.createProjectTags.firstCall.args[2]).to.deep.equal(['topic:Running Shoes']);
    });

    it('404s (marketNotFound) when no project backs the slice', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess(null);
      await expect(
        handler.handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, validBody, fakeLog()),
      ).to.be.rejected.then((err) => {
        expect(err.status).to.equal(404);
        expect(err.code).to.equal('marketNotFound');
      });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s when type is not in the creatable allow-list (closed taxonomy)', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      for (const type of ['intent', 'source', 'type', 'bogus', '', undefined]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(handler.handleCreateTag(
          transport,
          dataAccess,
          BRAND,
          WORKSPACE,
          { ...validBody, type },
          fakeLog(),
        )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s when name is missing, too long, or contains a colon', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...validBody, name: '   ' },
        { ...validBody, name: 'x'.repeat(101) },
        { ...validBody, name: 'topic:smuggled' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s on a non-positive geoTargetId or malformed languageCode', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess({ getSemrushProjectId: () => 'proj-1' });
      const bad = [
        { ...validBody, geoTargetId: 0 },
        { ...validBody, geoTargetId: 'abc' },
        { ...validBody, languageCode: 'EN_US!' },
        { ...validBody, languageCode: '' },
      ];
      for (const body of bad) {
        // eslint-disable-next-line no-await-in-loop
        await expect(
          handler.handleCreateTag(transport, dataAccess, BRAND, WORKSPACE, body, fakeLog()),
        ).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      }
    });
  });

  describe('handleCreateTagSubworkspace', () => {
    it('resolves the project from the live listing and registers the tag', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      const res = await handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        validBody,
        fakeLog(),
      );
      expect(res.status).to.equal(201);
      expect(res.body).to.include({ type: 'category', name: 'Footwear', tag: 'category:Footwear' });
      expect(res.body).to.not.have.property('brandId');
      expect(resolveProjectStub).to.have.been.calledOnceWithExactly(
        transport,
        WORKSPACE,
        2840,
        'en',
        sinon.match.any,
      );
      expect(transport.createProjectTags)
        .to.have.been.calledOnceWithExactly(WORKSPACE, 'proj-sub-1', ['category:Footwear']);
    });

    it('404s (marketNotFound) when the slice has no live project', async () => {
      const resolveProjectStub = sinon.stub().resolves(null);
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      await expect(handler.handleCreateTagSubworkspace(transport, WORKSPACE, validBody, fakeLog()))
        .to.be.rejected.then((err) => {
          expect(err.status).to.equal(404);
          expect(err.code).to.equal('marketNotFound');
        });
      expect(transport.createProjectTags).to.not.have.been.called;
    });

    it('400s on a bad body before resolving any project', async () => {
      const resolveProjectStub = sinon.stub().resolves({ id: 'proj-sub-1' });
      const handler = await esmock('../../../../src/support/serenity/handlers/tags.js', {
        '../../../../src/support/serenity/subworkspace-projects.js': {
          resolveProject: resolveProjectStub,
        },
      });
      const transport = makeTransport();
      await expect(handler.handleCreateTagSubworkspace(
        transport,
        WORKSPACE,
        { ...validBody, type: 'intent' },
        fakeLog(),
      )).to.be.rejected.then((err) => expect(err.status).to.equal(400));
      expect(resolveProjectStub).to.not.have.been.called;
    });
  });
});
