import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

function runCommand(cmd, args, { cwd } = {}) {
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

export class SummaryPipelineService {
  constructor({
    workRoot,
    ytdlpBin,
    pythonBin,
    whisperxScriptPath,
    splitScriptPath,
    existsSync,
    llmService,
    env = process.env,
  }) {
    this.workRoot = workRoot;
    this.ytdlpBin = ytdlpBin;
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

  // Запускает end-to-end конвейер и заполняет объект job по ходу выполнения.
  async run({ url, providerId, wantLog, clean, wordLimit, job }) {
    const jobDir = path.join(this.workRoot, job.id);
    await fs.mkdir(jobDir, { recursive: true });

    let wav = path.join(jobDir, "audio.wav");
    const chunksDir = path.join(jobDir, "chunks");

    const startStep = (stepIndex) => {
      job.steps = stepIndex;
      job.currentStepStartedAt = Date.now();
    };

    const finishStep = (stepIndex) => {
      if (!Number.isFinite(job.currentStepStartedAt)) return;
      job.stepDurationsMs[stepIndex] = Date.now() - job.currentStepStartedAt;
      job.currentStepStartedAt = null;
    };

    startStep(0);
    const cookiesFile = this.env.COOKIES_FILE;
    const cookieArgs = cookiesFile ? ["--cookies", cookiesFile] : [];
    const dl = await runCommand(
      this.ytdlpBin,
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

    startStep(1);
    const hfToken = this.env.HF_TOKEN;
    if (!hfToken) throw new Error("HF_TOKEN is not set");
    const wx = await runCommand(
      this.pythonBin,
      [this.whisperxScriptPath, wav, "--model", "large-v2", "--diarize", "--highlight_words", "True", "--output_dir", jobDir, "--output_format", "txt"],
      { cwd: process.cwd() }
    );
    finishStep(1);
    if (wantLog) job.log += `# whisperx\n${wx.out}\n${wx.err}\n`;

    const expectedTxt = path.join(jobDir, `${path.parse(wav).name}.txt`);
    let transcriptPath = this.env.TRANSCRIPT_PATH || expectedTxt;
    if (!this.existsSync(transcriptPath)) {
      const entries = await fs.readdir(jobDir);
      const anyTxt = entries.find((n) => n.toLowerCase().endsWith(".txt"));
      if (!anyTxt) throw new Error("WhisperX output .txt not found. Set TRANSCRIPT_PATH or adjust run_whisperx.py output.");
      transcriptPath = path.join(jobDir, anyTxt);
    }

    startStep(2);
    const splitArgs = [this.splitScriptPath, transcriptPath, "-o", chunksDir];
    if (wordLimit) splitArgs.push("-w", String(wordLimit));
    if (!clean) splitArgs.push("--no-clean");
    if (!wantLog) splitArgs.push("--no-log");
    const sp = await runCommand(this.pythonBin, splitArgs, { cwd: process.cwd() });
    finishStep(2);
    if (wantLog) job.log += `# split\n${sp.out}\n${sp.err}\n`;

    const chunkFiles = await this.listCandidateChunkFiles(jobDir);
    if (chunkFiles.length === 0) {
      throw new Error("Chunks not found after split. Ensure split_whisperx.py writes chunk files into the job folder.");
    }

    const chunks = [];
    for (const p of chunkFiles) {
      const t = await fs.readFile(p, "utf-8");
      if (t.trim()) chunks.push(t);
    }

    startStep(3);
    const { summary, warning } = await this.llmService.summarizeChunks(chunks, { providerId, sourceUrl: url });
    finishStep(3);
    if (warning) job.warnings.push(warning);
    if (wantLog) job.log += `# llm provider: ${providerId}\n`;
    return { summary };
  }
}
