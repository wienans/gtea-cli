---
name: implement-next-task
description: Implement the next ready-for-agent task from the issue tracker. Use TDD and feedback
---

# ISSUES
Get the open issues in the repo:

!gh issue list --state open --label ready-for-agent --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'

# TASK
Analyze the open issues and build a dependency graph. For each issue, determine whether it blocks or is blocked by any other open issue.

An issue B is blocked by issue A if:

B requires code or infrastructure that A introduces
B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
B's requirements depend on a decision or API shape that A will establish
An issue is unblocked if it has zero blocking dependencies on other open issues.

For each unblocked issue, assign a branch name using the format gtea-cli/issue-{number}-{slug}.

If the issue appears to be a PRD and it has implementation issues which link to it, the PRD cannot be worked on.

Fix issue the next unblocked issue, if there are multiple, pick the one which look most likely to be the next reasonable step.

Pull in the issue using `gh issue view`, with comments. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch gtea-cli/issue-{number}-{slug}. Make commits, run tests.

# CONTEXT
Get the last last 10 commits:

`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

# EXPLORATION
Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION
Use the tdd skill with Red-Green-Refactor cycle to implement the task.

Before committing, typecheck and tests to ensure the tests pass.

# COMMIT
Make a git commit. The commit message must:

Start with RALPH: prefix
Include task completed + PRD reference
Key decisions made
Files changed
Blockers or notes for next iteration
Keep it concise.

# THE ISSUE
If the task is not complete, leave a comment on the GitHub issue with what was done.

Do not close the issue - this will be done later.

Once complete, output COMPLETE.

# FINAL RULES
ONLY WORK ON A SINGLE TASK.