---
name: bambu-snyk-dependency-hardening
description: Portable decision framework for triaging and remediating Snyk (or equivalent SCA) findings in third-party dependencies — deciding upgrade vs. documented exception, verifying an upgrade is actually safe, writing a well-formed `.snyk` ignore entry, and setting its expiration by severity. Load when a Snyk/SCA scan fails, when deciding whether to bump or ignore a vulnerable dependency, or when writing/reviewing a change to a `.snyk` policy file.
---

# Snyk / SCA Dependency Hardening (portable)

This skill captures **generic, project-agnostic** conventions for triaging
known-vulnerability findings in third-party dependencies (Snyk, `npm audit`,
or similar SCA tooling). Every rule here is reusable in any project that runs
this kind of scan: none of them depend on a particular tech stack or codebase.

> **Scope boundary.** This is about *dependency* vulnerabilities (CVEs in
> packages you didn't write), not business-logic security review of your own
> code — that's a different discipline with a different skill/agent. This
> skill also doesn't replace running the scanner; it's the criteria for what
> happens **after** it reports something.

## When to load this skill

- A Snyk/SCA check on a PR or CI run fails.
- You're deciding whether to upgrade a vulnerable dependency or document an
  exception instead.
- You're writing or reviewing a change to a `.snyk` (or equivalent ignore
  policy) file.
- You're defining or auditing the severity/expiration policy for dependency
  exceptions.

## The decision tree

For each finding, in this order:

### 1. Is there an upgrade or patch available?

**Yes** → evaluate whether it's actually safe to apply **before** touching
the manifest:

- If it's a **major** version bump, check the real changelog/migration guide
  for breaking changes on the surface your code actually uses — don't assume
  semver-compatible just because it's framed as "a security patch."
- **Check toolchain compatibility, not just the API.** A common failure mode:
  a dependency's new major version drops CommonJS in favor of pure ESM (a
  `"type": "module"` or an `exports` map with no CJS entry), which breaks any
  toolchain that can't load ESM — a classic example is a CJS-only test
  runner transform. Verify the module format of the new version
  (`node -e "console.log(require('./node_modules/<pkg>/package.json').type)"`
  or inspect `exports`) before assuming the fix is a safe drop-in. If it
  isn't, that's not automatically a reason to skip the upgrade — it's a
  trade-off to make consciously and document (see step 3).
- Apply the bump, refresh the lockfile, and run the test scope of **every
  real consumer** of that dependency — not just the package that declares it
  directly. A shared cache/session/queue client is often used by more than
  one module; find them all before declaring the bump safe.
- Run lint/typecheck. Zero new errors (pre-existing unrelated warnings are
  fine).

**No** → go to step 2. Never lower the scanner's severity threshold as a
shortcut to pass a check — that flag is global and hides unrelated future
findings, not just this one.

### 2. No upgrade available: is it actually exploitable in this usage?

Don't copy the advisory text as your justification. Read the **real call
site**:

- Can the data reaching the vulnerable function be attacker-controlled
  (request input), or is it a fixed value defined in code (a static path, a
  hardcoded config object)?
- If the vulnerable package is transitive, trace the full chain
  (`direct-dep > … > vulnerable-dep`) and understand *what each link actually
  uses it for* — don't assume "it's just tooling" without checking; a
  vulnerability the scanner reports is by definition in the scanned
  (production) dependency scope.
- If, after reading the code, the real risk is low because attacker-
  controlled input never reaches the vulnerable path, that's a valid reason
  to ignore. If you can't rule out exploitability, don't ignore it — report
  it as an open finding and let the team decide.

### 3. Document the exception

Format (Snyk policy v1; adapt the ignore-list shape to whatever SCA tool is
in use):

```yaml
version: v1.25.0
ignore:
  SNYK-JS-EXAMPLE-0000000:
    - '*':
        reason: >-
          <what the vulnerability is, in which package and dependency chain;
          why there's no upgrade/patch; and the concrete reason — citing the
          actual file/line — why the vulnerable path isn't reachable here>
        expires: YYYY-MM-DDT00:00:00.000Z
patch: {}
```

`reason` is a technical justification citing the real usage (file/line), not
a paraphrase of the advisory. A future reviewer should be able to verify the
claim without re-investigating from scratch.

## Expiration policy by severity

| Scanner severity | `expires` |
|---|---|
| **Critical / High** | **7 days** from today |
| **Medium / Low** | **30 days** from today |

**Why 7 days for High/Critical instead of 30-90**: most teams run a
recurring (e.g. weekly) scheduled scan in addition to per-PR checks. A 7-day
window ensures a high-severity exception survives at most one scan cycle
before forcing re-review, instead of sleeping for a full quarter.
Medium/Low relax to 30 days because the business cost of frequent re-review
no longer matches the risk level.

Compute the date programmatically (`date -v+7d +%Y-%m-%d` on macOS,
`date -d "+7 days" +%Y-%m-%d` on Linux/CI) based on severity — never by hand.

When an exception expires without a fix or a renewed justification, the scan
should fail again — that's **the intended behavior**, not a bug: it forces
re-review. Renewing is a conscious decision (new date + updated `reason` if
anything changed), never an automatic `expires` extension.

## Governance: who can touch the ignore policy file

Gate changes to the ignore-policy file (`.snyk` or equivalent) behind a
CODEOWNERS rule assigning it to a security team or lead, so that ignoring a
finding is a reviewed decision, not a unilateral shortcut by whoever is in a
hurry to unblock a PR. State the proposed exception explicitly in the PR
description so the reviewer doesn't have to discover it in the diff.

Branch protection on the relevant branches must have "Require review from
Code Owners" (or equivalent) enabled for this to actually be enforced —
without it, a CODEOWNERS file is decorative.

## Hard rules

- Never lower the scanner's severity threshold to unblock a PR.
- Never write a generic `reason` ("no fix available") without the concrete
  exploitability justification.
- Never extend an `expires` date without re-evaluating whether a fix now
  exists.
- An upgrade that fixes the CVE but breaks the build/test toolchain (e.g. via
  an ESM/CJS mismatch) is not applied blindly — the trade-off is documented
  and consciously chosen.
- Don't commit or push changes unless explicitly asked — leave the working
  tree ready for review.
