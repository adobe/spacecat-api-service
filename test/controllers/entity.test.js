/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import EntityController from '../../src/controllers/entity.js';

use(sinonChai);

describe('Entity Controller', () => {
  let context;
  let entityController;
  let mockDataAccess;
  let mockEntity;
  const sandbox = sinon.createSandbox();

  const validUUID = '550e8400-e29b-41d4-a716-446655440000';
  const nonEmailUpdatedBy = 'system-user';
  const emailUpdatedBy = 'test@example.com';

  beforeEach(() => {
    mockEntity = {
      getUpdatedBy: sandbox.stub(),
    };

    mockDataAccess = {
      BaseCollection: {
        findById: sandbox.stub(),
      },
    };

    context = {
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
      },
      dataAccess: mockDataAccess,
      imsClient: {
        getImsAdminProfile: sandbox.stub(),
      },
    };

    entityController = EntityController(context);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getLastUpdatedBy', () => {
    it('returns bad request for invalid UUID', async () => {
      const response = await entityController.getLastUpdatedBy({
        data: { entityId: 'invalid-uuid' },
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error.message).to.equal('Valid entity ID required');
    });

    it('returns not found when entity does not exist', async () => {
      mockDataAccess.BaseCollection.findById.resolves(null);

      const response = await entityController.getLastUpdatedBy({
        data: { entityId: validUUID },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error.message).to.equal(`Entity not found: ${validUUID}`);
      expect(mockDataAccess.BaseCollection.findById.calledWith(validUUID)).to.be.true;
    });

    it('returns not found when no update history exists', async () => {
      mockDataAccess.BaseCollection.findById.resolves(mockEntity);
      mockEntity.getUpdatedBy.returns(null);

      const response = await entityController.getLastUpdatedBy({
        data: { entityId: validUUID },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error.message).to.equal(`No update history found for entity: ${validUUID}`);
    });

    it('returns non-email updatedBy value directly', async () => {
      mockDataAccess.BaseCollection.findById.resolves(mockEntity);
      mockEntity.getUpdatedBy.returns(nonEmailUpdatedBy);

      const response = await entityController.getLastUpdatedBy({
        data: { entityId: validUUID },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.equal(nonEmailUpdatedBy);
      expect(context.imsClient.getImsAdminProfile.called).to.be.false;
    });

    it('returns email from IMS profile when updatedBy is an email', async () => {
      mockDataAccess.BaseCollection.findById.resolves(mockEntity);
      mockEntity.getUpdatedBy.returns(emailUpdatedBy);
      context.imsClient.getImsAdminProfile.resolves({
        email: 'resolved@example.com',
      });

      const response = await entityController.getLastUpdatedBy({
        data: { entityId: validUUID },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.equal('resolved@example.com');
      expect(context.imsClient.getImsAdminProfile.calledWith(emailUpdatedBy)).to.be.true;
    });

    it('returns original updatedBy email when IMS profile lookup fails', async () => {
      mockDataAccess.BaseCollection.findById.resolves(mockEntity);
      mockEntity.getUpdatedBy.returns(emailUpdatedBy);
      context.imsClient.getImsAdminProfile.rejects(new Error('IMS API error'));

      const response = await entityController.getLastUpdatedBy({
        data: { entityId: validUUID },
      });

      expect(response.status).to.equal(200);
      const result = await response.json();
      expect(result).to.equal(emailUpdatedBy);
      expect(context.log.error.calledOnce).to.be.true;
      expect(context.log.error.args[0][0]).to.include('Error fetching user profile for ID');
    });
  });
});
