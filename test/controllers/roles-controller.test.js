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
import { ValidationError } from '@adobe/spacecat-shared-data-access';
import AccessControlUtil from '../../src/support/access-control-util.js';

import RolesController from '../../src/controllers/roles-controller.js';

use(sinonChai);

describe('RolesController', () => {
  let rolesController;
  let mockContext;
  let mockRole;
  let mockRoleCollection;

  const validUUID = 'e730ec12-4325-4bdd-ac71-0f4aa5b18cff';
  const invalidUUID = 'invalid-uuid';

  beforeEach(() => {
    // Mock AccessControlUtil
    sinon.stub(AccessControlUtil, 'fromContext').returns({
      hasAdminAccess: sinon.stub().returns(true),
    });

    // Mock role object with proper sinon stubs
    mockRole = {
      getId: sinon.stub().returns(validUUID),
      getName: sinon.stub().returns('Test Role'),
      getImsOrgId: sinon.stub().returns('test-org-id'),
      getAcl: sinon.stub().returns([
        { actions: ['read'], path: '/sites' },
        { actions: ['write'], path: '/organizations' },
      ]),
      getCreatedAt: sinon.stub().returns('2023-12-16T09:21:09.000Z'),
      getCreatedBy: sinon.stub().returns('test-user'),
      getUpdatedAt: sinon.stub().returns('2023-12-16T09:21:09.000Z'),
      getUpdatedBy: sinon.stub().returns('test-user'),
      setName: sinon.stub().returns(mockRole),
      setImsOrgId: sinon.stub().returns(mockRole),
      setAcl: sinon.stub().returns(mockRole),
      setUpdatedBy: sinon.stub().returns(mockRole),
      save: sinon.stub(),
    };

    // Set up the save stub to resolve with the mock role
    mockRole.save.resolves(mockRole);

    // Mock role collection
    mockRoleCollection = {
      findById: sinon.stub(),
      create: sinon.stub(),
    };

    // Mock context
    mockContext = {
      rbacDataAccess: {
        Role: mockRoleCollection,
      },
    };

    rolesController = RolesController(mockContext);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('constructor', () => {
    it('should throw error when context is not provided', () => {
      expect(() => RolesController()).to.throw('Context required');
    });

    it('should throw error when context is not an object', () => {
      expect(() => RolesController(null)).to.throw('Context required');
      expect(() => RolesController(undefined)).to.throw('Context required');
    });

    it('should throw error when rbacDataAccess is not provided', () => {
      const contextWithoutRbac = {};
      expect(() => RolesController(contextWithoutRbac)).to.throw('Context required');
    });

    it('should throw error when rbacDataAccess is not an object', () => {
      const contextWithInvalidRbac = { rbacDataAccess: null };
      expect(() => RolesController(contextWithInvalidRbac)).to.throw('Role data access required');
    });

    it('should throw error when Role collection is not available', () => {
      const contextWithoutRole = { rbacDataAccess: {} };
      expect(() => RolesController(contextWithoutRole)).to.throw('Role data access required');
    });

    it('should create controller successfully with valid context', () => {
      expect(rolesController).to.be.an('object');
      expect(rolesController.getByID).to.be.a('function');
      expect(rolesController.createRole).to.be.a('function');
      expect(rolesController.patchRole).to.be.a('function');
    });
  });

  describe('getByID', () => {
    it('should return 400 when roleId is not provided', async () => {
      const context = { params: {} };
      const response = await rolesController.getByID(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('Role ID required');
    });

    it('should return 400 when roleId is not a valid UUID', async () => {
      const context = { params: { roleId: invalidUUID } };
      const response = await rolesController.getByID(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('Role ID required');
    });

    it('should return 404 when role is not found', async () => {
      mockRoleCollection.findById.resolves(null);

      const context = { params: { roleId: validUUID } };
      const response = await rolesController.getByID(context);

      expect(response.status).to.equal(404);
      expect(response.headers.plain()['x-error']).to.equal('Role not found');
      expect(mockRoleCollection.findById).to.have.been.calledOnceWith(validUUID);
    });

    it('should return 200 with role data when role is found', async () => {
      mockRoleCollection.findById.resolves(mockRole);

      const context = { params: { roleId: validUUID } };
      const response = await rolesController.getByID(context);

      expect(response.status).to.equal(200);
      const responseData = await response.json();
      expect(responseData).to.deep.equal({
        id: validUUID,
        name: 'Test Role',
        imsOrgId: 'test-org-id',
        acl: [
          { actions: ['read'], path: '/sites' },
          { actions: ['write'], path: '/organizations' },
        ],
        createdAt: '2023-12-16T09:21:09.000Z',
        createdBy: 'test-user',
        updatedAt: '2023-12-16T09:21:09.000Z',
        updatedBy: 'test-user',
      });
      expect(mockRoleCollection.findById).to.have.been.calledOnceWith(validUUID);
    });
  });

  describe('createRole', () => {
    it('should return 400 when no data is provided', async () => {
      const context = {};
      const response = await rolesController.createRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('No data provided');
    });

    it('should return 400 when data is not an object', async () => {
      const context = { data: null };
      const response = await rolesController.createRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('No data provided');
    });

    it('should return 400 when data is empty object', async () => {
      const context = { data: {} };
      const response = await rolesController.createRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('No data provided');
    });

    it('should return 201 with created role when role is created successfully', async () => {
      const roleData = {
        name: 'New Role',
        imsOrgId: 'new-org-id',
        acl: [{ actions: ['read'], path: '/sites' }],
      };
      mockRoleCollection.create.resolves(mockRole);

      const context = { data: roleData };
      const response = await rolesController.createRole(context);

      expect(response.status).to.equal(201);
      const responseData = await response.json();
      expect(responseData).to.deep.equal({
        id: validUUID,
        name: 'Test Role',
        imsOrgId: 'test-org-id',
        acl: [
          { actions: ['read'], path: '/sites' },
          { actions: ['write'], path: '/organizations' },
        ],
        createdAt: '2023-12-16T09:21:09.000Z',
        createdBy: 'test-user',
        updatedAt: '2023-12-16T09:21:09.000Z',
        updatedBy: 'test-user',
      });
      expect(mockRoleCollection.create).to.have.been.calledOnceWith(roleData);
    });

    it('should return 400 when ValidationError occurs', async () => {
      const roleData = { name: 'Invalid Role' };
      const validationError = new ValidationError('Invalid role data');
      mockRoleCollection.create.rejects(validationError);

      const context = { data: roleData };
      const response = await rolesController.createRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('Invalid role data');
    });

    it('should return 500 when other error occurs', async () => {
      const roleData = { name: 'Error Role' };
      const error = new Error('Database error');
      mockRoleCollection.create.rejects(error);

      const context = { data: roleData };
      const response = await rolesController.createRole(context);

      expect(response.status).to.equal(500);
      const responseData = await response.json();
      expect(responseData).to.deep.equal({ message: 'Error creating role' });
    });
  });

  describe('patchRole', () => {
    const mockProfile = { email: 'test@example.com' };

    beforeEach(() => {
      mockRoleCollection.findById.resolves(mockRole);

      // Recreate the stubs properly instead of just resetting
      mockRole.setName = sinon.stub().returns(mockRole);
      mockRole.setImsOrgId = sinon.stub().returns(mockRole);
      mockRole.setAcl = sinon.stub().returns(mockRole);
      mockRole.setUpdatedBy = sinon.stub().returns(mockRole);
      mockRole.save = sinon.stub().resolves(mockRole);
    });

    it('should return 400 when roleId is not provided', async () => {
      const context = {
        params: {},
        attributes: { authInfo: { profile: mockProfile } },
      };
      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('Role ID required');
    });

    it('should return 400 when roleId is not a valid UUID', async () => {
      const context = {
        params: { roleId: invalidUUID },
        attributes: { authInfo: { profile: mockProfile } },
      };
      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('Role ID required');
    });

    it('should return 404 when role is not found', async () => {
      mockRoleCollection.findById.resolves(null);

      const context = {
        params: { roleId: validUUID },
        attributes: { authInfo: { profile: mockProfile } },
      };
      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(404);
      expect(response.headers.plain()['x-error']).to.equal('Role not found');
    });

    it('should return 400 when no updates are provided', async () => {
      const context = {
        params: { roleId: validUUID },
        data: {},
        attributes: { authInfo: { profile: mockProfile } },
      };
      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('No updates provided');
    });

    it('should return 400 when data is not an object', async () => {
      const context = {
        params: { roleId: validUUID },
        data: null,
        attributes: { authInfo: { profile: mockProfile } },
      };
      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('No updates provided');
    });

    it.skip('should update name when provided and different', async () => {
      const newName = 'Updated Role Name';
      const context = {
        params: { roleId: validUUID },
        data: { name: newName },
        attributes: { authInfo: { profile: mockProfile } },
      };

      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(200);
      expect(mockRole.setName).to.have.been.calledOnceWith(newName);
      expect(mockRole.setUpdatedBy).to.have.been.calledOnceWith('test@example.com');
      expect(mockRole.save).to.have.been.calledOnce();
    });

    it.skip('should update imsOrgId when provided and different', async () => {
      const newImsOrgId = 'new-org-id';
      const context = {
        params: { roleId: validUUID },
        data: { imsOrgId: newImsOrgId },
        attributes: { authInfo: { profile: mockProfile } },
      };

      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(200);
      expect(mockRole.setImsOrgId).to.have.been.calledOnceWith(newImsOrgId);
      expect(mockRole.setUpdatedBy).to.have.been.calledOnceWith('test@example.com');
      expect(mockRole.save).to.have.been.calledOnce();
    });

    it.skip('should update acl when provided and different', async () => {
      const newAcl = [{ actions: ['read', 'write'], path: '/new-path' }];
      const context = {
        params: { roleId: validUUID },
        data: { acl: newAcl },
        attributes: { authInfo: { profile: mockProfile } },
      };

      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(200);
      expect(mockRole.setAcl).to.have.been.calledOnceWith(newAcl);
      expect(mockRole.setUpdatedBy).to.have.been.calledOnceWith('test@example.com');
      expect(mockRole.save).to.have.been.calledOnce();
    });

    it.skip('should not update when values are the same', async () => {
      const context = {
        params: { roleId: validUUID },
        data: { name: 'Test Role' }, // Same as current name
        attributes: { authInfo: { profile: mockProfile } },
      };

      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('No updates provided');
      expect(mockRole.setName).to.not.have.been.called();
      expect(mockRole.save).to.not.have.been.called();
    });

    it('should use system as updatedBy when profile email is not available', async () => {
      const context = {
        params: { roleId: validUUID },
        data: { name: 'New Name' },
        attributes: { authInfo: { profile: {} } },
      };

      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(200);
      expect(mockRole.setUpdatedBy).to.have.been.calledOnceWith('system');
    });

    it('should return 400 when ValidationError occurs', async () => {
      const validationError = new ValidationError('Invalid role data');
      mockRole.save.rejects(validationError);

      const context = {
        params: { roleId: validUUID },
        data: { name: 'New Name' },
        attributes: { authInfo: { profile: mockProfile } },
      };

      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(400);
      expect(response.headers.plain()['x-error']).to.equal('Invalid role data');
    });

    it('should return 500 when other error occurs', async () => {
      const error = new Error('Database error');
      mockRole.save.rejects(error);

      const context = {
        params: { roleId: validUUID },
        data: { name: 'New Name' },
        attributes: { authInfo: { profile: mockProfile } },
      };

      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(500);
      const responseData = await response.json();
      expect(responseData).to.deep.equal({ message: 'Error updating role' });
    });

    it.skip('should handle multiple updates simultaneously', async () => {
      const updates = {
        name: 'Updated Name',
        imsOrgId: 'updated-org-id',
        acl: [{ actions: ['read'], path: '/updated-path' }],
      };

      const context = {
        params: { roleId: validUUID },
        data: updates,
        attributes: { authInfo: { profile: mockProfile } },
      };

      const response = await rolesController.patchRole(context);

      expect(response.status).to.equal(200);
      expect(mockRole.setName).to.have.been.calledOnceWith('Updated Name');
      expect(mockRole.setImsOrgId).to.have.been.calledOnceWith('updated-org-id');
      expect(mockRole.setAcl).to.have.been.calledOnceWith(updates.acl);
      expect(mockRole.setUpdatedBy).to.have.been.calledOnceWith('test@example.com');
      expect(mockRole.save).to.have.been.calledOnce();
    });
  });
});
