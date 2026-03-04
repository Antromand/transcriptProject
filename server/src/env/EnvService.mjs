import path from "node:path";
import fs from "node:fs/promises";

// Сервис централизованно управляет секретами в process.env:
// чтение статусов, обновление из API, снимок токенов для аудита.
export class EnvService {
  constructor({ env = process.env, workRoot = "" } = {}) {
    this.env = env;
    this.storagePath = workRoot ? path.join(workRoot, "env-secrets.json") : "";
    this.secretFields = {
      openai_api_key: "OPENAI_API_KEY",
      deepseek_api_key: "DEEPSEEK_API_KEY",
      grok_api_key: "GROK_API_KEY",
      gemini_api_key: "GEMINI_API_KEY",
      yandexgpt_api_key: "YANDEXGPT_API_KEY",
      hf_token: "HF_TOKEN",
    };
  }

  async init() {
    if (!this.storagePath) return;
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    const persisted = await this.readPersistedSecrets();
    for (const [apiField, envName] of Object.entries(this.secretFields)) {
      const currentValue = (this.env[envName] || "").trim();
      if (currentValue) continue;
      const savedValue = typeof persisted[apiField] === "string" ? persisted[apiField].trim() : "";
      if (savedValue) this.env[envName] = savedValue;
    }
  }

  buildStatusPayload() {
    const payload = {};
    for (const [apiField, envName] of Object.entries(this.secretFields)) {
      payload[`${apiField}_set`] = Boolean(this.env[envName] || "");
    }
    return payload;
  }

  async applyUpdatesFromBody(body = {}) {
    let changed = false;
    for (const [apiField, envName] of Object.entries(this.secretFields)) {
      const nextVal = typeof body[apiField] === "string" ? body[apiField].trim() : null;
      if (nextVal === null) continue;
      const prevVal = this.env[envName] || "";
      if (!nextVal) {
        if (prevVal) changed = true;
        delete this.env[envName];
      } else {
        if (prevVal !== nextVal) changed = true;
        this.env[envName] = nextVal;
      }
    }
    if (changed) {
      await this.persistCurrentSecrets();
    }
  }

  async clearAllSecrets() {
    let changed = false;
    for (const envName of Object.values(this.secretFields)) {
      if (this.env[envName]) changed = true;
      delete this.env[envName];
    }
    if (changed) {
      await this.persistCurrentSecrets();
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

  async readPersistedSecrets() {
    if (!this.storagePath) return {};
    try {
      const raw = await fs.readFile(this.storagePath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if (error && error.code === "ENOENT") return {};
      console.warn(`Failed to read env secrets from ${this.storagePath}: ${error?.message || error}`);
      return {};
    }
  }

  async persistCurrentSecrets() {
    if (!this.storagePath) return;
    const payload = {};
    for (const [apiField, envName] of Object.entries(this.secretFields)) {
      const val = (this.env[envName] || "").trim();
      if (val) payload[apiField] = val;
    }
    await fs.writeFile(this.storagePath, JSON.stringify(payload, null, 2), "utf8");
  }
}
