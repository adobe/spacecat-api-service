---
name: Review Branch
description: Review a branch against remote origin main using project standards
---

Review the branch `{{branch_name:current}}` against `{{base_branch:origin/main}}`.

## Review Process

1. **Get Context**: Fetch latest origin/main, then run git diff and log commands to understand the changes
2. **Apply Rules**: Review against @.github/copilot-instructions.md and applicable rules in @.cursor/rules/
3. **Critical Checks**: Follow severity definitions and core checks from copilot-instructions.md
4. **Output**: Provide structured markdown review below

## Output Format

```markdown
# Code Review: [Branch Name]

## Summary
[1-3 sentences describing overall health of the PR]

## Issues

### Critical
[Issues that block merge - bugs, security, missing tests for behavior changes, missing access control]

### Major
[Issues that should be fixed - missing docs, performance concerns]

### Minor
[Optional improvements - only list if no Critical issues exist]

## Suggested Tests
[Describe missing test coverage if applicable]

## Checklist Review

- [ ] **Security & Authorization**: AccessControlUtil instantiated and called (hasAdminAccess/hasAccess)
- [ ] **Bug & Regression**: Null checks, async/await, logic changes match tests
- [ ] **Routing**: Endpoints in BOTH src/index.js and src/routes/index.js
- [ ] **UUID Validation**: All IDs validated with isValidUUIDV4
- [ ] **DTOs & Models**: DTOs used, no raw database models leaked
- [ ] **Tests**: Behavior changes covered, fixtures updated
- [ ] **HTTP Helpers**: Using @adobe/spacecat-shared-http-utils
- [ ] **Shared Utils**: Using @adobe/spacecat-shared-utils instead of custom checks whenever possible
- [ ] **Documentation**: OpenAPI specs if endpoints changed, README, config/default.json updated for new features

## Final Assessment

**Status:** [READY TO MERGE | REQUIRES FIX | BLOCKED]

[Brief explanation and estimated fix time if issues exist]
```

## Important

- **DO NOT** post comments to GitHub
- **FOCUS** on Critical issues first per copilot-instructions.md
- **CITE** specific files and line numbers for issues
- **OUTPUT** the structured markdown review above for discussion
- **THEN** propose specific code changes to fix Critical and Major issues
- **REFERENCE** the review findings when proposing changes