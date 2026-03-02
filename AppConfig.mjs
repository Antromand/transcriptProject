import path from "node:path";

// Централизованный конфиг приложения.
// Все переменные читаются из env и имеют безопасные значения по умолчанию.
export class AppConfig {
  constructor({ env = process.env, cwd = process.cwd() } = {}) {
    this.env = env;
    this.cwd = cwd;
  }

  // PORT: порт HTTP-сервера.
  get port() {
    return this.env.PORT ? Number(this.env.PORT) : 3000;
  }

  // WORK_ROOT: корневая папка для рабочих файлов и артефактов пайплайна.
  get workRoot() {
    return this.env.WORK_ROOT || path.join(this.cwd, "work");
  }

  // UI_DIST: папка со сборкой фронтенда для раздачи статики.
  get uiDist() {
    return this.env.UI_DIST || path.join(this.cwd, "ui", "dist");
  }

  // AUDIT_LOG_PATH: базовый путь к файлу аудита (используется для имени/папки monthly-логов).
  get auditLogPath() {
    return this.env.AUDIT_LOG_PATH || path.join(this.workRoot, "audit", "audit-log.jsonl");
  }

  // AUDIT_LOG_KEEP_LAST: сколько последних записей хранить в monthly-аудит логе.
  get auditLogKeepLast() {
    const parsed = Number.parseInt(this.env.AUDIT_LOG_KEEP_LAST || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  }

  // YTDLP_BIN: путь/имя бинарника yt-dlp.
  get ytdlpBin() {
    return this.env.YTDLP_BIN || "yt-dlp";
  }

  // PYTHON_BIN: путь/имя Python-интерпретатора для запуска скриптов.
  get pythonBin() {
    return this.env.PYTHON_BIN || "python";
  }

  // WHISPERX_SCRIPT: путь до скрипта транскрибации (абсолютный или относительно корня проекта).
  get whisperxScriptPath() {
    const script = this.env.WHISPERX_SCRIPT || "run_whisperx.py";
    return path.isAbsolute(script) ? script : path.join(this.cwd, script);
  }

  // SPLIT_SCRIPT: путь до скрипта разбиения текста (абсолютный или относительно корня проекта).
  get splitScriptPath() {
    const script = this.env.SPLIT_SCRIPT || "split_whisperx.py";
    return path.isAbsolute(script) ? script : path.join(this.cwd, script);
  }
}
