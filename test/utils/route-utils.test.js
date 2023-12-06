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
import matchPath from '../../src/utils/route-utils.js';

describe('matchPath', () => {
  const staticRoutes = {
    'GET /home': 'homeHandler',
    'GET /about': 'aboutHandler',
  };

  const dynamicRoutes = {
    'GET /users/:userId': {
      handler: 'userHandler',
      paramNames: ['userId'],
    },
    'GET /users/:userId/orders/:orderId': {
      handler: 'userOrderHandler',
      paramNames: ['userId', 'orderId'],
    },
    'GET /products/:productId/details': {
      handler: 'productDetailsHandler',
      paramNames: ['productId'],
    },
    'GET /products/by-title/:productTitle': {
      handler: 'productTitleHandler',
      paramNames: ['productTitle'],
    },
    'GET /products/by-some-url/:someUrl': {
      handler: 'productTitleHandler',
      paramNames: ['someUrl'],
    },
  };

  const routeDefinitions = { staticRoutes, dynamicRoutes };

  it('matches static routes correctly', () => {
    expect(matchPath('GET', '/home', routeDefinitions)).to.deep.equal({ handler: 'homeHandler', params: {} });
    expect(matchPath('GET', '/about', routeDefinitions)).to.deep.equal({ handler: 'aboutHandler', params: {} });
  });

  it('matches dynamic routes correctly', () => {
    expect(matchPath('GET', '/users/123', routeDefinitions)).to.deep.equal({ handler: 'userHandler', params: { userId: '123' } });
    expect(matchPath('GET', '/products/456/details', routeDefinitions)).to.deep.equal({ handler: 'productDetailsHandler', params: { productId: '456' } });
    expect(matchPath('GET', '/products/by-title/some-title', routeDefinitions)).to.deep.equal({ handler: 'productTitleHandler', params: { productTitle: 'some-title' } });
    expect(matchPath('GET', '/products/by-some-url/https%3A%2F%2Fsite1.com', routeDefinitions)).to.deep.equal({ handler: 'productTitleHandler', params: { someUrl: 'https%3A%2F%2Fsite1.com' } });
  });

  it('correctly matches routes with multiple dynamic parameters', () => {
    const result = matchPath('GET', '/users/123/orders/456', routeDefinitions);
    expect(result).to.deep.equal({
      handler: 'userOrderHandler',
      params: { userId: '123', orderId: '456' },
    });
  });

  it('returns null for non-existent routes', () => {
    expect(matchPath('GET', '/non-existent', routeDefinitions)).to.be.null;
  });

  it('handles edge cases', () => {
    // Test empty path, trailing slashes, and non-string inputs
    expect(matchPath('GET', '/home/', routeDefinitions)).to.be.null;
  });

  it('does not match incorrect dynamic routes', () => {
    // Test incorrect dynamic segment, extra segments, and missing segments
    expect(matchPath('GET', '/users/', routeDefinitions)).to.be.null;
    expect(matchPath('GET', '/users/123/extra', routeDefinitions)).to.be.null;
    expect(matchPath('GET', '/products/', routeDefinitions)).to.be.null;
  });

  it('throws an error if httpMethod is not provided', () => {
    expect(() => matchPath(null, '/home', routeDefinitions)).to.throw('HTTP method required');
  });

  it('throws an error if incomingPath is not provided', () => {
    expect(() => matchPath('GET', null, routeDefinitions)).to.throw('Incoming path required');
  });

  it('throws an error if routeDefinitions is not provided', () => {
    expect(() => matchPath('GET', '/home')).to.throw('Route definitions required');
  });

  it('throws an error if staticRoutes is not provided', () => {
    expect(() => matchPath('GET', '/home', { dynamicRoutes })).to.throw('Route definitions required');
  });

  it('throws an error if dynamicRoutes is not provided', () => {
    expect(() => matchPath('GET', '/home', { staticRoutes })).to.throw('Route definitions required');
  });
});
