/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { runEntityTests } from './utils/test-runner.js';
import { organizationSpec } from './specs/organization.spec.js';
import { projectSpec } from './specs/project.spec.js';
import { siteSpec } from './specs/site.spec.js';
import { opportunitySpec } from './specs/opportunity.spec.js';
import { suggestionSpec } from './specs/suggestion.spec.js';
import { fixSpec } from './specs/fix.spec.js';
import { urlStoreSpec } from './specs/url-store.spec.js';

runEntityTests(organizationSpec);
runEntityTests(projectSpec);
runEntityTests(siteSpec);
runEntityTests(opportunitySpec);
runEntityTests(suggestionSpec);
runEntityTests(fixSpec);
runEntityTests(urlStoreSpec);
