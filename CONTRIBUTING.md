# Contributing

Changes to `main`, including documentation, go through a pull request. The
[Protect main ruleset](https://github.com/Yelqo/paperclip-outpost/rules/24590383)
requires the GitHub Actions check **Build and public workflow** to pass on a
branch that is up to date with `main`. Missing, pending, or failing checks block
merging. Required human approvals are set to zero for the solo workflow.

The ruleset blocks direct pushes, force pushes, and deletion of `main`. Its
bypass list is empty, so administrators follow the same contribution workflow.

## Make a change

1. Fetch `origin/main` and create a branch from it.
2. Make the change. For code changes, follow the [development setup](docs/connection.md#supported-development-installation)
   and run `pnpm check`, `pnpm build`, and `pnpm test`. Run `gofmt -w` on any Go
   files reported by `pnpm check:format`.
3. Commit, push the branch, and open a pull request targeting `main`.
4. Wait for **Build and public workflow** to pass. If `main` moves, update the
   branch with the latest `main` and wait for CI to pass again.
5. Merge the pull request through GitHub, then remove the feature branch.

## Required CI check

The check name comes from the job's `name` in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). Keep it stable and unique
across workflows. If it must change, run the new check successfully before an
administrator updates the ruleset's required check.

The job runs on a standard GitHub-hosted Ubuntu runner and checks:

- Formatting of every tracked Go file with `gofmt`.
- Generated compatibility declarations, plugin TypeScript, and Go with `go vet`.
- Plugin and daemon builds, patched host TypeScript, and host authorization tests.
- The public host, plugin, and daemon integration workflow.

Formatting and generated-file freshness are checked before host preparation
and the build, which regenerate compatibility declarations. There is currently no configured
TypeScript formatter or separate lint tool; TypeScript checks and Go vetting
use the existing toolchain.

The workflow has no path filters or conditional job skips, so documentation
changes also run the required check. Do not add filters that leave applicable
pull requests without a result. See the development setup for the test suite's
Linux and `bubblewrap` requirements.
