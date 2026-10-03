/**
 * Groq client for the Vercel deployment. Same contract as the Python
 * reference build's LLMClient (services/agents/common/llm_client.py):
 * structured, schema-shaped JSON output, with a deterministic mock
 * fallback when GROQ_API_KEY is absent so the whole pipeline still runs
 * end-to-end without credentials (DEMO_MODE).
 *
 * Groq exposes an OpenAI-compatible Chat Completions API. We keep the
 * generateStructured() signature identical to the previous Gemini client
 * so the agents (fraudCaseSearch / transactionAnalyzer / kycRetriever /
 * reportGenerator) don't need to change. The incoming `model` string uses
 * the old Gemini naming ("...flash" / "...pro") purely as a tier hint,
 * which we map to a Groq model.
 */
export const DEMO_MODE = !process.env.GROQ_API_KEY;

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// Map the caller's tier hint to a concrete Groq model. Llama 3.1/3.3 were
// deprecated for free/dev tier (June 2026); gpt-oss is the recommended
// replacement and supports JSON mode.
function resolveModel(model: string): string {
  const isPro = /pro/i.test(model);
  if (isPro) {
    return process.env.GROQ_MODEL_PRO || "openai/gpt-oss-120b";
  }
  return process.env.GROQ_MODEL_FLASH || "openai/gpt-oss-20b";
}

function stripFences(text: string): string {
  // Some models wrap JSON in ```json ... ``` fences despite json mode.
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export async function generateStructured<T>(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  mockFactory: () => T
): Promise<{ data: T; tokens: { prompt_tokens: number; completion_tokens: number } }> {
  if (DEMO_MODE) {
    const data = mockFactory();
    return {
      data,
      tokens: {
        prompt_tokens: userPrompt.split(/\s+/).length,
        completion_tokens: 80 + Math.floor(Math.random() * 120),
      },
    };
  }

  const apiKey = process.env.GROQ_API_KEY;
  const groqModel = resolveModel(model);

  // Groq requires the literal word "json" to appear in the prompt when using
  // response_format: json_object. Reinforce it explicitly.
  const systemWithJson =
    `${systemPrompt}\n\nRespond with ONLY a single valid JSON object. ` +
    `No markdown, no code fences, no commentary.`;

  // Retry on 429 (TPM/RPM limits). Groq's error message carries a
  // "Please try again in Xs" hint; we respect it (capped). Bounded retries
  // so a sustained outage doesn't hang the request indefinitely.
  const MAX_ATTEMPTS = 4;
  const RETRY_CAP_MS = 20_000;
  let json: any = null;
  let resp: Response | null = null;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      resp = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: groqModel,
          messages: [
            { role: "system", content: systemWithJson },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
      });
      json = await resp.json();
      if (resp.ok) break;
      if (resp.status !== 429 || attempt === MAX_ATTEMPTS) break;
      const hint = String(json?.error?.message || "").match(/try again in ([\d.]+)s/i);
      const retryHeader = resp.headers.get("retry-after");
      const waitSec = hint ? Number(hint[1]) : retryHeader ? Number(retryHeader) : 2 * attempt;
      const waitMs = Math.min(RETRY_CAP_MS, Math.max(500, waitSec * 1000 + 250));
      console.warn(`[groq] ${groqModel} 429, waiting ${waitMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    if (!resp || !resp.ok) {
      console.error(
        `[groq] ${groqModel} request failed: HTTP ${resp?.status} ${resp?.statusText}. ` +
          `Response: ${JSON.stringify(json).slice(0, 500)}. ` +
          `Falling back to deterministic mock output for this agent.`
      );
      return { data: mockFactory(), tokens: { prompt_tokens: 0, completion_tokens: 0 } };
    }

    const text = json?.choices?.[0]?.message?.content;
    if (!text) {
      console.warn(
        `[groq] ${groqModel} returned no content (possible filter or empty choice). ` +
          `Falling back to mock output. Raw: ${JSON.stringify(json).slice(0, 500)}`
      );
      return { data: mockFactory(), tokens: { prompt_tokens: 0, completion_tokens: 0 } };
    }

    const data = JSON.parse(stripFences(text)) as T;
    const usage = json?.usage;
    return {
      data,
      tokens: {
        prompt_tokens: usage?.prompt_tokens || 0,
        completion_tokens: usage?.completion_tokens || 0,
      },
    };
  } catch (err) {
    console.error(`[groq] ${groqModel} call threw: ${String(err)}. Falling back to mock output.`);
    return { data: mockFactory(), tokens: { prompt_tokens: 0, completion_tokens: 0 } };
  }
}
