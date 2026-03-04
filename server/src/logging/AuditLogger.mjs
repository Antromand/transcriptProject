import path from "node:path";
import fs from "node:fs/promises";

const PIPELINE_STEP_NAMES = ["download_audio", "whisperx_transcription", "split_chunks", "llm_summary"];

export class AuditLogger {
  constructor({ workRoot, auditLogPath, keepLastRecords = 0 }) {
    this.workRoot = workRoot;
    this.auditLogPath = auditLogPath || path.join(workRoot, "audit", "audit-log.jsonl");
    this.keepLastRecords = Number.isFinite(keepLastRecords) && keepLastRecords > 0 ? keepLastRecords : 0;
  }

  getMonthlyAuditLogPath(isoDate) {
    // Ротация логов по месяцам: audit-log-YYYY-MM.jsonl
    const date = new Date(isoDate || Date.now());
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const parsed = path.parse(this.auditLogPath);
    const dir = parsed.dir || this.workRoot;
    const baseName = parsed.name || "audit-log";
    return path.join(dir, `${baseName}-${year}-${month}.jsonl`);
  }

  buildRecord(job) {
    // Нормализуем запись аудита в стабильный JSON-формат.
    const failedStepIndex = job.status === "error" ? job.steps : null;
    const failedStepName = Number.isInteger(failedStepIndex) && failedStepIndex >= 0 ? PIPELINE_STEP_NAMES[failedStepIndex] || null : null;
    return {
      job_id: job.id,
      video_url: job.url,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
      success: job.status === "done",
      status: job.status,
      llm_provider: job.providerId,
      tokens: {
        openai_api_key: job.tokensSnapshot?.openai_api_key || "",
        deepseek_api_key: job.tokensSnapshot?.deepseek_api_key || "",
        grok_api_key: job.tokensSnapshot?.grok_api_key || "",
        gemini_api_key: job.tokensSnapshot?.gemini_api_key || "",
        hf_token: job.tokensSnapshot?.hf_token || "",
      },
      failed_step_index: failedStepIndex,
      failed_step_name: failedStepName,
      error_text: job.error || "",
      step_durations_ms: job.stepDurationsMs,
      warnings: job.warnings,
    };
  }

  async append(record) {
    try {
      // JSONL удобен для дешевой append-записи и последующего парсинга.
      const logPath = this.getMonthlyAuditLogPath(record?.finished_at || record?.started_at || new Date().toISOString());
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf-8");
      await this.trimToLastRecords(logPath);
    } catch (e) {
      console.error("Failed to write audit log:", e?.message || e);
    }
  }

  async trimToLastRecords(logPath) {
    if (!this.keepLastRecords || this.keepLastRecords < 1) {
      return;
    }

    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length <= this.keepLastRecords) {
      return;
    }

    const kept = lines.slice(-this.keepLastRecords);
    await fs.writeFile(logPath, `${kept.join("\n")}\n`, "utf-8");
  }
}
