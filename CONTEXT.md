# gtea-cli

Gitea CLI is a command-line client for working with Gitea through a GitHub CLI-shaped interface. It exists to preserve common `gh` workflows and scripts while targeting Gitea as the backend.

## Language

**Compatibility Matrix**:
The project contract that classifies each `gh` command or flag as supported, emulated, or unsupported on Gitea.
_Avoid_: drop-in replacement, full parity

**Script-Compatible Command**:
A `gtea` command that preserves the `gh` command path and flags so existing scripts only need `gh` renamed to `gtea`.
_Avoid_: equivalent command, close enough

**Gitea Host**:
A specific Gitea server plus its explicit URL scheme when one is provided; bare hostnames default to HTTPS.
_Avoid_: backend, instance, remote service

**Repository Context**:
The repository a command targets after resolving `-R`, stored defaults, and the current Git directory.
_Avoid_: active repo, selected repo, current repo

**Repository Label**:
A repository-scoped workflow marker that can be attached to issues and pull requests within one repository.
_Avoid_: issue-only tag, global label

**Host Credential**:
The stored credential that authorizes `gtea` against one **Gitea Host**.
_Avoid_: login state, session

**Personal Access Token**:
The default kind of **Host Credential** used to authenticate `gtea` against a **Gitea Host**.
_Avoid_: password, API key

**Structured Output Contract**:
The promise that supported commands preserve `gh` machine-readable flags and field names for automation.
_Avoid_: display format, pretty output

**Explicit Unsupported Command**:
A command path that exists in `gtea` and fails clearly because Gitea cannot support the matching `gh` behavior.
_Avoid_: missing command, unimplemented command

**Git Toolchain**:
The locally installed `git` executable that `gtea` uses for repository detection and Git-facing workflows.
_Avoid_: internal Git engine, built-in VCS layer

**Semantic Match**:
A Gitea capability that preserves the meaning of the corresponding `gh` command closely enough to keep compatibility honest.
_Avoid_: rough equivalent, close enough feature

**Support Manifest**:
A checked-in source of truth that records the **Compatibility Matrix** and drives docs, help, and tests.
_Avoid_: informal notes, implicit support list

**Compatibility Variables**:
The `GH_*` and `GTEA_*` environment variables that `gtea` reads for scripting and automation.
_Avoid_: shell state, runtime flags

**Native Config Store**:
The `gtea`-owned config and credential files, kept separate from `gh` storage.
_Avoid_: shared config, borrowed config

**Exit Contract**:
The expectation that supported commands preserve `gh` success and failure signaling where Gitea semantics allow it.
_Avoid_: process return, shell status only

**Secure Credential Store**:
A platform credential store that `gtea` uses for interactive authentication when the OS provides one.
_Avoid_: plain config storage, token file

**Support Baseline**:
The minimum Gitea version line that the **Compatibility Matrix** explicitly promises to support.
_Avoid_: best effort version, latest only

**Eligible Host**:
A target host that `gtea` is allowed to operate against because it is a Gitea server within the supported boundary.
_Avoid_: arbitrary forge, any Git host

**Web Route Synthesis**:
Building Gitea web URLs locally from repository and host context instead of relying on API-provided links, preserving an explicit host scheme when one was chosen.
_Avoid_: API link lookup, remote URL guessing

**Broad-First Milestone**:
The first delivery shape that exposes the full in-scope command tree and proves auth, context, web routing, and read paths before deeper write coverage.
_Avoid_: narrow pilot, partial prototype

**Fine-Grained Support Manifest**:
A **Support Manifest** that classifies command paths, flags, and machine-readable fields separately.
_Avoid_: command-only matrix, coarse support list

**Compatibility Harness**:
A test setup that compares `gtea` against `gh` command surfaces and runs behavior checks against a disposable Gitea instance.
_Avoid_: unit tests only, informal manual checks

**Inline Review Comment Input**:
A write-only comment description containing a repository path, positive line number, `LEFT` or `RIGHT` diff side, and body; `gtea` translates it to the Gitea Host's review-comment request shape.
_Avoid_: review comment record, raw Gitea comment payload

## Relationships

