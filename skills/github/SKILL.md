---
name: github
description: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries."
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory, or use URLs directly.

## Pull Requests

Check CI status on a PR:
```bash
gh pr checks 55 --repo owner/repo
```

## Workflow Runs (CI/CD)

List recent runs:
```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:
```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:
```bash
gh run view <run-id> --repo owner/repo --log-failed
```

View full log for a specific job:
```bash
gh run view --job <job-id> --repo owner/repo --log
```

Given a GitHub Actions URL like `https://github.com/owner/repo/actions/runs/12345/job/67890`:
- Run ID: `12345`
- Job ID: `67890`

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other subcommands.

Get issue details as JSON:
```bash
gh api repos/owner/repo/issues/123
```

Get PR with specific fields:
```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

## JSON Output

Most commands support `--json` for structured output:
```bash
gh issue view 123 --repo owner/repo --json title,state,body
gh pr list --repo owner/repo --json number,title,author
gh run view <run-id> --repo owner/repo --json conclusion,jobs
```

Use `--jq` to filter:
```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
