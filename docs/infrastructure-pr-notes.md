# SpaceCat Workflow Infrastructure Updates

This document outlines the changes made to the SpaceCat workflow infrastructure to improve its scalability and maintainability.

## Key Changes

1. **Simplified Workflow Architecture**:
   - Moved site onboarding logic from the workflow to onboard.js
   - Step Functions workflow now starts with batch imports instead of onboarding
   - Added disable-imports-audits step at the end of the workflow
   - Renamed lambda folder to step_functions for clarity

2. **Streamlined Error Handling**:
   - Failed steps now direct to WorkflowFailed instead of continuing
   - Improved Slack notifications with emoji-based status indicators
   - Final cleanup step runs even after failures

3. **Consolidated Code Location**:
   - Moved workflow code to src/support/slack/commands/step_functions directory
   - Removed redundant site validation checks in workflow-handler.js
   - Improved separation of concerns between components

4. **Scalable Profile-Driven Architecture**:
   - Workflow now uses batch processing for imports and audits
   - Adding new import or audit types to profiles doesn't require workflow definition changes
   - All import/audit types in a profile are automatically processed

## Implementation Details

### Workflow Handler

The workflow handler now includes methods for:
- Batch processing imports via `processBatchImports`
- Batch processing audits via `processBatchAudits`
- Handling notification commands for workflow status updates
- Disabling imports and audits at workflow completion

### Onboard.js

Onboard.js now serves as the central entry point for onboarding:
- Handles site creation and validation
- Enables imports and audits based on profile
- Starts the Step Functions workflow

### Command Flow

The updated command flow:
1. User enters a Slack command for onboarding
2. Onboard.js handles site setup and starts the workflow
3. Step Functions executes batch imports, scrape, and batch audits
4. Automatic cleanup disables imports and audits at workflow completion

### Step Functions Template

The Step Functions template has been updated to:
- Use a simplified workflow with three main steps (Batch Imports, Scrape, Batch Audits), plus Disable Imports/Audits
- Skip redundant site validation checks
- Improve error handling and notification

## Migration Notes

1. The following files have been removed as part of this simplification:
   - run-workflow.js
   - slack-notifier.js
   - command-executor.js
   - check-site-exists.js
   - workflow-starter.js
   - workflow-enabler.js
   - And various other redundant files

2. The documentation has been updated:
   - simplified-workflow.md has been renamed to onboard-workflow.md
   - Updated documentation to reflect the new architecture

3. Code paths have been updated:
   - Functions moved from src/lambda to src/support/slack/commands/step_functions
   - Workflow definition updated in modules/step_functions/templates

## Testing

To test the new workflow:

1. Deploy the infrastructure changes
2. Deploy the API service changes
3. Trigger an onboarding workflow with the Slack command:
   ```
   @spacecat run onboard https://example.com 123456789@AdobeOrg default
   ```

4. Verify in CloudWatch logs that:
   - Site validation happens in onboard.js
   - Batch processing happens for all import and audit types
   - Cleanup occurs at the end of the workflow
   - Slack notifications use the new emoji-based status format 