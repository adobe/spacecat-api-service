/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * Convert the entity path so that it can be comparted with a permission path
 * for if the permission path contains a single star wildcard. This is done by replacing
 * the elements in the entity path on the same location with the '*'. Some examples:
 * entityPath: '/foo/bar' and permPath: '/foo/*' => '/foo/*'
 * entityPath: '/foo/bar' and permPath: '/foo/**' => '/foo/bar'
 * @param {string} entityPath The entity path to convert
 * @param {string} permPath The permission path
 * @returns The converted entity path
 */
function prepSingleStarWildcard(entityPath, permPath) {
  if (!permPath.includes('/*')) {
    return entityPath;
  }

  const epa = entityPath.split('/');
  const ppa = permPath.split('/');
  if (epa.length < ppa.length) {
    return entityPath;
  }

  const indexes = ppa.reduce((a, e, i) => ((e === '*') ? a.concat(i) : a), []);
  indexes.forEach((idx) => {
    epa[idx] = '*';
  });
  return epa.join('/');
}

/**
 * Get the actions permitted for the path by checking the acl. THE ACL IS ASSUMED TO BE SORTED
 * BY PATH LENGTH IN DESCENDING ORDER. This is important because the first match is the one that
 * is used. So the longest path wins.
 * The following matches are considered:
 * - exact match
 * - path ending with '/**' which is a wildcard for all paths starting with the same prefix
 * - path containing 'slash*slash' or ending with '/*' which is a wildcard for all elements
 *   at that position.
 * @param { string } path - the path for which the permission is needed.
 * @param { Object } acl - the acls
 * @returns { Object.actions[] } - the actions permitted for the path.If there are none an
 * empty array is returned.
 * @returns { Object.trace } - the acl entry that matched the path, if there is one.
 */
function getPermissions(path, acl) {
  if (!acl) {
    return { actions: [] };
  }

  const match = acl.find((p) => {
    const pp = p.path;
    const ep = prepSingleStarWildcard(path, pp);

    if (pp.endsWith('/**')) {
      return ep.startsWith(pp.slice(0, -2));
    }
    return ep === pp;
  });

  if (!match) {
    return { actions: [] };
  }
  return { actions: match.actions, trace: match };
}

/**
 * Checks if the path has the required permission given the acls in the ACL context. It
 * does this by iterating over the acls (one acl per role) and checking the permitted actions
 * for that path in this acl.
 * For each acl the permitted actions are collectied and finally the union of all these actions
 * is checked for the requested permission.
 * @param {string} path - the path for which the permission is needed.
 * @param {string} perm - the requested permission, typically 'C', 'R', 'U', or 'D'
 * but not necessarily restricted to single characters.
 * @param {Object} aclCtx - the ACL context.
 * @param {Object} log - the logger.
 * @returns {boolean} - true if the permission is granted, false otherwise.
 */
export function hasPermisson(entityPath, perm, aclCtx, log) {
  const allActions = [];
  const traces = [];
  aclCtx.acls.forEach((a) => {
    const { actions, trace } = getPermissions(entityPath, a.acl);
    allActions.push(...actions);
    if (actions.includes(perm)) {
      traces.push({ role: a.role, ...trace });
    }
  });

  const permission = allActions.includes(perm);
  if (permission) {
    log.debug(`Permission granted for ${entityPath} with ${perm} traces: ${JSON.stringify(traces)}`);
  }
  return permission;
}

/**
 * Ensure that the path has the required permission given the acls in the ACL context.
 * If it does, then this function returns normally. If not, it throws an error.
 * @param {string} path - the path for which the permission is needed.
 * @param {string} perm - the requested permission, typically 'C', 'R', 'U', or 'D'
 * but not necessarily restricted to single characters.
 * @param {Object} aclCtx - the ACL context.
 * @param {Object} log - the logger.
 * @throws {Error} - if the permission is not granted.
 */
export function ensurePermission(path, perm, aclCtx, log) {
  const permission = hasPermisson(path, perm, aclCtx, log);
  log.debug(`Check ${perm} access permission for ${path} result: ${permission}`);
  if (!permission) {
    throw new Error('Permission denied');
  }
}
