import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";

// Контроллер инкапсулирует HTTP-логику summary:
// валидация, запуск job, финализация, ответы API.
export class SummaryController {
  constructor({ isSupportedVideoUrl, llmService, pipelineService, jobStore, auditLogger, envService, workResultsKeepLast = 20 }) {
    this.isSupportedVideoUrl = isSupportedVideoUrl;
    this.llmService = llmService;
    this.pipelineService = pipelineService;
    this.jobStore = jobStore;
    this.auditLogger = auditLogger;
    this.envService = envService;
    this.workResultsKeepLast = Number.isFinite(workResultsKeepLast) && workResultsKeepLast > 0 ? workResultsKeepLast : 20;
  }

  getStatus(req, res) {
    const job = this.jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    return res.json(this.jobStore.serialize(job));
  }

  cancel(req, res) {
    const job = this.jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "running") return res.json(this.jobStore.serialize(job));
    job.cancelRequested = true;
    job.error = "Остановлено пользователем";
    const proc = job.currentProcess;
    if (proc && typeof proc.kill === "function") {
      try {
        proc.kill();
      } catch {}
    }
    return res.json({ ok: true, status: "canceling", job_id: job.id });
  }

  async create(req, res) {
    const { url, local_path: localPathRaw, localPath: localPathAlt, options } = req.body || {};
    const localPath = typeof localPathRaw === "string" ? localPathRaw.trim() : typeof localPathAlt === "string" ? localPathAlt.trim() : "";
    const sourceUrl = typeof url === "string" ? url.trim() : "";
    const providerId = this.llmService.normalizeProvider(options?.llm_provider);
    const summaryFormat = this.llmService.normalizeSummaryFormat(options?.summary_format);
    const wantLog = !!options?.log;
    const diagnosticsMode = this.parseBoolean(options?.diagnostics);
    const clean = options?.clean ?? true;
    const wordLimit = options?.word_limit ?? null;
    const asyncMode = options?.async === true;

    if (!sourceUrl && !localPath) return res.status(400).json({ error: "Missing source: provide url or local_path" });
    if (sourceUrl && !this.isSupportedVideoUrl(sourceUrl)) return res.status(400).json({ error: "Unsupported video URL" });

    const job = this.createJob({ url: sourceUrl || localPath, providerId, wantLog });

    if (asyncMode) {
      this.jobStore.set(job);
      (async () => {
        try {
          const { summary } = await this.pipelineService.run({
            url: sourceUrl,
            localVideoPath: localPath,
            providerId,
            summaryFormat,
            wantLog,
            diagnosticsMode,
            clean,
            wordLimit,
            job,
          });
          job.summary = summary;
          await this.finalizeJobAndAudit(job, "done");
        } catch (e) {
          if (this.isCancellationError(e, job)) {
            await this.finalizeJobAndAudit(job, "canceled", "Остановлено пользователем");
          } else {
            await this.finalizeJobAndAudit(job, "error", e?.message || "Pipeline failed");
          }
        }
      })();
      return res.json({ job_id: job.id, status: "running" });
    }

    try {
      const { summary } = await this.pipelineService.run({
        url: sourceUrl,
        localVideoPath: localPath,
        providerId,
        summaryFormat,
        wantLog,
        diagnosticsMode,
        clean,
        wordLimit,
        job,
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
      const canceled = this.isCancellationError(e, job);
      await this.finalizeJobAndAudit(job, canceled ? "canceled" : "error", canceled ? "Остановлено пользователем" : e?.message || "Pipeline failed");
      return res.status(canceled ? 200 : 500).json({
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
      const localPath = typeof payload?.local_path === "string" ? payload.local_path.trim() : "";
      const providerId = this.llmService.normalizeProvider(options?.llm_provider);
      const summaryFormat = this.llmService.normalizeSummaryFormat(options?.summary_format);
      const wantLog = this.parseBoolean(options?.log);
      const diagnosticsMode = this.parseBoolean(options?.diagnostics);
      const clean = options?.clean === undefined ? true : this.parseBoolean(options?.clean);
      const wordLimit = this.parseWordLimit(options?.word_limit);
      const asyncMode = options?.async === undefined ? true : this.parseBoolean(options?.async);

      if (startStep === 1) {
        if (!url && !localPath && !payload?.inputFile) {
          return res.status(400).json({ error: "Missing source: provide url, local_path or input_file" });
        }
        if (url && !this.isSupportedVideoUrl(url)) return res.status(400).json({ error: "Unsupported video URL" });
      }

      if (startStep > 1 && !payload?.inputFile) {
        return res.status(400).json({ error: "Missing input file" });
      }

      const sourceLabel = url || localPath || String(payload?.inputFile?.name || "local_upload");
      const job = this.createJob({ url: sourceLabel, providerId, wantLog });
      const seededInputs = await this.prepareSeededInputs(job.id, startStep, payload?.inputFile);
      const effectiveLocalVideoPath = localPath || seededInputs.localVideoPath || "";

      if (asyncMode) {
        this.jobStore.set(job);
        (async () => {
          try {
            const { summary } = await this.pipelineService.run({
              url,
              localVideoPath: effectiveLocalVideoPath,
              providerId,
              summaryFormat,
              wantLog,
              diagnosticsMode,
              clean,
              wordLimit,
              job,
              startFromStep: startStep,
              seededInputs,
            });
            job.summary = summary;
            await this.finalizeJobAndAudit(job, "done");
          } catch (e) {
            if (this.isCancellationError(e, job)) {
              await this.finalizeJobAndAudit(job, "canceled", "Остановлено пользователем");
            } else {
              await this.finalizeJobAndAudit(job, "error", e?.message || "Pipeline failed");
            }
          }
        })();
        return res.json({ job_id: job.id, status: "running" });
      }

      const { summary } = await this.pipelineService.run({
        url,
        localVideoPath: effectiveLocalVideoPath,
        providerId,
        summaryFormat,
        wantLog,
        diagnosticsMode,
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
      cancelRequested: false,
      currentProcess: null,
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
    job.cancelRequested = false;
    job.currentProcess = null;
    job.finishedAt = new Date().toISOString();
    job.currentStepStartedAt = null;
    await this.auditLogger.append(this.auditLogger.buildRecord(job));
    await this.cleanupOldWorkResults();
  }

  async cleanupOldWorkResults() {
    const keepLast = this.workResultsKeepLast;
    if (!keepLast || keepLast < 1) return;
    const root = this.pipelineService?.workRoot;
    if (!root) return;

    const UUID_DIR_MASK = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    let dirs = [];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      dirs = entries.filter((e) => e.isDirectory() && UUID_DIR_MASK.test(e.name)).map((e) => e.name);
    } catch {
      return;
    }

    if (dirs.length <= keepLast) return;

    const withMtime = [];
    for (const name of dirs) {
      const full = path.join(root, name);
      try {
        const st = await fs.stat(full);
        withMtime.push({ full, mtimeMs: st.mtimeMs || 0 });
      } catch {}
    }

    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const stale = withMtime.slice(keepLast);
    for (const item of stale) {
      try {
        await fs.rm(item.full, { recursive: true, force: true });
      } catch {}
    }
  }

  isCancellationError(error, job) {
    if (error?.code === "JOB_CANCELED") return true;
    if (job?.cancelRequested) return true;
    return String(error?.message || "").toLowerCase().includes("canceled by user");
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
        local_path: typeof form.get("local_path") === "string" ? form.get("local_path") : "",
        start_step: typeof form.get("start_step") === "string" ? form.get("start_step") : "1",
        options,
        inputFile: inputFile && typeof inputFile.arrayBuffer === "function" ? inputFile : null,
      };
    }

    const body = req.body || {};
    return {
      url: body.url || "",
      local_path: body.local_path || body.localPath || "",
      start_step: body.start_step || body.startStep || 1,
      options: body.options || {},
      inputFile: null,
    };
  }

  async prepareSeededInputs(jobId, startStep, inputFile) {
    if (!inputFile) return {};
    const jobDir = path.join(this.pipelineService.workRoot, jobId);
    await fs.mkdir(jobDir, { recursive: true });
    const originalName = String(inputFile.name || "").toLowerCase();

    if (startStep === 1) {
      const ext = path.extname(originalName) || ".bin";
      const targetName = `source_input${ext}`;
      const targetPath = path.join(jobDir, targetName);
      const bytes = new Uint8Array(await inputFile.arrayBuffer());
      await fs.writeFile(targetPath, bytes);
      return { localVideoPath: targetPath };
    }

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
