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

import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Matches the http method and path to a route handler. Returns null if no match.
 * @param {string} httpMethod - HTTP method
 * @param {string} incomingPath - Incoming path
 * @param {object} routeDefinitions - Route definitions
 * @param {object} routeDefinitions.staticRoutes - Static routes
 * @param {object} routeDefinitions.dynamicRoutes - Dynamic routes
 * @return {object} Route match result
 * @return {function} Route match result.handler - Route handler
 * @return {object} Route match result.params - Route params
 */
export default function matchPath(httpMethod, incomingPath, routeDefinitions) {
  if (!hasText(httpMethod)) {
    throw new Error('HTTP method required');
  }

  if (!hasText(incomingPath)) {
    throw new Error('Incoming path required');
  }

  if (!routeDefinitions) {
    throw new Error('Route definitions required');
  }

  const { staticRoutes, dynamicRoutes } = routeDefinitions;

  if (!staticRoutes || !dynamicRoutes) {
    throw new Error('Route definitions required');
  }

  const incomingSegments = incomingPath.split('/').filter(Boolean);

  // Use both method and path to match the route
  const methodAndPath = `${httpMethod.toUpperCase()} ${incomingPath}`;

  // Check static routes first
  if (staticRoutes[methodAndPath]) {
    return { handler: staticRoutes[methodAndPath], params: {} };
  }

  // Use reduce to find the matching dynamic route
  return Object.entries(dynamicRoutes).reduce((
    matched,
    [routePattern, { handler, paramNames }],
  ) => {
    if (matched) return matched; // If already matched, return the result

    const [patternMethod, ...patternPathSegments] = routePattern.split(' ');
    const patternPath = patternPathSegments.join('/');
    const routeSegments = patternPath.split('/').filter(Boolean);

    if (patternMethod.toUpperCase() !== httpMethod.toUpperCase()
      || routeSegments.length !== incomingSegments.length) {
      return matched; // Continue reducing if no match
    }

    const isMatch = routeSegments.every((segment, index) => {
      if (segment.startsWith(':')) {
        return true; // Dynamic segment always matches
      }
      return segment === incomingSegments[index]; // Check static segment match
    });

    if (isMatch) {
      let dynamicIndex = 0; // Counter for dynamic segment index in paramNames
      const params = routeSegments.reduce((routeParams, segment, index) => {
        if (segment.startsWith(':')) {
          // eslint-disable-next-line no-param-reassign
          routeParams[paramNames[dynamicIndex]] = incomingSegments[index];
          dynamicIndex += 1;
        }
        return routeParams;
      }, {});

      return { handler, params };
    }

    return null; // Continue reducing if no match
  }, null); // Initial value is null
}

export function sanitizePath(path) {
  if (path.startsWith('/hooks')) {
    const segments = path.split('/');
    segments[segments.length - 1] = segments[segments.length - 1].replace(/./g, '*');
    return segments.join('/');
  }
  return path;
}
