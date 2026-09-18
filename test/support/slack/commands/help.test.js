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

import { expect } from 'chai';
import sinon from 'sinon';
import HelpCommand from '../../../../src/support/slack/commands/help.js';

describe('HelpCommand', () => {
  let context;
  let slackContext;

  beforeEach(() => {
    context = {}; // Mock any required context properties
    slackContext = { say: sinon.spy() };
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

      await command.handleExecution([], slackContext, mockCommands);

      expect(slackContext.say.called).to.be.true;
      const { blocks } = slackContext.say.firstCall.args[0];
      expect(blocks[0].text.text).to.include('Greetings, I am SpaceCat');
      // Command entries are packed across one or more section blocks after the intro; assert
      // every command's name, usage and description appears somewhere in the rendered help.
      const renderedCommands = blocks.slice(1).map((block) => block.text.text).join('\n');
      for (const mockCommand of mockCommands) {
        expect(renderedCommands).to.include(mockCommand.name);
        expect(renderedCommands).to.include(mockCommand.usage());
        expect(renderedCommands).to.include(mockCommand.description);
      }
    });

    it('keeps the help message within Slack\'s 50-block limit for large command sets', async () => {
      const mockCommands = Array.from({ length: 60 }, (_, i) => ({
        name: `Command${i}`,
        usage: () => `Usage${i}`,
        description: `Description${i}`,
      }));
      const command = HelpCommand(context);

      await command.handleExecution([], slackContext, mockCommands);

      const { blocks } = slackContext.say.firstCall.args[0];
      expect(blocks.length).to.be.at.most(50);
    });

    it('splits commands across section blocks without exceeding the 3000-char limit or dropping any', async () => {
      // Long descriptions force the packer to split the command list across several section blocks.
      const mockCommands = Array.from({ length: 60 }, (_, i) => ({
        name: `Command${i}`,
        usage: () => `Usage${i}`,
        description: `Description${i} `.repeat(20).trim(),
      }));
      const command = HelpCommand(context);

      await command.handleExecution([], slackContext, mockCommands);

      const { blocks } = slackContext.say.firstCall.args[0];
      expect(blocks.length).to.be.greaterThan(2); // intro + at least two packed blocks
      blocks.forEach((block) => expect(block.text.text.length).to.be.at.most(3000));
      const renderedCommands = blocks.slice(1).map((block) => block.text.text).join('\n');
      mockCommands.forEach((mockCommand) => expect(renderedCommands).to.include(mockCommand.name));
    });

    it('renders only the intro block when there are no commands', async () => {
      const command = HelpCommand(context);

      await command.handleExecution([], slackContext, []);

      const { blocks } = slackContext.say.firstCall.args[0];
      expect(blocks).to.have.length(1);
      expect(blocks[0].text.text).to.include('Greetings, I am SpaceCat');
    });
  });
});
