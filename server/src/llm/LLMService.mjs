import OpenAI from "openai";

export const DEFAULT_LLM_PROVIDER = "deepseek";

// Единая конфигурация провайдеров LLM и моделей по умолчанию.
export const LLM_PROVIDERS = {
  openai: {
    apiKeyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-4o-mini",
    fallbackModels: ["gpt-4o-mini", "gpt-4.1-mini"],
  },
  deepseek: {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    modelEnv: "DEEPSEEK_MODEL",
    baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    fallbackModels: ["deepseek-chat"],
  },
  grok: {
    apiKeyEnv: "GROK_API_KEY",
    modelEnv: "GROK_MODEL",
    baseURL: "https://api.x.ai/v1",
    defaultModel: "grok-2-latest",
    fallbackModels: ["grok-2-latest"],
  },
  gemini: {
    apiKeyEnv: "GEMINI_API_KEY",
    modelEnv: "GEMINI_MODEL",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.0-flash",
    fallbackModels: ["gemini-2.0-flash"],
  },
  yandexgpt: {
    apiKeyEnv: "YANDEXGPT_API_KEY",
    modelEnv: "YANDEXGPT_MODEL",
    defaultModel: "300ya-sharing-url",
    fallbackModels: ["300ya-sharing-url"],
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageText(resp) {
  const message = resp?.choices?.[0]?.message?.content;
  if (typeof message === "string") return message.trim();
  if (Array.isArray(message)) {
    return message
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function buildLocalSummaryFromChunks(items) {
  const all = items.join("\n").replace(/\s+/g, " ").trim();
  const sentences = all
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40);
  const picked = sentences.slice(0, 12);
  if (picked.length === 0) {
    return "Локальный пересказ: не удалось выделить содержательные предложения из транскрипта.";
  }
  return picked.map((s) => `- ${s}`).join("\n");
}

export class LLMService {
  constructor({ env = process.env, fetchImpl = fetch } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  normalizeProvider(input) {
    if (typeof input !== "string") return DEFAULT_LLM_PROVIDER;
    const id = input.trim().toLowerCase();
    return LLM_PROVIDERS[id] ? id : DEFAULT_LLM_PROVIDER;
  }

  getProviderConfig(providerId) {
    return LLM_PROVIDERS[providerId] || LLM_PROVIDERS[DEFAULT_LLM_PROVIDER];
  }

  getProviderClient(providerId) {
    // Yandex 300 работает через отдельный REST API, не через OpenAI-совместимый SDK.
    if (providerId === "yandexgpt") return null;
    const cfg = this.getProviderConfig(providerId);
    const key = this.env[cfg.apiKeyEnv];
    if (!key) return null;
    const clientCfg = { apiKey: key };
    if (cfg.baseURL) clientCfg.baseURL = cfg.baseURL;
    return new OpenAI(clientCfg);
  }

  getModelChain(providerId) {
    const cfg = this.getProviderConfig(providerId);
    return [this.env[cfg.modelEnv] || cfg.defaultModel, ...(cfg.fallbackModels || [])].filter(
      (v, i, arr) => v && arr.indexOf(v) === i
    );
  }

  getMissingKeyMessage(providerId) {
    const cfg = this.getProviderConfig(providerId);
    return `${cfg.apiKeyEnv} не задан. Задайте ключ в UI (или через переменную окружения) и повторите запрос.`;
  }

  async summarizeChunks(chunks, { providerId, sourceUrl }) {
    const client = this.getProviderClient(providerId);
    if (providerId !== "yandexgpt" && !client) return { summary: this.getMissingKeyMessage(providerId) };
    if (providerId === "yandexgpt" && !this.env.YANDEXGPT_API_KEY) return { summary: this.getMissingKeyMessage(providerId) };

    const modelChain = this.getModelChain(providerId);

    const isRetriableError = (e) => {
      const status = e?.status || e?.response?.status;
      const code = e?.code || e?.cause?.code;
      if ([408, 409, 429, 500, 502, 503, 504].includes(status)) return true;
      if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code)) return true;
      const msg = String(e?.message || "");
      return msg.includes("ECONNRESET") || msg.includes("socket hang up") || msg.includes("network");
    };

    const createCompletionWithRetry = async (model, messages) => {
      const maxAttempts = 4;
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (providerId === "yandexgpt") {
            if (!sourceUrl) throw new Error("Для YandexGPT (300.ya.ru) требуется исходный URL.");
            const endpoint = this.env.YANDEX300_ENDPOINT || "https://300.ya.ru/api/sharing-url";
            const r = await this.fetchImpl(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `OAuth ${this.env.YANDEXGPT_API_KEY}`,
              },
              body: JSON.stringify({ article_url: sourceUrl }),
            });
            const payload = await r.json().catch(() => ({}));
            if (!r.ok) {
              const err = new Error(payload?.message || payload?.error || `Yandex 300 HTTP ${r.status}`);
              err.status = r.status;
              throw err;
            }
            if (payload?.status !== "success" || !payload?.sharing_url) {
              const err = new Error("Yandex 300 вернул неожиданный формат ответа.");
              err.status = 500;
              throw err;
            }
            return payload;
          }

          return await client.chat.completions.create({ model, messages, temperature: 0.1 });
        } catch (e) {
          lastError = e;
          if (!isRetriableError(e) || attempt === maxAttempts) throw e;
          const backoffMs = 500 * Math.pow(2, attempt - 1);
          await sleep(backoffMs);
        }
      }
      throw lastError || new Error("LLM request failed");
    };

    // Перебираем модели из цепочки fallback, чтобы не падать при частичных сбоях.
    const createCompletionWithFallback = async (messages) => {
      let lastError = null;
      for (let i = 0; i < modelChain.length; i++) {
        const model = modelChain[i];
        try {
          return await createCompletionWithRetry(model, messages);
        } catch (e) {
          lastError = e;
          const status = e?.status || e?.response?.status;
          const mayRetry = status === 403 || status === 404 || status === 429;
          if (!mayRetry || i === modelChain.length - 1) throw e;
        }
      }
      throw lastError || new Error("LLM request failed");
    };

    const partials = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i];
        const resp = await createCompletionWithFallback([
          { role: "system", content: "Суммируй текст кратко и строго по фактам. 3-6 буллетов, без воды." },
          { role: "user", content: `Чанк ${i + 1}/${chunks.length}:\n\n${text}` },
        ]);
        if (providerId === "yandexgpt") {
          partials.push(`- Пересказ доступен в Yandex 300: ${resp.sharing_url}`);
          break;
        }
        partials.push(extractMessageText(resp));
      }

      if (providerId === "yandexgpt") {
        return {
          summary: partials[0] || "",
          warning: "В режиме YandexGPT используется URL-вход через 300.ya.ru (текст транскрипта не отправляется).",
        };
      }

      const merged = partials.filter(Boolean).join("\n");
      const final = await createCompletionWithFallback([
        { role: "system", content: "Собери единый краткий пересказ. 8-14 буллетов. Без повторов. По сути." },
        { role: "user", content: merged },
      ]);
      return { summary: extractMessageText(final) };
    } catch (e) {
      const status = e?.status || e?.response?.status;
      const msg = String(e?.message || "");
      if (providerId === "gemini" && status === 429) {
        throw new Error("Google Gemini вернул 429 (квота/лимиты). Проверьте billing и quota в Google AI Studio.");
      }
      const regionBlocked =
        providerId === "openai" &&
        status === 403 &&
        msg.toLowerCase().includes("country, region, or territory not supported");
      if (!regionBlocked) throw e;
      return {
        summary: buildLocalSummaryFromChunks(chunks),
        warning: "OpenAI недоступен для текущего региона (403). Показан локальный офлайн-пересказ из транскрипта.",
      };
    }
  }
}
