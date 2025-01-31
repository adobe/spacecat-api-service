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

import BaseModel from '../base/base.model.js';

/**
 * KeyEvent - A class representing an KeyEvent entity.
 * Provides methods to access and manipulate KeyEvent-specific data.
 *
 * @class KeyEvent
 * @extends BaseModel
 */
class KeyEvent extends BaseModel {
  static KEY_EVENT_TYPES = {
    PERFORMANCE: 'PERFORMANCE',
    SEO: 'SEO',
    CONTENT: 'CONTENT',
    CODE: 'CODE',
    THIRD_PARTY: 'THIRD PARTY',
    EXPERIMENTATION: 'EXPERIMENTATION',
    NETWORK: 'NETWORK',
    STATUS_CHANGE: 'STATUS CHANGE',
  };

  // add your custom methods or overrides here
}

export default KeyEvent;
