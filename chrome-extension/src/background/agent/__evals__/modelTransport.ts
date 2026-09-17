import { ChatOpenAI } from '@langchain/openai';

/** Opt-in eval transport, not a second agent loop. No storage or runtime defaults. */
export function createEvalModel(
  model: string,
  apiKey: string,
  controller: AbortController,
  maxRequests: number,
  transport: typeof fetch = fetch,
) {
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, usageResponses: 0, costResponses: 0 };
  const limitedFetch: typeof fetch = async (url, init) => {
    if (controller.signal.aborted) throw new Error('Evaluation aborted');
    if (usage.requests >= maxRequests || (typeof init?.body === 'string' && init.body.length > 120_000)) {
      controller.abort();
      throw new Error('Evaluation request/input budget exhausted');
    }
    usage.requests++;
    let response: Response;
    try {
      response = await transport(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
      });
    } catch {
      throw new Error('Evaluation provider request failed');
    }
    if (!response.ok) throw new Error(`Evaluation provider HTTP ${response.status}`);
    // Non-streaming requests make provider usage measurable. Missing usage is
    // explicitly unknown in reports, never presented as free execution.
    try {
      const body = await response.clone().json();
      const u = body.usage;
      if (Number.isFinite(u?.prompt_tokens) && Number.isFinite(u?.completion_tokens)) {
        usage.inputTokens += u.prompt_tokens;
        usage.outputTokens += u.completion_tokens;
        usage.usageResponses++;
      }
      if (Number.isFinite(u?.cost)) {
        usage.costUsd += u.cost;
        usage.costResponses++;
      }
    } catch {
      /* malformed response is handled by the provider adapter */
    }
    return response;
  };
  const llm = new ChatOpenAI({
    model,
    apiKey,
    temperature: 0,
    maxTokens: 2048,
    maxRetries: 0,
    streaming: false,
    disableStreaming: true,
    timeout: 30_000,
    configuration: { baseURL: 'https://openrouter.ai/api/v1', fetch: limitedFetch },
  });
  return {
    llm,
    usage,
    summary: () => ({
      model,
      requests: usage.requests,
      inputTokens: usage.usageResponses === usage.requests ? usage.inputTokens : null,
      outputTokens: usage.usageResponses === usage.requests ? usage.outputTokens : null,
      costUsd: usage.costResponses === usage.requests ? usage.costUsd : null,
    }),
  };
}
