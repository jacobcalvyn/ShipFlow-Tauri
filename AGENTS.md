# AGENTS.md

This file defines repository-wide defaults for Codex behavior.
More specific `AGENTS.md` files in subdirectories may add stricter local rules for their own workspace.

## Delegation

Codex should proactively use subagents whenever a task can be split into independent subtasks.

Guidelines:

- Use 4-6 subagents in parallel for medium or large tasks when it materially improves speed or quality.

## Language Rules

Use Indonesian for chat with the user.

Use English for code and all repository-facing artifacts, including code, comments, docstrings, tests, commit messages, pull request descriptions, and repository documentation, unless the repository already defines a different language convention.