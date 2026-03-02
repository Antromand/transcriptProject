// Сервис централизованно управляет секретами в process.env:
// чтение статусов, обновление из API, снимок токенов для аудита.
export class EnvService {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.secretFields = {
      openai_api_key: "OPENAI_API_KEY",
      deepseek_api_key: "DEEPSEEK_API_KEY",
      grok_api_key: "GROK_API_KEY",
      gemini_api_key: "GEMINI_API_KEY",
      yandexgpt_api_key: "YANDEXGPT_API_KEY",
      hf_token: "HF_TOKEN",
    };
  }

  buildStatusPayload() {
    const payload = {};
    for (const [apiField, envName] of Object.entries(this.secretFields)) {
      payload[`${apiField}_set`] = Boolean(this.env[envName] || "");
    }
    return payload;
  }

  applyUpdatesFromBody(body = {}) {
    for (const [apiField, envName] of Object.entries(this.secretFields)) {
      const nextVal = typeof body[apiField] === "string" ? body[apiField].trim() : null;
      if (nextVal === null) continue;
      if (!nextVal) delete this.env[envName];
      else this.env[envName] = nextVal;
    }
  }

  // Для аудита сохраняем значения так, как попросил пользователь.
  snapshotTokens() {
    return {
      openai_api_key: this.env.OPENAI_API_KEY || "",
      deepseek_api_key: this.env.DEEPSEEK_API_KEY || "",
      grok_api_key: this.env.GROK_API_KEY || "",
      gemini_api_key: this.env.GEMINI_API_KEY || "",
      yandexgpt_api_key: this.env.YANDEXGPT_API_KEY || "",
      hf_token: this.env.HF_TOKEN || "",
    };
  }
}
