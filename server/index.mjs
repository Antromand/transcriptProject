import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { isSupportedVideoUrl } from "../ui/src/vkUrlRules.js";
import { AppConfig } from "../AppConfig.mjs";
import { LLMService } from "./src/llm/LLMService.mjs";
import { SummaryPipelineService } from "./src/pipeline/SummaryPipelineService.mjs";
import { SummaryJobStore } from "./src/jobs/SummaryJobStore.mjs";
import { AuditLogger } from "./src/logging/AuditLogger.mjs";
import { EnvService } from "./src/env/EnvService.mjs";
import { SummaryController } from "./src/controllers/SummaryController.mjs";
import { VideoDownloadController } from "./src/controllers/VideoDownloadController.mjs";
import { PreparedDownloadStore } from "./src/download/PreparedDownloadStore.mjs";

const config = new AppConfig({ env: process.env, cwd: process.cwd() });

const app = express();
app.use(express.json({ limit: "2mb" }));

// Компонуем приложение из сервисов (OOP-композиция вместо монолита).
const envService = new EnvService({ env: process.env, workRoot: config.workRoot });
const llmService = new LLMService({ env: process.env, fetchImpl: fetch });
const pipelineService = new SummaryPipelineService({
  workRoot: config.workRoot,
  ytdlpBin: config.ytdlpBin,
  ffmpegBin: config.ffmpegBin,
  ytdlpJsRuntimes: config.ytdlpJsRuntimes,
  ytdlpRemoteComponents: config.ytdlpRemoteComponents,
  ytdlpYoutubeExtractorArgs: config.ytdlpYoutubeExtractorArgs,
  ytdlpYoutubePoToken: config.ytdlpYoutubePoToken,
  pythonBin: config.pythonBin,
  whisperxScriptPath: config.whisperxScriptPath,
  splitScriptPath: config.splitScriptPath,
  existsSync,
  llmService,
  env: process.env,
});
const jobStore = new SummaryJobStore({ ttlMs: 30 * 60 * 1000 });
const downloadJobStore = new SummaryJobStore({ ttlMs: 30 * 60 * 1000 });
const auditLogger = new AuditLogger({
  workRoot: config.workRoot,
  auditLogPath: config.auditLogPath,
  keepLastRecords: config.auditLogKeepLast,
});
const preparedDownloadStore = new PreparedDownloadStore({
  ttlMs: 20 * 60 * 1000,
  onExpire: async (entry) => {
    await fs.rm(entry.dirPath, { recursive: true, force: true }).catch(() => {});
  },
});
const summaryController = new SummaryController({
  isSupportedVideoUrl,
  llmService,
  pipelineService,
  jobStore,
  auditLogger,
  envService,
  workResultsKeepLast: config.workResultsKeepLast,
});
const videoDownloadController = new VideoDownloadController({
  isSupportedVideoUrl,
  pipelineService,
  preparedDownloadStore,
  jobStore: downloadJobStore,
});

app.get("/api/env/status", (_req, res) => {
  res.json(envService.buildStatusPayload());
});

app.post("/api/env/set", async (req, res) => {
  await envService.applyUpdatesFromBody(req.body || {});
  res.json({ ok: true, ...envService.buildStatusPayload() });
});

app.post("/api/env/reset", async (_req, res) => {
  await envService.clearAllSecrets();
  res.json({ ok: true, ...envService.buildStatusPayload() });
});

app.get("/api/vk/summary/status/:jobId", (req, res) => summaryController.getStatus(req, res));
app.post("/api/vk/summary", (req, res) => summaryController.create(req, res));
app.post("/api/vk/summary/cancel/:jobId", (req, res) => summaryController.cancel(req, res));
app.get("/api/video/summary/status/:jobId", (req, res) => summaryController.getStatus(req, res));
app.post("/api/video/summary", (req, res) => summaryController.create(req, res));
app.post("/api/video/summary/cancel/:jobId", (req, res) => summaryController.cancel(req, res));
app.post("/api/pipeline/summary", (req, res) => summaryController.createFromStart(req, res));
app.post("/api/video/download/formats", (req, res) => videoDownloadController.listFormats(req, res));
app.post("/api/video/download/start", (req, res) => videoDownloadController.start(req, res));
app.get("/api/video/download/status/:jobId", (req, res) => videoDownloadController.getStatus(req, res));
app.post("/api/video/download/prepare", (req, res) => videoDownloadController.prepare(req, res));
app.get("/api/video/download/file/:fileId", (req, res) => videoDownloadController.sendFile(req, res));

if (existsSync(config.uiDist)) {
  app.use(express.static(config.uiDist));
  app.get("*", (_req, res) => res.sendFile(path.join(config.uiDist, "index.html")));
} else {
  app.get("/", (_req, res) => res.send("UI not built. Run `npm run build` or `npm run dev`."));
}

app.listen(config.port, async () => {
  await fs.mkdir(config.workRoot, { recursive: true });
  await envService.init();
  console.log(`Server: http://localhost:${config.port}`);
});
