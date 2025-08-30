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

import approveFriendsFamily from './approve-friends-family.js';
import approveOrg from './approve-org.js';
import approveSiteCandidate from './approve-site-candidate.js';
import ignoreSiteCandidate from './ignore-site-candidate.js';
import rejectOrg from './reject-org.js';
import { startLLMOOnboarding, onboardLLMOModal } from './onboard-llmo-modal.js';
import { onboardSiteModal, startOnboarding } from './onboard-modal.js';
import { preflightConfigModal } from './preflight-config-modal.js';
import openPreflightConfig from './open-preflight-config.js';

const actions = {
  approveFriendsFamily,
  approveOrg,
  approveSiteCandidate,
  ignoreSiteCandidate,
  rejectOrg,
  onboardSiteModal,
  onboardLLMOModal,
  start_onboarding: startOnboarding,
  start_llmo_onboarding: startLLMOOnboarding,
  preflight_config_modal: preflightConfigModal,
  open_preflight_config: openPreflightConfig,
};

export default actions;
