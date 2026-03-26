import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export class VideoDownloadController {
  constructor({ isSupportedVideoUrl, pipelineService, preparedDownloadStore, jobStore }) {
    this.isSupportedVideoUrl = isSupportedVideoUrl;
    this.pipelineService = pipelineService;
    this.preparedDownloadStore = preparedDownloadStore;
    this.jobStore = jobStore;
  }

  validateUrl(rawUrl) {
    const sourceUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!sourceUrl) throw new Error("Введите ссылку на видео.");

    try {
      // eslint-disable-next-line no-new
      new URL(sourceUrl);
    } catch {
      throw new Error("Ссылка выглядит некорректно.");
    }

    if (!this.isSupportedVideoUrl(sourceUrl)) {
      throw new Error("Поддерживаются ссылки VK, YouTube, Twitch и Kick.");
    }

    return sourceUrl;
  }

  parseHasAudio(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
    }
    return null;
  }

  createJob(sourceUrl) {
    return {
      id: crypto.randomUUID(),
      url: sourceUrl,
      status: "running",
      cancelRequested: false,
      currentProcess: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps: 0,
      warnings: [],
      stepDurationsMs: [null],
      currentStepStartedAt: Date.now(),
      currentStepProgress: { percent: 0, label: "Подготовка скачивания" },
      log: "",
      summary: "",
      error: "",
      wantLog: false,
      title: "",
      fileId: "",
      fileName: "",
      sizeBytes: null,
      downloadUrl: "",
    };
  }

  finalizeJob(job, status, errorText = "") {
    if (Number.isFinite(job.currentStepStartedAt) && !Number.isFinite(job.stepDurationsMs?.[0])) {
      job.stepDurationsMs[0] = Date.now() - job.currentStepStartedAt;
    }
    job.status = status;
    job.error = errorText;
    job.currentProcess = null;
    job.cancelRequested = false;
    job.currentStepStartedAt = null;
    if (status !== "done") job.currentStepProgress = { percent: null, label: "" };
    job.finishedAt = new Date().toISOString();
  }

  getStatus(req, res) {
    const job = this.jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    return res.json(this.jobStore.serialize(job));
  }

  buildUserError(sourceUrl, error) {
    const message = String(error?.message || "").trim();

    if (sourceUrl.includes("kick.com") && (message.includes("403") || message.toLowerCase().includes("impersonation"))) {
      return "Kick вернул 403. В текущей среде у yt-dlp нет доступного impersonation target. Обычно помогает установить curl_cffi в Python-окружение yt-dlp и при необходимости использовать cookies.";
    }

    return message || "Не удалось подготовить видео для скачивания.";
  }

  async listFormats(req, res) {
    try {
      const sourceUrl = this.validateUrl(req.body?.url);
      const result = await this.pipelineService.listDownloadFormats({ url: sourceUrl });
      return res.json({
        ok: true,
        title: result.title,
        formats: result.formats,
        warnings: result.warnings,
      });
    } catch (error) {
      return res.status(400).json({ error: this.buildUserError(String(req.body?.url || ""), error) });
    }
  }

  async start(req, res) {
    try {
      const sourceUrl = this.validateUrl(req.body?.url);
      const formatId = typeof req.body?.format_id === "string" ? req.body.format_id.trim() : "";
      const hasAudio = this.parseHasAudio(req.body?.has_audio);
      const ext = typeof req.body?.ext === "string" ? req.body.ext.trim().toLowerCase() : "";
      const job = this.createJob(sourceUrl);
      const dirPath = path.join(this.pipelineService.workRoot, "downloads", job.id);
      this.jobStore.set(job);

      (async () => {
        try {
          const result = await this.pipelineService.downloadVideo({
            url: sourceUrl,
            formatId,
            hasAudio,
            ext,
            targetDir: dirPath,
            job,
          });

          this.preparedDownloadStore.set({
            id: job.id,
            dirPath,
            filePath: result.filePath,
            fileName: result.fileName,
            title: result.title,
            sizeBytes: result.sizeBytes,
          });

          job.title = result.title;
          job.fileId = job.id;
          job.fileName = result.fileName;
          job.sizeBytes = result.sizeBytes;
          job.downloadUrl = `/api/video/download/file/${job.id}`;
          job.warnings = Array.isArray(result.warnings) ? result.warnings : [];
          this.finalizeJob(job, "done");
        } catch (error) {
          await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
          this.finalizeJob(job, "error", this.buildUserError(sourceUrl, error));
        }
      })();

      return res.json({ ok: true, job_id: job.id, status: "running" });
    } catch (error) {
      return res.status(400).json({ error: this.buildUserError(String(req.body?.url || ""), error) });
    }
  }

  async prepare(req, res) {
    const downloadId = crypto.randomUUID();
    const dirPath = path.join(this.pipelineService.workRoot, "downloads", downloadId);

    try {
      const sourceUrl = this.validateUrl(req.body?.url);
      const formatId = typeof req.body?.format_id === "string" ? req.body.format_id.trim() : "";
      const hasAudio = this.parseHasAudio(req.body?.has_audio);
      const ext = typeof req.body?.ext === "string" ? req.body.ext.trim().toLowerCase() : "";
      const result = await this.pipelineService.downloadVideo({
        url: sourceUrl,
        formatId,
        hasAudio,
        ext,
        targetDir: dirPath,
      });

      this.preparedDownloadStore.set({
        id: downloadId,
        dirPath,
        filePath: result.filePath,
        fileName: result.fileName,
        title: result.title,
        sizeBytes: result.sizeBytes,
      });

      return res.json({
        ok: true,
        file_id: downloadId,
        file_name: result.fileName,
        title: result.title,
        size_bytes: result.sizeBytes,
        warnings: result.warnings,
        download_url: `/api/video/download/file/${downloadId}`,
      });
    } catch (error) {
      await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
      return res.status(500).json({ error: this.buildUserError(String(req.body?.url || ""), error) });
    }
  }

  async sendFile(req, res) {
    const entry = this.preparedDownloadStore.take(req.params.fileId);
    if (!entry) {
      return res.status(404).json({ error: "Файл не найден или уже удален." });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.download(entry.filePath, entry.fileName, async (error) => {
      await this.preparedDownloadStore.dispose(entry).catch(() => {});
      if (error && !res.headersSent) {
        res.status(500).json({ error: "Не удалось отправить файл." });
      }
    });
  }
}
