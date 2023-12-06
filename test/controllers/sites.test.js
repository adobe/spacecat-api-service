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

import { expect } from 'chai';
import sinon from 'sinon';

import SitesController from '../../src/controllers/sites.js';
import { SiteDto } from '../../src/dto/site.js';

describe('Sites Controller', () => {
  const sandbox = sinon.createSandbox();
  const sites = [
    { id: 'site1', baseURL: 'https://site1.com' },
    { id: 'site2', baseURL: 'https://site2.com' },
  ].map((site) => SiteDto.fromJson(site));

  const siteFunctions = ['createSite', 'getAll', 'getAllAsCSV', 'getAllAsXLS', 'getByBaseURL', 'getByID'];

  const mockDataAccess = {
    addSite: sandbox.stub().resolves(sites[0]),
    getSites: sandbox.stub().resolves(sites),
    getSiteByBaseURL: sandbox.stub().resolves(sites[0]),
    getSiteByID: sandbox.stub().resolves(sites[0]),
  };

  let sitesController;

  beforeEach(() => {
    sitesController = SitesController(mockDataAccess);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    siteFunctions.forEach((funcName) => {
      expect(sitesController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(sitesController).forEach((funcName) => {
      expect(siteFunctions).to.include(funcName);
    });
  });

  it('throws an error if data access is not an object', () => {
    expect(() => SitesController()).to.throw('Data access required');
  });

  it('creates a site', async () => {
    const site = await sitesController.createSite({ baseURL: 'https://site1.com' });

    expect(mockDataAccess.addSite.calledOnce).to.be.true;
    expect(site).to.be.an('object');
    expect(site).to.have.property('id', 'site1');
    expect(site).to.have.property('baseURL', 'https://site1.com');
  });

  it('gets all sites', async () => {
    mockDataAccess.getSites.resolves(sites);

    const result = await sitesController.getAll();

    expect(mockDataAccess.getSites.calledOnce).to.be.true;
    expect(result).to.be.an('array').with.lengthOf(2);
    expect(result[0]).to.have.property('id', 'site1');
    expect(result[0]).to.have.property('baseURL', 'https://site1.com');
    expect(result[1]).to.have.property('id', 'site2');
    expect(result[1]).to.have.property('baseURL', 'https://site2.com');
  });

  it('gets all sites as CSV', async () => {
    const result = await sitesController.getAllAsCSV();

    // expect(mockDataAccess.getSites.calledOnce).to.be.true;
    expect(result).to.be.a('string');
  });

  it('gets all sites as XLS', async () => {
    const result = await sitesController.getAllAsXLS();

    // expect(mockDataAccess.getSites.calledOnce).to.be.true;
    expect(result).to.be.null;
  });

  it('gets a site by ID', async () => {
    const result = await sitesController.getByID('site1');

    expect(mockDataAccess.getSiteByID.calledOnce).to.be.true;

    expect(result).to.be.an('object');
    expect(result).to.have.property('id', 'site1');
    expect(result).to.have.property('baseURL', 'https://site1.com');
  });

  it('gets a site by base URL', async () => {
    const result = await sitesController.getByBaseURL('https://site1.com');

    expect(mockDataAccess.getSiteByBaseURL.calledOnce).to.be.true;

    expect(result).to.be.an('object');
    expect(result).to.have.property('id', 'site1');
    expect(result).to.have.property('baseURL', 'https://site1.com');
  });

  it('returns null when site is not found by id', async () => {
    mockDataAccess.getSiteByID.resolves(null);

    const result = await sitesController.getByID('site1');

    expect(result).to.be.null;
  });

  it('returns null when site is not found by baseURL', async () => {
    mockDataAccess.getSiteByBaseURL.resolves(null);

    const result = await sitesController.getByBaseURL('site1');

    expect(result).to.be.null;
  });
});
