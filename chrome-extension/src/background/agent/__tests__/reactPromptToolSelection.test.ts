import { describe, expect, it } from 'vitest';
import { reactSystemPromptTemplate } from '../prompts/react';

// 2026-09-27 Online-Mind2Web run: the tool-selection block told the agent to
// answer every "find X" task with web_search and never open or click the site,
// so site tasks were answered from search snippets or model memory.
describe('react system prompt — tool selection', () => {
  it('sends tasks about a named or open website to that website', () => {
    expect(reactSystemPromptTemplate).toMatch(/names a website[\s\S]*work there with the browser\s+tools/);
    expect(reactSystemPromptTemplate).toMatch(/Do not replace the site with web_search/);
  });

  it('no longer forbids browser tools for finding information', () => {
    expect(reactSystemPromptTemplate).not.toMatch(/ALWAYS try `web_search/);
    expect(reactSystemPromptTemplate).not.toMatch(/Opening a tab to\s+read content is a regression/);
  });
});

// 2026-10-01 robustness eval: failure was defined as «blocked» only, so «the
// item is not on the site» was reported as success.
describe('react system prompt — completion outcome', () => {
  it('names the three outcomes and no longer speaks of a success flag', () => {
    expect(reactSystemPromptTemplate).toMatch(/outcome=answered/);
    expect(reactSystemPromptTemplate).toMatch(/outcome=not_on_site/);
    expect(reactSystemPromptTemplate).toMatch(/outcome=blocked/);
    expect(reactSystemPromptTemplate).not.toMatch(/success=(true|false)/);
  });

  it('defines answered as containing everything the user asked for', () => {
    expect(reactSystemPromptTemplate).toMatch(/Anything the user asked for that the response does not contain/);
  });

  it('asks for a check of each requirement before answered', () => {
    expect(reactSystemPromptTemplate).toMatch(/Before outcome=answered/);
  });
});
