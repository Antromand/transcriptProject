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

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
function getOpenAIClient() {
  const key = process.env.OPENAI_API_KEY;
  return key ? new OpenAI({ apiKey: key }) : null;
}

function getPreferredOpenAIModel() {
  return process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
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

async function summarizeChunksWithOpenAI(chunks) {
  const client = getOpenAIClient();
  if (!client) {
    return {
      summary: "OPENAI_API_KEY не задан. Задайте ключ в UI (или через переменную окружения) и повторите запрос.",
    };
  }

  const modelChain = [getPreferredOpenAIModel(), "gpt-4o-mini", "gpt-4.1-mini"].filter(
    (v, i, arr) => v && arr.indexOf(v) === i
  );

  function isRetriableError(e) {
    const status = e?.status || e?.response?.status;
    const code = e?.code || e?.cause?.code;
    if ([408, 409, 429, 500, 502, 503, 504].includes(status)) return true;
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code)) return true;
    const msg = String(e?.message || "");
    return msg.includes("ECONNRESET") || msg.includes("socket hang up") || msg.includes("network");
  }

  async function createResponseWithRetry(model, input) {
    const maxAttempts = 4;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await client.responses.create({ model, input });
      } catch (e) {
        lastError = e;
        if (!isRetriableError(e) || attempt === maxAttempts) throw e;
        const backoffMs = 500 * Math.pow(2, attempt - 1);
        await sleep(backoffMs);
      }
    }
    throw lastError || new Error("OpenAI request failed");
  }

  async function createResponseWithFallback(input) {
    let lastError = null;
    for (let i = 0; i < modelChain.length; i++) {
      const model = modelChain[i];
      try {
        return await createResponseWithRetry(model, input);
      } catch (e) {
        lastError = e;
        const status = e?.status || e?.response?.status;
        const mayRetry = status === 403 || status === 404 || status === 429;
        if (!mayRetry || i === modelChain.length - 1) {
          throw e;
        }
      }
    }
    throw lastError || new Error("OpenAI request failed");
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
      const resp = await createResponseWithFallback([
        { role: "system", content: "Суммируй текст кратко и строго по фактам. 3-6 буллетов, без воды." },
        { role: "user", content: `Чанк ${i + 1}/${chunks.length}:\n\n${text}` },
      ]);
      partials.push(resp.output_text?.trim() || "");
    }

    const merged = partials.filter(Boolean).join("\n");
    const final = await createResponseWithFallback([
      { role: "system", content: "Собери единый краткий пересказ. 8-14 буллетов. Без повторов. По сути." },
      { role: "user", content: merged },
    ]);

    return { summary: final.output_text?.trim() || "" };
  } catch (e) {
    const status = e?.status || e?.response?.status;
    const msg = String(e?.message || "");
    const regionBlocked = status === 403 && msg.toLowerCase().includes("country, region, or territory not supported");
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
  const hf = process.env.HF_TOKEN || "";
  res.json({
    openai_api_key_set: Boolean(openai),
    hf_token_set: Boolean(hf),
  });
});

app.post("/api/env/set", (req, res) => {
  const { openai_api_key, hf_token } = req.body || {};

  const nextOpenAI = typeof openai_api_key === "string" ? openai_api_key.trim() : null;
  const nextHF = typeof hf_token === "string" ? hf_token.trim() : null;

  if (nextOpenAI !== null) {
    if (!nextOpenAI) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = nextOpenAI;
  }
  if (nextHF !== null) {
    if (!nextHF) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = nextHF;
  }

  res.json({
    ok: true,
    openai_api_key_set: Boolean(process.env.OPENAI_API_KEY),
    hf_token_set: Boolean(process.env.HF_TOKEN),
  });
});

app.post("/api/vk/summary", async (req, res) => {
  const { url, options } = req.body || {};
  const wantLog = !!options?.log;
  const clean = options?.clean ?? true;
  const wordLimit = options?.word_limit ?? null;

  if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url" });
  if (!isValidVkMask(url)) return res.status(400).json({ error: "VK-only: unsupported url" });

  const jobId = crypto.randomUUID();
  const jobDir = path.join(WORK_ROOT, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  let steps = -1;
  let log = "";

  let wav = path.join(jobDir, "audio.wav");
  const chunksDir = path.join(jobDir, "chunks");
  const warnings = [];

  try {
    // 1) download audio (wav)
    steps = 0;
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
    if (wantLog) log += `# download\n${dl.out}\n${dl.err}\n`;
    if (dl.err && !wantLog) warnings.push(`yt-dlp stderr:\n${dl.err.trim()}`);
    if (!existsSync(wav)) {
      const entries = await fs.readdir(jobDir);
      const foundWav = entries.find((name) => name.toLowerCase().endsWith(".wav"));
      if (foundWav) {
        warnings.push(`audio.wav РЅРµ РЅР°Р№РґРµРЅ, РёСЃРїРѕР»СЊР·СѓСЋ ${foundWav} (СЃРєР°С‡Р°РЅ СЌС‚РѕС‚ С„Р°Р№Р»)`);
        wav = path.join(jobDir, foundWav);
      } else {
        throw new Error("yt-dlp did not produce a .wav file. Check yt-dlp/ffmpeg output.");
      }
    }

    // 2) WhisperX -> txt
    steps = 1;
    const hfToken = process.env.HF_TOKEN;
    if (!hfToken) throw new Error("HF_TOKEN is not set");
    const wx = await run(
      PYTHON,
      [WHISPERX_SCRIPT_PATH, wav, "--model", "large-v2", "--diarize", "--highlight_words", "True", "--output_dir", jobDir, "--output_format", "txt"],
      { cwd: process.cwd() }
    );
    if (wantLog) log += `# whisperx\n${wx.out}\n${wx.err}\n`;

    const expectedTxt = path.join(jobDir, `${path.parse(wav).name}.txt`);
    let transcriptPath = process.env.TRANSCRIPT_PATH || expectedTxt;
    if (!existsSync(transcriptPath)) {
      const entries = await fs.readdir(jobDir);
      const anyTxt = entries.find((n) => n.toLowerCase().endsWith(".txt"));
      if (!anyTxt) throw new Error("WhisperX output .txt not found. Set TRANSCRIPT_PATH or adjust run_whisperx.py output.");
      transcriptPath = path.join(jobDir, anyTxt);
    }

    // 3) split into chunks
    steps = 2;
    const splitArgs = [SPLIT_SCRIPT_PATH, transcriptPath, "-o", chunksDir];
    if (wordLimit) splitArgs.push("-w", String(wordLimit));
    if (!clean) splitArgs.push("--no-clean");
    if (!wantLog) splitArgs.push("--no-log");

    const sp = await run(PYTHON, splitArgs, { cwd: process.cwd() });
    if (wantLog) log += `# split\n${sp.out}\n${sp.err}\n`;

    const chunkFiles = await listCandidateChunkFiles(jobDir);
    if (chunkFiles.length === 0) {
      throw new Error("Chunks not found after split. Ensure split_whisperx.py writes chunk files into the job folder.");
    }

    const chunks = [];
    for (const p of chunkFiles) {
      const t = await fs.readFile(p, "utf-8");
      if (t.trim()) chunks.push(t);
    }

    // 4) OpenAI summary
    steps = 3;
    const { summary, warning } = await summarizeChunksWithOpenAI(chunks);
    if (warning) warnings.push(warning);

    return res.json({ summary, log: wantLog ? log : "", steps, warnings });
  } catch (e) {
    return res
      .status(500)
      .json({ error: e?.message || "Pipeline failed", log: wantLog ? log : "", steps, warnings });
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


