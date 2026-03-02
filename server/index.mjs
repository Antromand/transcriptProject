import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import OpenAI from "openai";
import { isValidVkMask } from "../ui/src/vkUrlRules.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WORK_ROOT = process.env.WORK_ROOT || path.join(process.cwd(), "work");
const UI_DIST = process.env.UI_DIST || path.join(process.cwd(), "ui", "dist");

const YTDLP = process.env.YTDLP_BIN || "yt-dlp";
const PYTHON = process.env.PYTHON_BIN || "python";

const WHISPERX_SCRIPT = process.env.WHISPERX_SCRIPT || "run_whisperx.py";
const SPLIT_SCRIPT = process.env.SPLIT_SCRIPT || "split_whisperx.py";
const WHISPERX_SCRIPT_PATH = path.isAbsolute(WHISPERX_SCRIPT) ? WHISPERX_SCRIPT : path.join(process.cwd(), WHISPERX_SCRIPT);
const SPLIT_SCRIPT_PATH = path.isAbsolute(SPLIT_SCRIPT) ? SPLIT_SCRIPT : path.join(process.cwd(), SPLIT_SCRIPT);

const LLM_PROVIDER_DEFAULT = "openai";
const LLM_PROVIDERS = {
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

function normalizeProvider(input) {
  if (typeof input !== "string") return LLM_PROVIDER_DEFAULT;
  const id = input.trim().toLowerCase();
  return LLM_PROVIDERS[id] ? id : LLM_PROVIDER_DEFAULT;
}

function getProviderConfig(providerId) {
  return LLM_PROVIDERS[providerId] || LLM_PROVIDERS[LLM_PROVIDER_DEFAULT];
}

function getProviderClient(providerId) {
  if (providerId === "yandexgpt") return null;
  const cfg = getProviderConfig(providerId);
  const key = process.env[cfg.apiKeyEnv];
  if (!key) return null;
  const clientCfg = { apiKey: key };
  if (cfg.baseURL) clientCfg.baseURL = cfg.baseURL;
  return new OpenAI(clientCfg);
}

function getModelChain(providerId) {
  const cfg = getProviderConfig(providerId);
  return [process.env[cfg.modelEnv] || cfg.defaultModel, ...(cfg.fallbackModels || [])].filter(
    (v, i, arr) => v && arr.indexOf(v) === i
  );
}

function getMissingKeyMessage(providerId) {
  const cfg = getProviderConfig(providerId);
  return `${cfg.apiKeyEnv} не задан. Задайте ключ в UI (или через переменную окружения) и повторите запрос.`;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(" ")}\n${err || out}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listCandidateChunkFiles(jobDir) {
  const dirs = [path.join(jobDir, "chunks"), jobDir];
  const found = [];

  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const name = e.name.toLowerCase();
        if (!name.endsWith(".txt")) continue;
        if (name === "video.txt" || name === "transcript.txt") continue;
        if (name.startsWith("chunk") || name.includes("chunk") || name.includes("part") || name.includes("split")) {
          found.push(path.join(dir, e.name));
        }
      }
    } catch {}
  }

  if (found.length === 0) {
    try {
      const entries = await fs.readdir(jobDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const name = e.name.toLowerCase();
        if (name.endsWith(".txt") && name !== "video.txt" && name !== "transcript.txt") found.push(path.join(jobDir, e.name));
      }
    } catch {}
  }

  found.sort((a, b) => a.localeCompare(b, "en"));
  return found;
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

