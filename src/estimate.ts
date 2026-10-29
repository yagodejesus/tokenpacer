/** Rough token estimate for rate limiting: ~4 characters per token, plus overhead per message and the reserved output. */
export function estimateTokens(input: unknown): number {
  if (input == null) return 0;
  if (typeof input === "string") return Math.ceil(input.length / 4);
  if (Array.isArray(input)) return input.reduce((sum: number, m) => sum + 4 + estimateTokens((m as { content?: unknown })?.content ?? m), 0);
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    let total = 0;
    if ("messages" in o) total += estimateTokens(o.messages);
    if ("input" in o) total += estimateTokens(o.input);
    if ("prompt" in o) total += estimateTokens(o.prompt);
    if ("system" in o) total += estimateTokens(o.system);
    if (typeof o.text === "string") total += estimateTokens(o.text);
    const maxOut = o.max_tokens ?? o.max_completion_tokens ?? o.max_output_tokens;
    if (typeof maxOut === "number") total += maxOut; // providers reserve the maximum output against your limit
    if (total === 0) total = Math.ceil(JSON.stringify(o).length / 4);
    return total;
  }
  return Math.ceil(String(input).length / 4);
}

/** Actual tokens used, from an OpenAI (`usage.total_tokens`) or Anthropic (`usage.input_tokens + output_tokens`) response. */
export function usedTokens(result: unknown): number | undefined {
  const u = (result as { usage?: Record<string, number> } | undefined)?.usage;
  if (!u) return undefined;
  if (typeof u.total_tokens === "number") return u.total_tokens;
  if (typeof u.input_tokens === "number" || typeof u.output_tokens === "number") return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  return undefined;
}
