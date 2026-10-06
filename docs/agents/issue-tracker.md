# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Yelqo/paperclip-outpost`.
Use the `gh` CLI, running inside this repository.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- Read metadata: `gh issue view <number> --json number,title,body,labels,comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
  with appropriate label and state filters.
- Comment: `gh issue comment <number> --body-file <file>`
- Apply labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

For multiline bodies and comments, write the exact text to a temporary
file and pass it with `--body-file`.

Infer the repository from `git remote -v`; `gh` does this automatically
when run inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. When the type of a
reference is unclear, try `gh pr view <number>` and fall back to
`gh issue view <number>`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments` and fetch its labels.

## Wayfinding operations

- Map: a single issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Child ticket: link it to the map as a GitHub sub-issue. If sub-issues
  are unavailable, add it to a task list in the map and put
  `Part of #<map>` at the top of the child body.
- Ticket types: `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, and `wayfinder:task`.
- Blocking: use native GitHub issue dependencies. If unavailable,
  record `Blocked by: #<number>` at the top of the child body.
  A ticket is unblocked when all blockers are closed.
- Frontier: choose the first open, unassigned child in map order
  with no open blockers.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the result, close the ticket, and append
  a brief result and link to the map's Decisions-so-far.
