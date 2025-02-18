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
    return { actions: [] };
  }

  const match = permissions.find((p) => {
    const pp = p.path;
    const ep = prepSingleStarWildcard(entityPath, pp);

    if (pp.endsWith('/**')) {
      return ep.startsWith(pp.slice(0, -2));
    }
    if (pp.endsWith('/+**')) {
      return ep.concat('/').startsWith(pp.slice(0, -3));
    }
    return ep === pp;
  });

  if (!match) {
    return { actions: [] };
  }
  return { actions: match.actions, trace: match };
}

export function hasPermisson(entityPath, aclCtx, perm) {
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
    console.log('§§§ Permission granted for', entityPath, 'with', perm, 'traces:', traces);
  }
  return permission;
}

export function ensurePermission(path, aclCtx, perm) {
  console.log(
    '§§§ Calling ensurePermission with path:',
    path,
    'aclCtx:',
    JSON.stringify(aclCtx),
    'perm:',
    perm,
    'response:',
    hasPermisson(path, aclCtx, perm),
  );
  if (!hasPermisson(path, aclCtx, perm)) {
    throw new Error('Permission denied');
  }
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
