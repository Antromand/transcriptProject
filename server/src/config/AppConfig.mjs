import path from "node:path";

// Централизованный конфиг приложения.
// В одном месте собираем все пути/порты/бинарники из env с дефолтами.
export class AppConfig {
  constructor({ env = process.env, cwd = process.cwd() } = {}) {
    this.env = env;
    this.cwd = cwd;
  }

  get port() {
    return this.env.PORT ? Number(this.env.PORT) : 3000;
  }

  get workRoot() {
    return this.env.WORK_ROOT || path.join(this.cwd, "work");
  }

  get uiDist() {
    return this.env.UI_DIST || path.join(this.cwd, "ui", "dist");
  }

  get auditLogPath() {
    return this.env.AUDIT_LOG_PATH || path.join(this.workRoot, "audit", "audit-log.jsonl");
  }

  get ytdlpBin() {
    return this.env.YTDLP_BIN || "yt-dlp";
  }

  get pythonBin() {
    return this.env.PYTHON_BIN || "python";
  }

  get whisperxScriptPath() {
    const script = this.env.WHISPERX_SCRIPT || "run_whisperx.py";
    return path.isAbsolute(script) ? script : path.join(this.cwd, script);
  }

  get splitScriptPath() {
    const script = this.env.SPLIT_SCRIPT || "split_whisperx.py";
    return path.isAbsolute(script) ? script : path.join(this.cwd, script);
  }
}
