import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";

// Контроллер инкапсулирует HTTP-логику summary:
// валидация, запуск job, финализация, ответы API.
export class SummaryController {
  constructor({ isValidVkMask, llmService, pipelineService, jobStore, auditLogger, envService }) {
    this.isValidVkMask = isValidVkMask;
    this.llmService = llmService;
    this.pipelineService = pipelineService;
    this.jobStore = jobStore;
    this.auditLogger = auditLogger;
    this.envService = envService;
  }

  getStatus(req, res) {
    const job = this.jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    return res.json(this.jobStore.serialize(job));
  }

  async create(req, res) {
    const { url, options } = req.body || {};
    const providerId = this.llmService.normalizeProvider(options?.llm_provider);
    const summaryFormat = this.llmService.normalizeSummaryFormat(options?.summary_format);
    const wantLog = !!options?.log;
    const clean = options?.clean ?? true;
    const wordLimit = options?.word_limit ?? null;
    const asyncMode = options?.async === true;

    if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing url" });
    if (!this.isValidVkMask(url)) return res.status(400).json({ error: "VK-only: unsupported url" });

    const job = this.createJob({ url, providerId, wantLog });

    if (asyncMode) {
      this.jobStore.set(job);
      (async () => {
        try {
          const { summary } = await this.pipelineService.run({ url, providerId, summaryFormat, wantLog, clean, wordLimit, job });
          job.summary = summary;
          await this.finalizeJobAndAudit(job, "done");
        } catch (e) {
          await this.finalizeJobAndAudit(job, "error", e?.message || "Pipeline failed");
        }
      })();
      return res.json({ job_id: job.id, status: "running" });
    }

    try {
      const { summary } = await this.pipelineService.run({ url, providerId, summaryFormat, wantLog, clean, wordLimit, job });
      job.summary = summary;
      await this.finalizeJobAndAudit(job, "done");
      return res.json({
        summary: job.summary,
        log: wantLog ? job.log : "",
        steps: job.steps,
        warnings: job.warnings,
        step_durations_ms: job.stepDurationsMs,
      });
    } catch (e) {
      await this.finalizeJobAndAudit(job, "error", e?.message || "Pipeline failed");
      return res.status(500).json({
        error: job.error,
        log: wantLog ? job.log : "",
        steps: job.steps,
        warnings: job.warnings,
        step_durations_ms: job.stepDurationsMs,
      });
    }
  }

  async createFromStart(req, res) {
    try {
      const payload = await this.parseStartPayload(req);
      const startStep = this.normalizeStartStep(payload?.start_step);
      const options = payload?.options || {};
      const url = typeof payload?.url === "string" ? payload.url.trim() : "";
      const providerId = this.llmService.normalizeProvider(options?.llm_provider);
      const summaryFormat = this.llmService.normalizeSummaryFormat(options?.summary_format);
      const wantLog = this.parseBoolean(options?.log);
      const clean = options?.clean === undefined ? true : this.parseBoolean(options?.clean);
      const wordLimit = this.parseWordLimit(options?.word_limit);
      const asyncMode = options?.async === undefined ? true : this.parseBoolean(options?.async);

      if (startStep === 1) {
        if (!url) return res.status(400).json({ error: "Missing url" });
        if (!this.isValidVkMask(url)) return res.status(400).json({ error: "VK-only: unsupported url" });
      }

      if (startStep > 1 && !payload?.inputFile) {
        return res.status(400).json({ error: "Missing input file" });
      }

      const job = this.createJob({ url, providerId, wantLog });
      const seededInputs = await this.prepareSeededInputs(job.id, startStep, payload?.inputFile);

      if (asyncMode) {
        this.jobStore.set(job);
        (async () => {
          try {
            const { summary } = await this.pipelineService.run({
              url,
              providerId,
              summaryFormat,
              wantLog,
              clean,
              wordLimit,
              job,
              startFromStep: startStep,
              seededInputs,
            });
            job.summary = summary;
            await this.finalizeJobAndAudit(job, "done");
          } catch (e) {
            await this.finalizeJobAndAudit(job, "error", e?.message || "Pipeline failed");
          }
        })();
        return res.json({ job_id: job.id, status: "running" });
      }

      const { summary } = await this.pipelineService.run({
        url,
        providerId,
        summaryFormat,
        wantLog,
        clean,
        wordLimit,
        job,
        startFromStep: startStep,
        seededInputs,
      });
      job.summary = summary;
      await this.finalizeJobAndAudit(job, "done");
      return res.json({
        summary: job.summary,
        log: wantLog ? job.log : "",
        steps: job.steps,
        warnings: job.warnings,
        step_durations_ms: job.stepDurationsMs,
      });
    } catch (e) {
      return res.status(500).json({ error: e?.message || "Pipeline failed" });
    }
  }

