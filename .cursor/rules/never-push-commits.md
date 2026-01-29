# Never Commit or Push Code

## Critical Rule

**NEVER use git commit or git push commands unless explicitly requested by the user.**

This includes:
- `git commit`
- `git commit -m`
- `git add && git commit`
- `git push`
- `git push --force`
- `git push --force-with-lease`

## What to do instead

1. Make the code changes
2. Run tests locally to verify
3. Show the user what changed
4. Let the USER decide when to commit and push

## Exception

Only commit/push if the user explicitly says:
- "commit this"
- "push this" 
- "commit and push"
- Or similar direct instruction

**DO NOT commit or push as part of "completing the task" or "fixing the issue".**
