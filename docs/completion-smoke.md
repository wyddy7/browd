# Completion fix: smoke findings and acceptance

## Evidence (2026-09-17)

📄 Owner-provided extension traces and screenshots exercised four tasks with
`google/gemini-2.5-flash`. Private browsing data and raw traces are deliberately
not checked into this public repository.

- All four terminal traces stopped after `task_complete`; no subsequent model
  or tool call was recorded. This supports the authoritative-completion fix,
  not a claim that every answer was correct.
- Extraction returned text but omitted the requested link destination. The
  trace recorded the HTML conversion fallback failing.
- Navigation followed by a sourced explanation produced a substantive answer.
- A slow page opened twice before a fallback navigation: `tabs.create` had
  succeeded, but each readiness timeout was reported as an operation failure.
- Completed tasks still displayed unfinished plan checklists (1/2 or 1/4).
- An ambiguous shopping request drifted to a different site/product scope.
  The returned price does not establish that the user's task was satisfied.

🤖 Code diagnosis: creation and readiness must be separate outcomes; Markdown
conversion must work without browser DOM globals; task completion must settle
the plan display without inventing execution of remaining steps. These are
runtime contracts, independent of model age. Semantic task success still needs
evaluation against the original request and observed evidence.

## Acceptance for follow-up fixes

1. Slow tab creation reports its existing tab identity, never a retryable
   creation failure just because loading is incomplete. Event listeners and
   timers are cleaned on every exit; agent attention follows owned new tabs.
2. Extraction preserves absolute and relative link destinations in a
   service-worker-like environment, including pages longer than 200 characters.
3. Terminal task state and plan display agree; unexecuted steps are not claimed
   as executed. Failure/cancellation must not appear as successful completion.
4. Task evaluations combine deterministic assertions and a separate LLM judge.
   The judge cannot override a failed hard assertion. Reports identify model,
   scenario and whether execution used fixtures or a real browser.

## Verification boundaries

Offline regressions prove code contracts, not live model/browser performance.
HTML changes additionally require extension reload and actual extraction in
the MV3 worker before release. Paid candidate/judge calls are opt-in. No
cross-model success rate is claimed without completed, recorded runs.

## Local follow-up implementation

📄 Separate commits address tab creation/readiness, worker-safe link extraction
and active-plan retirement. Regressions were observed failing before their fixes.
The model-comparison runner is described in [model-evaluations.md](model-evaluations.md).
It is wired to Judge and tested offline; paid model comparisons and a reload
smoke of these follow-up changes remain pending before release.

📄 Final local checks: 251 tests passed, 6 opt-in/historical checks skipped;
extension type-check, changed-file ESLint and production build passed.
The existing component-eval command passed 5 checks with 3 stub scenarios
skipped. A paid-run invocation with configuration deliberately removed failed
at startup as expected; no provider calls were made.

## Not resolved by this patch

- 📄 The initial invalid-key attempt in the supplied trace passed through
  multiple model-call paths. Authentication fail-fast policy is not changed.
- 🤖 Model/task interpretation remains a separate quality problem. The new
  rubric can flag product/site substitution; it does not make arbitrary models
  reliably resolve ambiguous requests or independently verify every live task.
- Full single-loop migration and real-browser integration automation remain
  separate work; neither is implied by these fixes.
