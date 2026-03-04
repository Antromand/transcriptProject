import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

function runCommand(cmd, args, { cwd, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    if (typeof onSpawn === "function") onSpawn(p);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (typeof onSpawn === "function") onSpawn(null);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(" ")}\n${err || out}`));
    });
    p.on("error", (spawnError) => {
      if (typeof onSpawn === "function") onSpawn(null);
      reject(spawnError);
    });
  });
}

export class SummaryPipelineService {
  constructor({
    workRoot,
    ytdlpBin,
    ffmpegBin,
    ytdlpJsRuntimes,
    ytdlpRemoteComponents,
    ytdlpYoutubeExtractorArgs,
    ytdlpYoutubePoToken,
    pythonBin,
    whisperxScriptPath,
    splitScriptPath,
    existsSync,
    llmService,
    env = process.env,
  }) {
    this.workRoot = workRoot;
    this.ytdlpBin = ytdlpBin;
    this.ffmpegBin = ffmpegBin || "ffmpeg";
    this.ytdlpJsRuntimes = ytdlpJsRuntimes || "node deno";
    this.ytdlpRemoteComponents = ytdlpRemoteComponents || "ejs:github";
    this.ytdlpYoutubeExtractorArgs = ytdlpYoutubeExtractorArgs || "player_client=android,web";
    this.ytdlpYoutubePoToken = ytdlpYoutubePoToken || "";
    this.pythonBin = pythonBin;
    this.whisperxScriptPath = whisperxScriptPath;
    this.splitScriptPath = splitScriptPath;
    this.existsSync = existsSync;
    this.llmService = llmService;
    this.env = env;
  }

  async listCandidateChunkFiles(jobDir) {
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

  async readChunksFromJobDir(jobDir) {
    const chunkFiles = await this.listCandidateChunkFiles(jobDir);
    if (chunkFiles.length === 0) return [];
    const chunks = [];
    for (const p of chunkFiles) {
      const t = await fs.readFile(p, "utf-8");
      if (t.trim()) chunks.push(t);
    }
    return chunks;
  }

  // Запускает end-to-end конвейер и заполняет объект job по ходу выполнения.
  async run({
    url,
    localVideoPath = "",
    providerId,
    summaryFormat,
    wantLog,
    diagnosticsMode = false,
    clean,
    wordLimit,
    job,
    startFromStep = 1,
    seededInputs = {},
  }) {
    const jobDir = path.join(this.workRoot, job.id);
    await fs.mkdir(jobDir, { recursive: true });

    const normalizedStart = Math.max(1, Math.min(4, Number(startFromStep) || 1));
    let wav = seededInputs.wavPath || path.join(jobDir, "audio.wav");
    const chunksDir = path.join(jobDir, "chunks");
    let transcriptPath = seededInputs.transcriptPath || null;
    let chunks = [];

    const startStep = (stepIndex) => {
      job.steps = stepIndex;
      job.currentStepStartedAt = Date.now();
    };

    const finishStep = (stepIndex) => {
      if (!Number.isFinite(job.currentStepStartedAt)) return;
      job.stepDurationsMs[stepIndex] = Date.now() - job.currentStepStartedAt;
      job.currentStepStartedAt = null;
    };

    this.throwIfCanceled(job);

    if (normalizedStart <= 1) {
      startStep(0);
      const sourceLocalPath = String(localVideoPath || "").trim();
      const isLocalInput = Boolean(sourceLocalPath);
      const isYoutube = this.isYoutubeUrl(url);
      let dl;
      if (isLocalInput) {
        if (!this.existsSync(sourceLocalPath)) {
          throw new Error(`Локальный файл не найден: ${sourceLocalPath}`);
        }
        dl = await this.runTrackedCommand(
          job,
          this.ffmpegBin,
          ["-y", "-i", sourceLocalPath, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", wav],
          { cwd: jobDir }
        );
      } else {
        const cookiesFile = this.env.COOKIES_FILE;
        const cookieArgs = cookiesFile ? ["--cookies", cookiesFile] : [];
        const ytdlpArgs = [
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
        ];
        if (isYoutube && this.ytdlpJsRuntimes) {
          const jsRuntimeArgs = this.buildJsRuntimeArgs();
          if (jsRuntimeArgs.length > 0) ytdlpArgs.push(...jsRuntimeArgs);
        }
        if (isYoutube && this.ytdlpRemoteComponents) {
          const remoteComponentArgs = this.buildRemoteComponentArgs();
          if (remoteComponentArgs.length > 0) ytdlpArgs.push(...remoteComponentArgs);
        }
        if (isYoutube && this.ytdlpYoutubeExtractorArgs) {
          ytdlpArgs.push("--extractor-args", `youtube:${this.ytdlpYoutubeExtractorArgs}`);
        }
        if (isYoutube && this.ytdlpYoutubePoToken) {
          const poToken = this.normalizeYoutubePoToken(this.ytdlpYoutubePoToken);
          if (poToken) ytdlpArgs.push("--extractor-args", `youtube:po_token=${poToken}`);
        }
        ytdlpArgs.push(url);

        try {
          dl = await this.runTrackedCommand(job, this.ytdlpBin, ytdlpArgs, { cwd: jobDir });
        } catch (error) {
          this.throwIfCanceled(job);
          const msg = String(error?.message || "");
          // Older yt-dlp builds may not have --js-runtimes.
          if (isYoutube && msg.includes("--js-runtimes")) {
            const retryArgs = ytdlpArgs.filter((v, idx) => !(v === "--js-runtimes" || ytdlpArgs[idx - 1] === "--js-runtimes"));
            dl = await this.runTrackedCommand(job, this.ytdlpBin, retryArgs, { cwd: jobDir });
            job.warnings.push("yt-dlp не поддерживает --js-runtimes, выполнен повторный запуск без этого флага.");
          } else if (isYoutube && msg.includes("--remote-components")) {
            const retryArgs = ytdlpArgs.filter((v, idx) => !(v === "--remote-components" || ytdlpArgs[idx - 1] === "--remote-components"));
            dl = await this.runTrackedCommand(job, this.ytdlpBin, retryArgs, { cwd: jobDir });
            job.warnings.push("yt-dlp не поддерживает --remote-components, выполнен повторный запуск без этого флага.");
          } else {
            throw error;
          }
        }
      }
      this.throwIfCanceled(job);
      finishStep(0);
      if (wantLog) job.log += `# download\n${dl.out}\n${dl.err}\n`;
      if (dl.err && !wantLog) {
        const cleanedErr = this.cleanStep1Warnings({
          stderrText: dl.err,
          isYoutube,
          isLocalInput,
          diagnosticsMode,
        });
        if (cleanedErr.trim()) job.warnings.push(`yt-dlp stderr:\n${cleanedErr.trim()}`);
      }
      if (!this.existsSync(wav)) {
        const entries = await fs.readdir(jobDir);
        const foundWav = entries.find((name) => name.toLowerCase().endsWith(".wav"));
        if (foundWav) {
          job.warnings.push(`audio.wav не найден, использую ${foundWav} (скачан этот файл)`);
          wav = path.join(jobDir, foundWav);
        } else {
          throw new Error("yt-dlp did not produce a .wav file. Check yt-dlp/ffmpeg output.");
        }
      }
    } else if (normalizedStart === 2) {
      if (!this.existsSync(wav)) {
        throw new Error("Файл .wav для шага 2 не найден.");
      }
    }

    if (normalizedStart <= 2) {
      this.throwIfCanceled(job);
      startStep(1);
      const hfToken = this.env.HF_TOKEN;
      if (!hfToken) throw new Error("HF_TOKEN is not set");
      const wx = await this.runTrackedCommand(
        job,
        this.pythonBin,
        [this.whisperxScriptPath, wav, "--model", "large-v2", "--diarize", "--highlight_words", "True", "--output_dir", jobDir, "--output_format", "txt"],
        { cwd: process.cwd() }
      );
      this.throwIfCanceled(job);
      finishStep(1);
      if (wantLog) job.log += `# whisperx\n${wx.out}\n${wx.err}\n`;

      const expectedTxt = path.join(jobDir, `${path.parse(wav).name}.txt`);
      transcriptPath = this.env.TRANSCRIPT_PATH || expectedTxt;
      if (!this.existsSync(transcriptPath)) {
        const entries = await fs.readdir(jobDir);
        const anyTxt = entries.find((n) => n.toLowerCase().endsWith(".txt"));
        if (!anyTxt) throw new Error("WhisperX output .txt not found. Set TRANSCRIPT_PATH or adjust run_whisperx.py output.");
        transcriptPath = path.join(jobDir, anyTxt);
      }
    } else if (normalizedStart === 3) {
      transcriptPath = transcriptPath || path.join(jobDir, "transcript.txt");
      if (!this.existsSync(transcriptPath)) {
        throw new Error("Файл .txt транскрипта для шага 3 не найден.");
      }
    } else if (normalizedStart === 4) {
      chunks = await this.readChunksFromJobDir(jobDir);
      if (chunks.length === 0 && seededInputs.summaryTextPath && this.existsSync(seededInputs.summaryTextPath)) {
        const text = await fs.readFile(seededInputs.summaryTextPath, "utf-8");
        if (text.trim()) chunks = [text];
      }
      if (chunks.length === 0) {
        throw new Error("Для шага 4 не найдены чанки или текстовый файл.");
      }
    }

    if (normalizedStart <= 3) {
      this.throwIfCanceled(job);
      startStep(2);
      const splitArgs = [this.splitScriptPath, transcriptPath, "-o", chunksDir];
      if (wordLimit) splitArgs.push("-w", String(wordLimit));
      if (!clean) splitArgs.push("--no-clean");
      if (!wantLog) splitArgs.push("--no-log");
      const sp = await this.runTrackedCommand(job, this.pythonBin, splitArgs, { cwd: process.cwd() });
      this.throwIfCanceled(job);
      finishStep(2);
      if (wantLog) job.log += `# split\n${sp.out}\n${sp.err}\n`;

      chunks = await this.readChunksFromJobDir(jobDir);
      if (chunks.length === 0) {
        throw new Error("Chunks not found after split. Ensure split_whisperx.py writes chunk files into the job folder.");
      }
    }

    this.throwIfCanceled(job);
    startStep(3);
    const { summary, warning } = await this.llmService.summarizeChunks(chunks, { providerId, summaryFormat, sourceUrl: url });
    this.throwIfCanceled(job);
    finishStep(3);
    if (warning) job.warnings.push(warning);
    if (wantLog) job.log += `# llm provider: ${providerId}\n`;
    return { summary };
  }

  isYoutubeUrl(rawUrl) {
    try {
      const host = new URL(String(rawUrl || "")).hostname.toLowerCase();
      return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host.endsWith(".youtu.be");
    } catch {
      return false;
    }
  }

  buildJsRuntimeArgs() {
    const raw = String(this.ytdlpJsRuntimes || "").trim();
    if (!raw) return [];

    const tokens = raw
      .split(/[,\s;|]+/)
      .map((v) => v.trim())
      .filter(Boolean);

    const normalized = [];
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower === "node" || lower === "nodejs") {
        const nodePath = process.execPath || "";
        if (nodePath && /node(\.exe)?$/i.test(path.basename(nodePath))) {
          normalized.push(`node:${nodePath}`);
        } else {
          normalized.push("node");
        }
        continue;
      }
      normalized.push(token);
    }

    const unique = normalized.filter((v, i, arr) => arr.indexOf(v) === i);
    const args = [];
    for (const rt of unique) {
      args.push("--js-runtimes", rt);
    }
    return args;
  }

  buildRemoteComponentArgs() {
    const raw = String(this.ytdlpRemoteComponents || "").trim();
    if (!raw) return [];
    const tokens = raw
      .split(/[,\s;|]+/)
      .map((v) => v.trim())
      .filter(Boolean);
    const unique = tokens.filter((v, i, arr) => arr.indexOf(v) === i);
    const args = [];
    for (const component of unique) {
      args.push("--remote-components", component);
    }
    return args;
  }

  cleanYoutubeNonFatalWarnings(stderrText) {
    const text = String(stderrText || "");
    if (!text.trim()) return "";
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const filtered = lines.filter((line) => {
      const lower = line.toLowerCase();
      if (!lower.includes("warning: [youtube]")) return true;
      if (lower.includes("[jsc]")) return false;
      if (lower.includes("n challenge solving failed")) return false;
      if (lower.includes("remote component challenge solver script")) return false;
      if (lower.includes("some formats may be missing")) return false;
      if (lower.includes("android client https formats require a gvs po token")) return false;
      if (lower.includes("you can manually pass a gvs po token")) return false;
      return true;
    });
    return filtered.join("\n");
  }

  cleanStep1Warnings({ stderrText, isYoutube, isLocalInput, diagnosticsMode }) {
    const text = String(stderrText || "");
    if (!text.trim()) return "";

    // ffmpeg writes technical progress/details into stderr even on success.
    // Hide this noise for local-file mode unless diagnostics is enabled.
    if (isLocalInput && !diagnosticsMode) return "";

    if (isYoutube && !diagnosticsMode) {
      return this.cleanYoutubeNonFatalWarnings(text);
    }

    return text;
  }

  normalizeYoutubePoToken(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.includes("android.gvs+")) return raw;
    return `android.gvs+${raw}`;
  }

  async runTrackedCommand(job, cmd, args, options = {}) {
    return runCommand(cmd, args, {
      ...options,
      onSpawn: (proc) => {
        job.currentProcess = proc;
      },
    });
  }

  throwIfCanceled(job) {
    if (!job?.cancelRequested) return;
    const error = new Error("Job canceled by user");
    error.code = "JOB_CANCELED";
    throw error;
  }
}
