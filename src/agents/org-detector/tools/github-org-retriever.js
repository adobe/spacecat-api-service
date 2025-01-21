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
import { JSDOM } from 'jsdom';
import { Octokit } from '@octokit/rest';
import { fetch } from '../../../support/utils.js';

/**
 * Scrapes the GitHub organization name from the organization's GitHub page.
 *
 * @param {string} orgLogin - The GitHub organization login (e.g., "aemsites").
 * @param {object} log - logger
 * @returns {Promise<string|null>} - The scraped github org name, or `null` if not found.
 */
async function scrapeGithubOrgName(orgLogin, log) {
  const url = `https://github.com/${orgLogin}`;

  try {
    const response = await fetch(url);

    /* c8 ignore next 3 */
    if (!response.ok) {
      throw new Error(`Failed to fetch GitHub page: ${response.statusText}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html);
    const { document } = dom.window;

    const orgElement = document.querySelector('h1[class*="sso-title"] strong');
    if (!orgElement) {
      log.info(`Organization name not found on GitHub page for ${orgLogin}`);
      return '';
    }

    return orgElement.textContent.trim();
    /* c8 ignore next 4 */
  } catch (error) {
    log.error(`Error scraping GitHub organization name for ${orgLogin}: ${error.message}`);
    return '';
  }
}

/**
 * Retrieves the GitHub organization name.
 * First attempts to fetch data using the GitHub API. If that fails for client errors (4xx),
 * it falls back to scraping the organization's GitHub page.
 *
 * @param {string} orgLogin - The GitHub organization login (e.g., "aemsites").
 * @param {string[]} ignoredGithubOrgs - A list of GitHub organization slugs to ignore.
 * @param {object} log - logger
 * @returns {Promise<string|null>} - The organization name, or `null` if not found or ignored.
 */
export async function getGithubOrgName(orgLogin, ignoredGithubOrgs, log) {
  if (ignoredGithubOrgs.includes(orgLogin)) {
    log.info(`Organization ${orgLogin} is in the ignored list.`);
    return '';
  }

  const octokit = new Octokit();

  try {
    const { data } = await octokit.users.getByUsername({ username: orgLogin });
    return data?.name || '';
  } catch (error) {
    // fall back to scraping for client errors (4xx)
    if (error.status && error.status >= 400 && error.status < 500) {
      log.info(`Falling back to scraping for organization ${orgLogin}...`);
      return scrapeGithubOrgName(orgLogin, log);
    }

    log.error(`Error fetching organization name for ${orgLogin}: ${error.message}`);
    return '';
  }
}
