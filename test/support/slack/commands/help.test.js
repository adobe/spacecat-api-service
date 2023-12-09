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

/* eslint-env mocha */

import { expect } from 'chai';
import sinon from 'sinon';
import HelpCommand from '../../../../src/support/slack/commands/help.js';

describe('HelpCommand', () => {
  let context;
  let say;

  beforeEach(() => {
    context = {}; // Mock any required context properties
    say = sinon.stub();
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = HelpCommand(context);

      expect(command.id).to.equal('help');
      expect(command.name).to.equal('Help');
      expect(command.description).to.equal('Displays a help message');
      expect(command.phrases).to.deep.equal(['help', 'what can you do']);
    });
  });

  describe('Handle Execution Method', () => {
    it('sends a help message with a list of commands', async () => {
      const mockCommands = [
        { name: 'Command1', usage: () => 'Usage1', description: 'Description1' },
        { name: 'Command2', usage: () => 'Usage2', description: 'Description2' },
        // Add more mock commands as needed
      ];
      const command = HelpCommand(context);

      await command.handleExecution([], say, mockCommands);

      expect(say.called).to.be.true;
      const { blocks } = say.firstCall.args[0];
      expect(blocks[0].text.text).to.include('Greetings, I am SpaceCat');
      for (let i = 0; i < mockCommands.length; i += 1) {
        expect(blocks[i + 1].text.text).to.include(mockCommands[i].name);
        expect(blocks[i + 1].text.text).to.include(mockCommands[i].usage());
        expect(blocks[i + 1].text.text).to.include(mockCommands[i].description);
      }
    });
  });
});
