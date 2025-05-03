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

/* eslint-env mocha */

import { expect } from 'chai';
import * as workflowHandler from '../../../../../src/support/slack/commands/step_functions/workflow-handler.js';

describe('Workflow Handler Tests', () => {
  it('should have an exported handler function', () => {
    // This is a dummy test to verify the module structure
    expect(workflowHandler.handler).to.be.a('function');
  });

  it('should have an exported handleWorkflowCommand function', () => {
    // This is a dummy test to verify the module structure
    expect(workflowHandler.handleWorkflowCommand).to.be.a('function');
  });

  it('should have an exported processBatchImports function', () => {
    // This is a dummy test to verify the module structure
    expect(workflowHandler.processBatchImports).to.be.a('function');
  });

  it('should have an exported processBatchAudits function', () => {
    // This is a dummy test to verify the module structure
    expect(workflowHandler.processBatchAudits).to.be.a('function');
  });

  it('should have an exported disableImportsAndAudits function', () => {
    // This is a dummy test to verify the module structure
    expect(workflowHandler.disableImportsAndAudits).to.be.a('function');
  });
});
