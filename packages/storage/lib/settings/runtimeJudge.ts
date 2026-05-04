/**
 * T2f-clean-finish-3 — runtime Judge mode.
 *
 * Controls whether the agent runtime invokes the Judge model to verify
 * the final response before shipping it to the user. This is the
 * verifier-subagent pattern from
 * `auto-docs/for-development/agents/multi-agent.md::Scraper vs Researcher`.
 *
 * Modes:
 *  - 'off' — never invoke Judge at runtime. Replanner's `decision='finish'`
 *    ships the response directly. (Default. Cheap, no extra LLM call.)
 *  - 'verify_once' — after replanner says 'finish', call Judge with
 *    {task, response, pastSteps}. If verdict = 'fail' (low plausibility,
 *    missing data), re-feed Judge's concerns to the replanner ONCE for
 *    a focused gap-filling iteration. Then ship whatever comes back.
 *    +1 LLM call best case, +2-3 worst case (judge + extra agent step
 *    + judge again is NOT in scope; only one verify per finish).
 *
 * Requires: `judgeModelStore` to have a model configured. If unset,
 * grader falls back to Navigator (see grader.ts).
 *
 * Eval grader (`grader.ts` LLM-as-judge for `pnpm test:eval`) uses the
 * SAME judge model configuration but is independent of this runtime
 * setting — eval runs always grade, regardless of `runtimeJudgeMode`.
 */

import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export type RuntimeJudgeMode = 'off' | 'verify_once';

export interface RuntimeJudgeRecord {
  mode: RuntimeJudgeMode;
}

export type RuntimeJudgeStorage = BaseStorage<RuntimeJudgeRecord> & {
  setMode: (mode: RuntimeJudgeMode) => Promise<void>;
  getMode: () => Promise<RuntimeJudgeMode>;
};

const storage = createStorage<RuntimeJudgeRecord>(
  'runtime-judge-mode',
  { mode: 'off' },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const runtimeJudgeStore: RuntimeJudgeStorage = {
  ...storage,
  setMode: async (mode: RuntimeJudgeMode) => {
    await storage.set({ mode });
  },
  getMode: async () => {
    const data = await storage.get();
    return data.mode ?? 'off';
  },
};
