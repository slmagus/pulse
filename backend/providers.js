const VLLM_DEFAULT_BASE_URL = 'http://localhost:8000';

function toOpenAIRequest(anthropicBody, model) {
  const { messages, max_tokens, system } = anthropicBody;
  const openAIMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;
  return {
    model,
    messages: openAIMessages,
    max_tokens: max_tokens ?? 1600,
    stream: false,
  };
}

function toAnthropicResponse(openAIData) {
  const choice = openAIData?.choices?.[0];
  const text = choice?.message?.content ?? '';
  return {
    id: openAIData.id ?? `local-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: openAIData.model ?? 'unknown',
    content: [{ type: 'text', text }],
    stop_reason: choice?.finish_reason ?? 'end_turn',
    usage: {
      input_tokens: openAIData.usage?.prompt_tokens ?? 0,
      output_tokens: openAIData.usage?.completion_tokens ?? 0,
    },
  };
}

export async function callProvider(anthropicBody, env = process.env) {
  const provider = (env.LLM_PROVIDER ?? 'anthropic').toLowerCase();

  if (provider !== 'vllm') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });
    const data = await upstream.json();
    return { status: upstream.status, body: data };
  }

  // vLLM path
  const baseUrl = (env.LLM_BASE_URL ?? VLLM_DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = env.LLM_MODEL ?? anthropicBody.model;
  const apiKey = env.LLM_API_KEY ?? '';

  const endpoint = `${baseUrl}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(toOpenAIRequest(anthropicBody, model)),
    });
  } catch (err) {
    throw new Error(`Cannot reach vllm at ${baseUrl}. Is it running? (${err.message})`);
  }

  const data = await upstream.json();

  if (!upstream.ok) {
    const msg = data?.error?.message ?? data?.detail ?? JSON.stringify(data);
    throw new Error(`vllm returned ${upstream.status}: ${msg}`);
  }

  return { status: 200, body: toAnthropicResponse(data) };
}