  createJob({ url, providerId, wantLog }) {
    return {
      id: crypto.randomUUID(),
      url,
      providerId,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps: -1,
      warnings: [],
      stepDurationsMs: [null, null, null, null],
      currentStepStartedAt: null,
      log: "",
      summary: "",
      error: "",
      wantLog,
      tokensSnapshot: this.envService.snapshotTokens(),
    };
  }

  async finalizeJobAndAudit(job, status, errorText = "") {
    job.status = status;
    job.error = errorText;
    job.finishedAt = new Date().toISOString();
    job.currentStepStartedAt = null;
    await this.auditLogger.append(this.auditLogger.buildRecord(job));
  }

  normalizeStartStep(value) {
    const n = Number.parseInt(String(value ?? "1"), 10);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(4, n));
  }

  parseBoolean(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      return v === "1" || v === "true" || v === "yes";
    }
    return false;
  }

  parseWordLimit(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n)) return null;
    return n;
  }

  async parseStartPayload(req) {
    const contentType = String(req.headers?.["content-type"] || "").toLowerCase();
    if (contentType.includes("multipart/form-data")) {
      const request = new Request(`http://localhost${req.originalUrl || req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req,
        duplex: "half",
      });
      const form = await request.formData();
      const optionsRaw = form.get("options");
      let options = {};
      if (typeof optionsRaw === "string" && optionsRaw.trim()) {
        try {
          options = JSON.parse(optionsRaw);
        } catch {
          options = {};
        }
      }
      const inputFile = form.get("input_file");
      return {
        url: typeof form.get("url") === "string" ? form.get("url") : "",
        start_step: typeof form.get("start_step") === "string" ? form.get("start_step") : "1",
        options,
        inputFile: inputFile && typeof inputFile.arrayBuffer === "function" ? inputFile : null,
      };
    }

    const body = req.body || {};
    return {
      url: body.url || "",
      start_step: body.start_step || body.startStep || 1,
      options: body.options || {},
      inputFile: null,
    };
  }

  async prepareSeededInputs(jobId, startStep, inputFile) {
    if (!inputFile || startStep <= 1) return {};
    const jobDir = path.join(this.pipelineService.workRoot, jobId);
    await fs.mkdir(jobDir, { recursive: true });
    const originalName = String(inputFile.name || "").toLowerCase();

    if (startStep === 2 && !originalName.endsWith(".wav")) {
      throw new Error("Для шага 2 требуется файл .wav");
    }
    if ((startStep === 3 || startStep === 4) && !originalName.endsWith(".txt")) {
      throw new Error("Для шага 3 и 4 требуется файл .txt");
    }

    const targetName = startStep === 2 ? "audio.wav" : startStep === 3 ? "transcript.txt" : "summary_source.txt";
    const targetPath = path.join(jobDir, targetName);
    const bytes = new Uint8Array(await inputFile.arrayBuffer());
    await fs.writeFile(targetPath, bytes);

    if (startStep === 2) return { wavPath: targetPath };
    if (startStep === 3) return { transcriptPath: targetPath };
    return { summaryTextPath: targetPath };
  }
}
