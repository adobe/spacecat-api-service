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

import type { UniversalContext } from '@adobe/helix-universal';

export class ImsClient {
  /**
   * Creates a new ImsClient instance from the given UniversalContext.
   * @param {UniversalContext} context The UniversalContext to use for creating the ImsClient.
   * @returns {ImsClient} The ImsClient instance.
   */
  static createFrom(context: UniversalContext): ImsClient;

  /**
   * Returns an access token for the scopes associated with the IMS client ID.
   * @returns {Promise<{ access_token: string }>} The access token.
   */
  getServiceAccessToken(): Promise<string>;

  /**
   * Returns an access token for the scopes associated with the IMS client ID using the v3 APIs.
   * @returns {Promise<{ access_token: string }>} The access token.
   */
  getServiceAccessTokenV3(): Promise<string>;

  /**
   * Returns the organization details for the given IMS organization ID.
   * @param {string} imsOrgId The IMS organization ID.
   * @returns {Promise<{
   *       imsOrgId: string,
   *       tenantId: string,
   *       orgName: string,
   *       orgType: string,
   *       countryCode: string,
   *       admins: {
   *               email: string,
   *               firstName: string,
   *               lastName: string,
   *             }[],
   *     }>} The organization details.
   */
  getImsOrganizationDetails(imsOrgId: string): Promise<object>;

  /**
   * Returns the user profile for the given IMS access token.
   * @param {string} imsAccessToken The IMS access token.
   * @returns {Promise<object>} The user profile.
   */
  getImsUserProfile(imsAccessToken: string): Promise<object>;

  /**
   * Returns the user organizations for the given IMS access token.
   * @param {string} imsAccessToken The IMS access token.
   * @returns {Promise<object>} The user organizations
   * @throws {Error} If the request fails.
   */
  getImsUserOrganizations(imsAccessToken: string): Promise<object>;

  /**
   * Returns the user organizations for the given IMS access token using the v3 APIs.
   * @param {string} imsAccessToken The IMS access token.
   * @returns {Promise<object>} The user organizations
   * @throws {Error} If the request fails.
   */
  validateAccessToken(imsAccessToken: string): Promise<boolean>;
}