async function summarizeChunksWithLLM(chunks, providerId, sourceUrl) {
  const client = getProviderClient(providerId);
  if (providerId !== "yandexgpt" && !client) {
    return {
      summary: getMissingKeyMessage(providerId),
    };
  }
  if (providerId === "yandexgpt" && !process.env.YANDEXGPT_API_KEY) {
    return {
      summary: getMissingKeyMessage(providerId),
    };
  }

  const modelChain = getModelChain(providerId);

  function isRetriableError(e) {
    const status = e?.status || e?.response?.status;
    const code = e?.code || e?.cause?.code;
    if ([408, 409, 429, 500, 502, 503, 504].includes(status)) return true;
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code)) return true;
    const msg = String(e?.message || "");
    return msg.includes("ECONNRESET") || msg.includes("socket hang up") || msg.includes("network");
  }

  async function createCompletionWithRetry(model, messages) {
    const maxAttempts = 4;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (providerId === "yandexgpt") {
          if (!sourceUrl) throw new Error("Для YandexGPT (300.ya.ru) требуется исходный URL.");
          const endpoint = process.env.YANDEX300_ENDPOINT || "https://300.ya.ru/api/sharing-url";
          const r = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `OAuth ${process.env.YANDEXGPT_API_KEY}`,
            },
            body: JSON.stringify({
              article_url: sourceUrl,
            }),
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

        return await client.chat.completions.create({
          model,
          messages,
          temperature: 0.1,
        });
      } catch (e) {
        lastError = e;
        if (!isRetriableError(e) || attempt === maxAttempts) throw e;
        const backoffMs = 500 * Math.pow(2, attempt - 1);
        await sleep(backoffMs);
      }
    }
    throw lastError || new Error("LLM request failed");
  }

  async function createCompletionWithFallback(messages) {
    let lastError = null;
    for (let i = 0; i < modelChain.length; i++) {
      const model = modelChain[i];
      try {
        return await createCompletionWithRetry(model, messages);
      } catch (e) {
        lastError = e;
        const status = e?.status || e?.response?.status;
        const mayRetry = status === 403 || status === 404 || status === 429;
        if (!mayRetry || i === modelChain.length - 1) {
          throw e;
        }
      }
    }
    throw lastError || new Error("LLM request failed");
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
      warning:
        "OpenAI недоступен для текущего региона (403). Показан локальный офлайн-пересказ из транскрипта.",
    };
  }
}
app.get("/api/env/status", (_req, res) => {
  const openai = process.env.OPENAI_API_KEY || "";
  const deepseek = process.env.DEEPSEEK_API_KEY || "";
  const grok = process.env.GROK_API_KEY || "";
  const gemini = process.env.GEMINI_API_KEY || "";
  const yandexgpt = process.env.YANDEXGPT_API_KEY || "";
  const hf = process.env.HF_TOKEN || "";
  res.json({
    openai_api_key_set: Boolean(openai),
    deepseek_api_key_set: Boolean(deepseek),
    grok_api_key_set: Boolean(grok),
    gemini_api_key_set: Boolean(gemini),
    yandexgpt_api_key_set: Boolean(yandexgpt),
    hf_token_set: Boolean(hf),
  });
});

app.post("/api/env/set", (req, res) => {
  const { openai_api_key, deepseek_api_key, grok_api_key, gemini_api_key, yandexgpt_api_key, hf_token } = req.body || {};

  const nextOpenAI = typeof openai_api_key === "string" ? openai_api_key.trim() : null;
  const nextDeepSeek = typeof deepseek_api_key === "string" ? deepseek_api_key.trim() : null;
  const nextGrok = typeof grok_api_key === "string" ? grok_api_key.trim() : null;
  const nextGemini = typeof gemini_api_key === "string" ? gemini_api_key.trim() : null;
  const nextYandexGpt = typeof yandexgpt_api_key === "string" ? yandexgpt_api_key.trim() : null;
  const nextHF = typeof hf_token === "string" ? hf_token.trim() : null;

  if (nextOpenAI !== null) {
    if (!nextOpenAI) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = nextOpenAI;
  }
  if (nextDeepSeek !== null) {
    if (!nextDeepSeek) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = nextDeepSeek;
  }
  if (nextGrok !== null) {
    if (!nextGrok) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = nextGrok;
  }
  if (nextGemini !== null) {
    if (!nextGemini) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = nextGemini;
  }
  if (nextYandexGpt !== null) {
    if (!nextYandexGpt) delete process.env.YANDEXGPT_API_KEY;
    else process.env.YANDEXGPT_API_KEY = nextYandexGpt;
  }
  if (nextHF !== null) {
    if (!nextHF) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = nextHF;
  }

  res.json({
    ok: true,
    openai_api_key_set: Boolean(process.env.OPENAI_API_KEY),
    deepseek_api_key_set: Boolean(process.env.DEEPSEEK_API_KEY),
    grok_api_key_set: Boolean(process.env.GROK_API_KEY),
    gemini_api_key_set: Boolean(process.env.GEMINI_API_KEY),
    yandexgpt_api_key_set: Boolean(process.env.YANDEXGPT_API_KEY),
    hf_token_set: Boolean(process.env.HF_TOKEN),
  });
});

