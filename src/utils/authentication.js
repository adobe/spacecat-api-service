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

const SERVICE_CODE = 'dx_aem_perf';

export const isAdmin = (context) => {
  const { attributes: { authInfo: { scopes } } } = context;
  return scopes.some((scope) => scope.name === 'admin');
};

export const userBelongsToOrg = (context) => {
  const {
    attributes: { authInfo: { profile } },
    params: { organizationId },
  } = context;
  return profile.id === organizationId || isAdmin(context);
};

export const userHasSubService = (context, subService) => {
  const { attributes: { authInfo: { scopes } } } = context;
  return scopes.some(
    (scope) => scope.name === 'user' && scope.subScopes.includes(`${SERVICE_CODE}_${subService}`),
  ) || isAdmin(context);
};
