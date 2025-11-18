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
import getSiteAudits from './commands/get-site-audits.js';
import martechImpact from './commands/martech-impact.js';
import runAudit from './commands/run-audit.js';
import runImport from './commands/run-import.js';
import runInternalReport from './commands/run-internal-report.js';
import runReport from './commands/run-report.js';
import runScrape from './commands/run-scrape.js';
import setLiveStatus from './commands/set-live-status.js';
import getGoogleLink from './commands/create-google-link.js';
import help from './commands/help.js';
import toggleSiteAudit from './commands/toggle-site-audit.js';
import onboard from './commands/onboard.js';
import llmoOnboard from './commands/llmo-onboard.js';
import setSiteOrganizationCommand from './commands/set-ims-org.js';
import toggleSiteImport from './commands/toggle-site-import.js';
import runTrafficAnalysisBackfill from './commands/run-traffic-analysis-backfill.js';
import backfillLlmo from './commands/backfill-llmo.js';
import getPromptUsage from './commands/get-prompt-usage.js';
import getLlmoConfigSummary from './commands/get-llmo-config-summary.js';
import getLlmoOpportunityUsage from './commands/get-llmo-opportunity-usage.js';
import runBrandProfile from './commands/run-brand-profile.js';

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
  getSiteAudits(context),
  martechImpact(context),
  runAudit(context),
  runImport(context),
  runInternalReport(context),
  runReport(context),
  runScrape(context),
  runTrafficAnalysisBackfill(context),
  setLiveStatus(context),
  getGoogleLink(context),
  help(context),
  toggleSiteAudit(context),
  onboard(context),
  llmoOnboard(context),
  setSiteOrganizationCommand(context),
  toggleSiteImport(context),
  backfillLlmo(context),
  getPromptUsage(context),
  getLlmoConfigSummary(context),
  getLlmoOpportunityUsage(context),
  runBrandProfile(context),
];
