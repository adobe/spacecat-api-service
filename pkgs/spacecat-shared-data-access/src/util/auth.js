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

function getPermissions(entityPath, permissions) {
  if (!permissions) {
    return [];
  }

  const match = permissions.find((p) => {
    const pp = p.path;
    const ep = prepSingleStarWildcard(entityPath, pp);

    if (pp.endsWith('/**')) {
      return ep.startsWith(pp.slice(0, -2));
    }
    return ep === pp;
  });

  if (!match) {
    return [];
  }
  return match.actions;
}

function identStr(prefix, val) {
  if (!val) {
    return undefined;
  }
  return prefix.concat(val);
}

export function hasPermisson(entityPath, aclCtx, perm) {
  const { user } = aclCtx;
  const org = user.org?.ident;
  const idents = (user.groups || [])
    .map((g) => `orgID/group:${org}/${g.name}`)
    .concat(identStr('email:', user.email))
    .concat(identStr('ident:', user.ident))
    .concat(identStr('orgID:', org))
    .filter((e) => e !== undefined);

  const permissions = new Map();
  aclCtx.acls.forEach((a) => permissions.set(`${a.identType}:${a.ident}`, a.acl));

  const actions = [];
  idents.forEach((i) => {
    actions.push(...getPermissions(entityPath, permissions.get(i)));
  });
  return actions.includes(perm);
}

export function ensurePermission(path, aclCtx, perm) {
  console.log('*** Calling ensurepermission with path:', path, 'aclCtx:', aclCtx, 'perm:', perm);
  // if (!hasPermisson(path, aclCtx, perm)) {
  //   throw new Error('Permission denied');
  // }
}

function prepPathForSort(path) {
  if (path.endsWith('/+**')) return path.slice(0, -3);
  if (path.endsWith('/**')) return path.slice(0, -2);
  return path;
}

export function pathSorter({ path: path1 }, { path: path2 }) {
  const sp1 = prepPathForSort(path1);
  const sp2 = prepPathForSort(path2);
  return sp2.length - sp1.length;
}
