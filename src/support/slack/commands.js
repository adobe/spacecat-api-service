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

import addRepo from './commands/add-repo.js';
import addSite from './commands/add-site.js';
import getExpCandidates from './commands/get-exp-candidates.js';
import getSite from './commands/get-site.js';
import getSites from './commands/get-sites.js';
import martechImpact from './commands/martech-impact.js';
import runAudit from './commands/run-audit.js';
import runImport from './commands/run-import.js';
import runScrape from './commands/run-scrape.js';
import setLiveStatus from './commands/set-live-status.js';
import getGoogleLink from './commands/create-google-link.js';
import help from './commands/help.js';
import toggleSiteAudit from './commands/toggle-site-audit.js';
import onboard from './commands/onboard.js';
import setSiteOrganizationCommand from './commands/set-ims-org.js';
import toggleSiteImport from './commands/toggle-site-import.js';

/**
 * Returns all commands.
 *
 * @param {object} context - Context.
 * @return {Array} Commands.
 */
export default (context) => [
  addRepo(context),
  addSite(context),
  getExpCandidates(context),
  getSite(context),
  getSites(context),
  martechImpact(context),
  runAudit(context),
  runImport(context),
  runScrape(context),
  setLiveStatus(context),
  getGoogleLink(context),
  help(context),
  toggleSiteAudit(context),
  onboard(context),
  setSiteOrganizationCommand(context),
  toggleSiteImport(context),
];
