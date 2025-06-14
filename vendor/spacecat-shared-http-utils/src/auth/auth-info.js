/*
 * Copyright 2024 Adobe. All rights reserved.
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
 * The auth info class represents information about the current authentication state.
 */
export default class AuthInfo {
  constructor() {
    Object.assign(this, {
      authenticated: false,
      profile: null,
      scopes: [],
    });
  }

  /**
   * Set the authenticated flag.
   * @param {boolean} value - The value of the authenticated flag
   * @returns {AuthInfo} The auth info object
   */
  withAuthenticated(value) {
    this.authenticated = value;
    return this;
  }

  /**
   * Set the profile. A profile is an object that contains information about the user.
   * @param {Object} profile - The user profile
   * @return {AuthInfo} The auth info object
   */
  withProfile(profile) {
    this.profile = profile;
    return this;
  }

  /**
   * Set the type of the authentication that was performed.
   * @param {string} value - The type of the authentication
   * @return {AuthInfo} The auth info object
   */
  withType(value) {
    this.type = value;
    return this;
  }

  /**
   * Set the reason that authentication has failed.
   * @param {string} reason - The reason for auth failure
   * @return {AuthInfo} The auth info object
   */
  withReason(reason) {
    this.reason = reason;
    return this;
  }

  /**
   * Set the scopes that this auth info instance has access to.
   * @param {Array<{name: string, domains?: Array<string>}>} scopes - The array of scope objects
   * @return {AuthInfo} The auth info object
   */
  withScopes(scopes) {
    this.scopes = scopes;
    return this;
  }

  getType() { return this.type; }

  getScopes() { return this.scopes; }

  getProfile() { return this.profile; }

  getReason() { return this.reason; }

  isAuthenticated() { return this.authenticated; }

  isAdmin() { return this.profile?.is_admin; }

  hasOrganization(orgId) {
    const [id] = orgId.split('@');
    return this.profile?.tenants?.some(
      (tenant) => tenant.id === id,
    );
  }

  hasScope(name, subScope) {
    return this.scopes.some((scope) => scope.name === name
      && (!subScope || scope.subScopes?.includes(subScope)));
  }
}