const SUMMARY_JOBS = new Map();
const SUMMARY_JOB_TTL_MS = 30 * 60 * 1000;

function serializeSummaryJob(job) {
  const currentElapsed =
    job.status === "running" && Number.isFinite(job.currentStepStartedAt)
      ? Date.now() - job.currentStepStartedAt
      : null;
  return {
    job_id: job.id,
    status: job.status,
    steps: job.steps,
    warnings: job.warnings,
    step_durations_ms: job.stepDurationsMs,
    current_step_elapsed_ms: currentElapsed,
    log: job.wantLog ? job.log : "",
    summary: job.status === "done" ? job.summary : "",
    error: job.status === "error" ? job.error : "",
  };
}

function scheduleSummaryJobCleanup(jobId) {
  const t = setTimeout(() => SUMMARY_JOBS.delete(jobId), SUMMARY_JOB_TTL_MS);
  if (typeof t.unref === "function") t.unref();
}

async function runSummaryPipeline({ url, providerId, wantLog, clean, wordLimit, job }) {
  const jobDir = path.join(WORK_ROOT, job.id);
  await fs.mkdir(jobDir, { recursive: true });

  let wav = path.join(jobDir, "audio.wav");
  const chunksDir = path.join(jobDir, "chunks");

  function startStep(stepIndex) {
    job.steps = stepIndex;
    job.currentStepStartedAt = Date.now();
  }

  function finishStep(stepIndex) {
    if (!Number.isFinite(job.currentStepStartedAt)) return;
    job.stepDurationsMs[stepIndex] = Date.now() - job.currentStepStartedAt;
    job.currentStepStartedAt = null;
  }

  // 1) download audio (wav)
  startStep(0);
  const cookiesFile = process.env.COOKIES_FILE;
  const cookieArgs = cookiesFile ? ["--cookies", cookiesFile] : [];
  const dl = await run(
    YTDLP,
    [
      ...cookieArgs,
      "-x",
      "--audio-format",
      "wav",
      "--audio-quality",
      "0",
      "--postprocessor-args",
      "ffmpeg:-ar 16000 -ac 1",
      "-o",
      wav,
      url,
    ],
    { cwd: jobDir }
  );
  finishStep(0);
  if (wantLog) job.log += `# download\n${dl.out}\n${dl.err}\n`;
  if (dl.err && !wantLog) job.warnings.push(`yt-dlp stderr:\n${dl.err.trim()}`);
  if (!existsSync(wav)) {
    const entries = await fs.readdir(jobDir);
    const foundWav = entries.find((name) => name.toLowerCase().endsWith(".wav"));
    if (foundWav) {
      job.warnings.push(`audio.wav не найден, использую ${foundWav} (скачан этот файл)`);
      wav = path.join(jobDir, foundWav);
    } else {
      throw new Error("yt-dlp did not produce a .wav file. Check yt-dlp/ffmpeg output.");
    }
  }

  // 2) WhisperX -> txt
  startStep(1);
  const hfToken = process.env.HF_TOKEN;
  if (!hfToken) throw new Error("HF_TOKEN is not set");
  const wx = await run(
    PYTHON,
    [WHISPERX_SCRIPT_PATH, wav, "--model", "large-v2", "--diarize", "--highlight_words", "True", "--output_dir", jobDir, "--output_format", "txt"],
    { cwd: process.cwd() }
  );
  finishStep(1);
  if (wantLog) job.log += `# whisperx\n${wx.out}\n${wx.err}\n`;

  const expectedTxt = path.join(jobDir, `${path.parse(wav).name}.txt`);
  let transcriptPath = process.env.TRANSCRIPT_PATH || expectedTxt;
  if (!existsSync(transcriptPath)) {
    const entries = await fs.readdir(jobDir);
    const anyTxt = entries.find((n) => n.toLowerCase().endsWith(".txt"));
    if (!anyTxt) throw new Error("WhisperX output .txt not found. Set TRANSCRIPT_PATH or adjust run_whisperx.py output.");
    transcriptPath = path.join(jobDir, anyTxt);
  }

  // 3) split into chunks
  startStep(2);
  const splitArgs = [SPLIT_SCRIPT_PATH, transcriptPath, "-o", chunksDir];
  if (wordLimit) splitArgs.push("-w", String(wordLimit));
  if (!clean) splitArgs.push("--no-clean");
  if (!wantLog) splitArgs.push("--no-log");

  const sp = await run(PYTHON, splitArgs, { cwd: process.cwd() });
  finishStep(2);
  if (wantLog) job.log += `# split\n${sp.out}\n${sp.err}\n`;

  const chunkFiles = await listCandidateChunkFiles(jobDir);
  if (chunkFiles.length === 0) {
    throw new Error("Chunks not found after split. Ensure split_whisperx.py writes chunk files into the job folder.");
  }

  const chunks = [];
  for (const p of chunkFiles) {
    const t = await fs.readFile(p, "utf-8");
    if (t.trim()) chunks.push(t);
  }

  // 4) LLM summary
  startStep(3);
  const { summary, warning } = await summarizeChunksWithLLM(chunks, providerId, url);
  finishStep(3);
  if (warning) job.warnings.push(warning);
  if (wantLog) job.log += `# llm provider: ${providerId}\n`;

  return { summary };
}

