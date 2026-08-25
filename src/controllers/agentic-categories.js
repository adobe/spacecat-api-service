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

import { createRulesController } from './agentic-rules-factory.js';

/**
 * Customer-edit endpoints for auto-derived URL category rules
 * (`agentic_url_category_rules`).
 */
export default function AgenticCategoriesController() {
  return createRulesController({
    tableName: 'agentic_url_category_rules',
    dimensionLabel: 'category',
  });
}
