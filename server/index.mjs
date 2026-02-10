import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import OpenAI from "openai";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WORK_ROOT = process.env.WORK_ROOT || path.join(process.cwd(), "work");
const UI_DIST = process.env.UI_DIST || path.join(process.cwd(), "ui", "dist");

const YTDLP = process.env.YTDLP_BIN || "yt-dlp";
const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const PYTHON = process.env.PYTHON_BIN || "python";

const WHISPERX_SCRIPT = process.env.WHISPERX_SCRIPT || "run_whisperx.py";
const SPLIT_SCRIPT = process.env.SPLIT_SCRIPT || "split_whisperx.py";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const app = express();
app.use(express.json({ limit: "2mb" }));

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: true });
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

function isVkUrl(raw) {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    return h === "vk.com" || h.endsWith(".vk.com") || h === "vk.ru" || h.endsWith(".vk.ru");
  } catch {
    return false;
  }
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
  if (!client) {
    return {
      summary: "OPENAI_API_KEY не задан. Установите переменную окружения и перезапустите сервер.",
    };
  }

  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    const resp = await client.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: "Суммируй текст кратко и строго по фактам. 3–6 буллетов, без воды." },
        { role: "user", content: `Чанк ${i + 1}/${chunks.length}:\n\n${text}` },
      ],
    });
    partials.push(resp.output_text?.trim() || "");
  }

  const merged = partials.filter(Boolean).join("\n");
  const final = await client.responses.create({
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: "Собери единый краткий пересказ. 8–14 буллетов. Без повторов. По сути." },
      { role: "user", content: merged },
    ],
  });

  return { summary: final.output_text?.trim() || "" };
}

app.post("/api/vk/summary", async (req, res) => {
  const { url, options } = req.body || {};
  const wantLog = !!options?.log;
  const clean = options?.clean ?? true;
  const wordLimit = options?.word_limit ?? null;

  if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url" });
  if (!isVkUrl(url)) return res.status(400).json({ error: "VK-only: unsupported url" });

  const jobId = crypto.randomUUID();
  const jobDir = path.join(WORK_ROOT, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  let steps = -1;
  let log = "";

  const mp4 = path.join(jobDir, "video.mp4");
  const wav = path.join(jobDir, "audio.wav");
  const txt = path.join(jobDir, "video.txt");

  try {
    // 1) download mp4
    steps = 0;
    const cookiesFile = process.env.COOKIES_FILE;
    const cookieArgs = cookiesFile ? ["--cookies", cookiesFile] : ["--cookies-from-browser", "chrome"];
    const dl = await run(YTDLP, [...cookieArgs, "-f", "bv*+ba/b", "-o", mp4, url], { cwd: jobDir });
    if (wantLog) log += `# download\n${dl.out}\n${dl.err}\n`;

    // 2) ffmpeg -> wav
    steps = 1;
    const ff = await run(FFMPEG, ["-i", mp4, "-vn", "-ar", "16000", "-ac", "1", wav], { cwd: jobDir });
    if (wantLog) log += `# ffmpeg\n${ff.out}\n${ff.err}\n`;

    // 3) WhisperX -> txt
    steps = 2;
    const hfToken = process.env.HF_TOKEN;
    if (!hfToken) throw new Error("HF_TOKEN is not set");
    const wx = await run(PYTHON, [WHISPERX_SCRIPT, wav, "--model", "large-v2", "--diarize", "--hf_token", hfToken, "--highlight_words", "True"], { cwd: process.cwd() });
    if (wantLog) log += `# whisperx\n${wx.out}\n${wx.err}\n`;

    const transcriptPath = process.env.TRANSCRIPT_PATH || txt;
    if (!existsSync(transcriptPath)) {
      const entries = await fs.readdir(jobDir);
      const anyTxt = entries.find((n) => n.toLowerCase().endsWith(".txt"));
      if (!anyTxt) throw new Error("WhisperX output .txt not found. Set TRANSCRIPT_PATH or adjust run_whisperx.py output.");
    }

    // 4) split into chunks
    steps = 3;
    const splitArgs = [SPLIT_SCRIPT, transcriptPath];
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

    // 5) OpenAI summary
    steps = 4;
    const { summary } = await summarizeChunksWithOpenAI(chunks);

    return res.json({ summary, log: wantLog ? log : "", steps });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Pipeline failed", log: wantLog ? log : "", steps });
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
