import path from "node:path";

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

  get auditLogKeepLast() {
    const parsed = Number.parseInt(this.env.AUDIT_LOG_KEEP_LAST || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  get workResultsKeepLast() {
    const parsed = Number.parseInt(this.env.WORK_RESULTS_KEEP_LAST || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  }

  get ytdlpBin() {
    return this.env.YTDLP_BIN || "yt-dlp";
  }

  get ffmpegBin() {
    return this.env.FFMPEG_BIN || "ffmpeg";
  }

  get ytdlpJsRuntimes() {
    return this.env.YTDLP_JS_RUNTIMES || "node deno";
  }

  get ytdlpRemoteComponents() {
    return this.env.YTDLP_REMOTE_COMPONENTS || "ejs:github";
  }

  get ytdlpYoutubeExtractorArgs() {
    return this.env.YTDLP_YOUTUBE_EXTRACTOR_ARGS || "player_client=android,web";
  }

  get ytdlpYoutubePoToken() {
    return this.env.YTDLP_YOUTUBE_PO_TOKEN || "";
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
