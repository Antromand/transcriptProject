import crypto from "node:crypto";

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
          const { summary } = await this.pipelineService.run({ url, providerId, wantLog, clean, wordLimit, job });
          job.summary = summary;
          await this.finalizeJobAndAudit(job, "done");
        } catch (e) {
          await this.finalizeJobAndAudit(job, "error", e?.message || "Pipeline failed");
        }
      })();
      return res.json({ job_id: job.id, status: "running" });
    }

    try {
      const { summary } = await this.pipelineService.run({ url, providerId, wantLog, clean, wordLimit, job });
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
}
