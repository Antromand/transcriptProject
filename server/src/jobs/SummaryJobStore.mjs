export class SummaryJobStore {
  constructor({ ttlMs = 30 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.jobs = new Map();
  }

  set(job) {
    // Храним job ограниченное время, чтобы не раздувать память.
    this.jobs.set(job.id, job);
    const timer = setTimeout(() => this.jobs.delete(job.id), this.ttlMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  get(jobId) {
    return this.jobs.get(jobId);
  }

  serialize(job) {
    // Отдаем только данные, нужные UI для прогресса и финального результата.
    const currentElapsed =
      job.status === "running" && Number.isFinite(job.currentStepStartedAt)
        ? Date.now() - job.currentStepStartedAt
        : null;
    return {
      job_id: job.id,
      status: job.status,
      steps: job.steps,
      current_step_progress_pct: Number.isFinite(job.currentStepProgress?.percent) ? job.currentStepProgress.percent : null,
      current_step_progress_label: job.currentStepProgress?.label || "",
      warnings: job.warnings,
      step_durations_ms: job.stepDurationsMs,
      current_step_elapsed_ms: currentElapsed,
      log: job.wantLog ? job.log : "",
      summary: job.status === "done" ? job.summary : "",
      error: job.status === "error" || job.status === "canceled" ? job.error : "",
    };
  }
}
