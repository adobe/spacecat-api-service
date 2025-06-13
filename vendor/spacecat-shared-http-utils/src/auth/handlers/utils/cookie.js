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
 * Gets the raw cookie string from the context
 * @param {Object} context - The context object containing pathInfo
 * @returns {string|null} The cookie string or null if not found
 */
export const getCookie = (context) => {
  const cookie = context.pathInfo?.headers?.cookie || '';

  if (!cookie) {
    return null;
  }

  return cookie;
};

/**
 * Parses and retrieves a specific cookie value by name
 * @param {Object} context - The context object containing pathInfo
 * @param {string} name - The name of the cookie to retrieve
 * @returns {string|null} The cookie value or null if not found
 */
export const getCookieValue = (context, name) => {
  const cookieString = getCookie(context);
  if (!cookieString) return null;

  const cookies = cookieString.split(';');
  for (const cookie of cookies) {
    const [cookieName, cookieValue] = cookie.trim().split('=');
    if (cookieName === name) {
      return cookieValue;
    }
  }
  return null;
};
