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
import help from './commands/help.js';
import updateSitesAudits from './commands/update-sites-audits.js';

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
  help(context),
  updateSitesAudits(context),
];
