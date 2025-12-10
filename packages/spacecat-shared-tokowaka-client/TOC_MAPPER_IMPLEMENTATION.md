# TOC Mapper Implementation Summary

## Overview
Successfully implemented a new `TocMapper` for handling Table of Contents (TOC) opportunity suggestions in the Tokowaka Client system.

## Files Created/Modified

### New Files Created:
1. **src/mappers/toc-mapper.js** - Main TOC mapper implementation
2. **test/mappers/toc-mapper.test.js** - Comprehensive test suite (22 test cases)

### Modified Files:
1. **src/mappers/mapper-registry.js** - Registered TocMapper in the default mappers
2. **src/index.d.ts** - Added TypeScript definitions for TocMapper

## Implementation Details

### TocMapper Class
- **Opportunity Type**: `'toc'`
- **Prerender Required**: `true` (TOC modifications need pre-rendered content)
- **Target**: `AI_BOTS` (changes only visible to AI bots/LLMs)
- **Value Format**: `HAST` (HTML Abstract Syntax Tree)

### Supported Operations
- **Actions**: `insertBefore`, `insertAfter`
- **Value Format**: `hast` (required)
- **Selector**: CSS selector (required)
- **Value**: HAST structure representing the TOC navigation

### Validation Rules
The `canDeploy()` method validates:
1. ✅ `checkType` must be `'toc'`
2. ✅ `transformRules.selector` must be present (CSS selector)
3. ✅ `transformRules.value` must be present (HAST structure)
4. ✅ `transformRules.valueFormat` must be `'hast'`
5. ✅ `transformRules.action` must be `'insertBefore'` or `'insertAfter'`

### Example Suggestion Data
```json
{
  "checkType": "toc",
  "recommendedAction": "Add a Table of Contents to the page",
  "transformRules": {
    "action": "insertAfter",
    "selector": "h1#main-heading",
    "valueFormat": "hast",
    "value": {
      "type": "root",
      "children": [
        {
          "type": "element",
          "tagName": "nav",
          "properties": { "className": ["toc"] },
          "children": [
            {
              "type": "element",
              "tagName": "ul",
              "children": [...]
            }
          ]
        }
      ]
    }
  }
}
```

### Generated Patch Structure
```json
{
  "opportunityId": "opp-123",
  "suggestionId": "sugg-456",
  "prerenderRequired": true,
  "lastUpdated": 1702123456789,
  "op": "insertAfter",
  "selector": "h1#main-heading",
  "value": { /* HAST structure */ },
  "valueFormat": "hast",
  "target": "ai-bots"
}
```

## Test Coverage

### Test Suite Statistics
- **Total Test Cases**: 22
- **Coverage**: 100% (statements, branches, functions, lines)
- **Test Categories**:
  - Basic functionality (2 tests)
  - Validation - positive cases (2 tests)
  - Validation - negative cases (11 tests)
  - Patch generation (7 tests)

### Test Categories

#### 1. Basic Functionality
- Returns correct opportunity type (`'toc'`)
- Returns correct prerender requirement (`true`)

#### 2. Validation - Positive Cases
- Valid TOC with `insertAfter`
- Valid TOC with `insertBefore`

#### 3. Validation - Negative Cases
- Non-toc checkType
- Missing checkType
- Null data
- Missing selector
- Empty selector
- Missing value
- Missing valueFormat
- Invalid valueFormat (not 'hast')
- Invalid action (e.g., 'replace')
- Missing action

#### 4. Patch Generation
- Create patch with `insertAfter`
- Create patch with `insertBefore`
- Handle complex nested TOC structures
- Reject invalid suggestions
- Handle missing transformRules
- Log warnings for invalid suggestions
- Handle multiple suggestions
- Filter mixed valid/invalid suggestions

## Integration

The TOC mapper is now:
1. ✅ Registered in the `MapperRegistry`
2. ✅ Automatically available to `TokowakaClient`
3. ✅ Fully tested and covered
4. ✅ Type-safe with TypeScript definitions

## Usage

The mapper is automatically used when deploying TOC suggestions:

```javascript
import TokowakaClient from '@adobe/spacecat-shared-tokowaka-client';

const client = TokowakaClient.createFrom(context);

// Mapper automatically selected based on opportunity.getType() === 'toc'
const result = await client.deploySuggestions(
  site,
  opportunity, // opportunity type must be 'toc'
  suggestions  // suggestions with checkType: 'toc'
);
```

## Key Features

1. **Strict Validation**: Only valid TOC suggestions with proper HAST structure are deployed
2. **AI-Only Targeting**: TOC changes only visible to AI bots, not real users
3. **Flexible Placement**: Supports both `insertBefore` and `insertAfter` actions
4. **Complex Structures**: Handles nested TOC hierarchies with multiple levels
5. **Error Handling**: Comprehensive validation with clear error messages
6. **100% Test Coverage**: All code paths tested and verified

## Test Results

```
✔ 359 passing (196ms)
✔ 100% code coverage maintained across all files
✔ toc-mapper.js: 100% statements, branches, functions, lines
```

## Related Files
- Base class: `src/mappers/base-mapper.js`
- Registry: `src/mappers/mapper-registry.js`
- Similar mapper: `src/mappers/content-summarization-mapper.js` (also uses HAST)
- Type definitions: `src/index.d.ts`

## Future Enhancements
Potential future improvements:
- Support for `appendChild` action if needed
- TOC style customization options
- Automatic TOC generation from page headings
- Multi-level TOC depth configuration