app.get("/api/vk/summary/status/:jobId", (req, res) => {
  const job = SUMMARY_JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json(serializeSummaryJob(job));
});

app.post("/api/vk/summary", async (req, res) => {
  const { url, options } = req.body || {};
  const providerId = normalizeProvider(options?.llm_provider);
  const wantLog = !!options?.log;
  const clean = options?.clean ?? true;
  const wordLimit = options?.word_limit ?? null;
  const asyncMode = options?.async === true;

  if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url" });
  if (!isValidVkMask(url)) return res.status(400).json({ error: "VK-only: unsupported url" });

  const job = {
    id: crypto.randomUUID(),
    status: "running",
    steps: -1,
    warnings: [],
    stepDurationsMs: [null, null, null, null],
    currentStepStartedAt: null,
    log: "",
    summary: "",
    error: "",
    wantLog,
  };

  if (asyncMode) {
    SUMMARY_JOBS.set(job.id, job);
    scheduleSummaryJobCleanup(job.id);
    (async () => {
      try {
        const { summary } = await runSummaryPipeline({ url, providerId, wantLog, clean, wordLimit, job });
        job.summary = summary;
        job.status = "done";
      } catch (e) {
        job.error = e?.message || "Pipeline failed";
        job.status = "error";
      } finally {
        job.currentStepStartedAt = null;
      }
    })();
    return res.json({ job_id: job.id, status: "running" });
  }

  try {
    const { summary } = await runSummaryPipeline({ url, providerId, wantLog, clean, wordLimit, job });
    job.summary = summary;
    job.status = "done";
    return res.json({
      summary: job.summary,
      log: wantLog ? job.log : "",
      steps: job.steps,
      warnings: job.warnings,
      step_durations_ms: job.stepDurationsMs,
    });
  } catch (e) {
    job.error = e?.message || "Pipeline failed";
    job.status = "error";
    return res.status(500).json({
      error: job.error,
      log: wantLog ? job.log : "",
      steps: job.steps,
      warnings: job.warnings,
      step_durations_ms: job.stepDurationsMs,
    });
  }
});

if (existsSync(UI_DIST)) {
  app.use(express.static(UI_DIST));
  app.get("*", (_req, res) => res.sendFile(path.join(UI_DIST, "index.html")));
} else {
  app.get("/", (_req, res) => res.send("UI not built. Run `npm run build` or `npm run dev`."));
}

app.listen(PORT, async () => {
  await fs.mkdir(WORK_ROOT, { recursive: true });
  console.log(`Server: http://localhost:${PORT}`);
});