- A **Compatibility Matrix** classifies each **Script-Compatible Command** as supported, emulated, or unsupported.
- A **Gitea Host** exposes one or more repositories that **Script-Compatible Commands** can target.
- A **Repository Context** belongs to exactly one **Gitea Host**.
- A **Repository Label** belongs to exactly one **Repository Context**.
- A **Script-Compatible Command** operates against one **Repository Context** unless it is purely local.
- A **Host Credential** authorizes `gtea` against exactly one **Gitea Host**.
- A **Personal Access Token** is the default **Host Credential** for a **Gitea Host**.
- A **Structured Output Contract** applies only to **Script-Compatible Commands** that expose machine-readable output.
- An **Explicit Unsupported Command** is still part of the **Compatibility Matrix** even though it cannot complete successfully.
- The **Git Toolchain** helps derive a **Repository Context** from the current local repository.
- **Script-Compatible Commands** that manipulate local repositories delegate Git work to the **Git Toolchain**.
- A **Script-Compatible Command** may be emulated only when a **Semantic Match** exists.
- Without a **Semantic Match**, the command becomes an **Explicit Unsupported Command**.
- A **Support Manifest** records the **Compatibility Matrix** in a form that help, docs, and tests can consume.
- **Compatibility Variables** can select a **Gitea Host**, supply a **Host Credential**, or override a **Repository Context**.
- Bare hostnames resolve to HTTPS unless an explicit scheme is part of the **Gitea Host**.
- The **Native Config Store** persists defaults and **Host Credentials** without sharing state with `gh`.
- **Compatibility Variables** override the **Native Config Store** when both are present.
- The **Exit Contract** applies to supported **Script-Compatible Commands** alongside syntax and output compatibility.
- A **Secure Credential Store** may hold a **Host Credential** instead of the **Native Config Store**.
- The **Support Manifest** is scoped to a declared **Support Baseline**.
- Features above the **Support Baseline** are gated rather than assumed.
- Every targeted **Repository Context** must belong to an **Eligible Host**.
- Issues and pull requests within a **Repository Context** may reference **Repository Labels**.
- **Web Route Synthesis** derives browser targets from an **Eligible Host** and a **Repository Context**, preserving an explicit host scheme.
- A **Broad-First Milestone** proves the cross-cutting pieces of the **Compatibility Matrix** before deep write coverage.
- A **Fine-Grained Support Manifest** classifies command paths, flags, and output fields separately.
- A **Compatibility Harness** verifies the **Fine-Grained Support Manifest** against real `gh` surfaces and a disposable Gitea backend.
- One or more **Inline Review Comment Inputs** may be submitted as part of a pull request review.

## Example dialogue

> **Dev:** "When we say `gtea` is a drop-in replacement for `gh`, do we mean every GitHub feature?"
> **Domain expert:** "No. We mean the supported slice is made of **Script-Compatible Commands**, and the **Compatibility Matrix** makes unsupported cases explicit."

## Flagged ambiguities

- "drop-in replacement" was used to mean full `gh` parity; resolved: in this project it means preserving `gh` syntax for the supported slice and using a **Compatibility Matrix** for explicit unsupported cases.
- "host" was left implicit; resolved: `gtea` is first-class multi-host and routes commands per **Gitea Host**.
- When `-R` is omitted, the target repository is not arbitrary; resolved: `gtea` mirrors `gh` resolution to derive a **Repository Context**.
- Interactive browser login may exist, but it is not the core contract; resolved: **Personal Access Tokens** are the default **Host Credential** across hosts.
- Human-readable output is not enough for compatibility; resolved: supported automation-facing commands honor a **Structured Output Contract**.
- Unsupported behavior should still be discoverable through the CLI surface; resolved: `gtea` ships **Explicit Unsupported Commands** instead of silently omitting paths.
- Git-facing workflows do not imply a custom Git implementation; resolved: `gtea` delegates local repository operations to the **Git Toolchain**.
- A rough Gitea feature is not automatically good enough; resolved: emulation requires a **Semantic Match**, otherwise the command is explicitly unsupported.
- The compatibility contract should not live only in code; resolved: a checked-in **Support Manifest** defines the **Compatibility Matrix**.
- Script compatibility includes process environment, not just command spelling; resolved: `gtea` reads **Compatibility Variables** from both `GH_*` and `GTEA_*`, preferring `GTEA_*`.
- Runtime compatibility does not imply shared persistent state; resolved: `gtea` uses its own **Native Config Store** instead of `gh` config files.
- Script compatibility includes failure signaling, not just success paths; resolved: supported commands aim to preserve a compatible **Exit Contract**.
- Interactive auth should not default to plain files when safer platform storage exists; resolved: `gtea` prefers a **Secure Credential Store** when available.
- Public API docs may track newer development builds than the guaranteed floor; resolved: the first **Support Baseline** is `1.25.x`, and the live Gitea API reference can be fetched from https://gitea.com/api/swagger when checking current server capabilities.
- `gtea` is not a generic forge client; resolved: commands only operate on an **Eligible Host** and fail clearly on GitHub targets.
- "label" could be read as an issue-only concept; resolved: a **Repository Label** is repository-scoped and can be attached to both issues and pull requests.
- Host transport was ambiguous between a fixed HTTPS assumption and a user choice; resolved: bare hostnames still default to HTTPS, but an explicit scheme becomes part of the **Gitea Host** identity and is preserved across auth, repository resolution, API calls, web routes, and Git credential setup.
- Browser-facing commands should not depend on spotty API links; resolved: `gtea` uses **Web Route Synthesis** for `browse` and `--web` paths.
- The first release should prove breadth before depth; resolved: the initial delivery is a **Broad-First Milestone**.
- Command-level support alone is too vague for script compatibility; resolved: the project uses a **Fine-Grained Support Manifest**.
- Compatibility needs executable proof, not just intentions; resolved: the project uses a **Compatibility Harness** with golden comparisons and disposable Gitea tests.
- "full interface" was ambiguous between broad compatibility and full `gh` parity; resolved: `gtea` broadens the `gh`-shaped surface only where Gitea has a **Semantic Match**, and keeps the rest explicit in the **Compatibility Matrix**.
- Inline review comment write input and comment output records serve different contracts; resolved: an **Inline Review Comment Input** is a distinct write-only shape that shares location terminology with readable comments where applicable.
