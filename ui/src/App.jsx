import React, { useMemo, useState } from "react";

/**
 * MVP (VK-only)
 * UI вызывает backend endpoint, который выполняет пайплайн:
 * 1) download mp4
 * 2) ffmpeg -> wav
 * 3) WhisperX + diarization -> txt
 * 4) split_whisperx.py -> чанки
 * 5) ChatGPT -> краткий пересказ
 */

function detectHosting(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    const host = url.hostname.toLowerCase();

    const isVK =
      host === "vk.com" || host.endsWith(".vk.com") || host === "vkvideo.ru" || host.endsWith(".vkvideo.ru");

    if (isVK) return "vk";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function isValidVkMask(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    const host = url.hostname.toLowerCase();

    if (host === "vk.com" || host.endsWith(".vk.com")) {
      // https://vk.com/{sometext}?z=video-{somenumber}
      if (!url.pathname || url.pathname === "/") return false;
      if (!url.searchParams.has("z")) return false;
      const z = url.searchParams.get("z") || "";
      return /^video-\d+(_\d+)?$/.test(z);
    }

    if (host === "vkvideo.ru" || host.endsWith(".vkvideo.ru")) {
      // https://vkvideo.ru/video-{somenumber}
      return /^\/video-\d+(_\d+)?$/.test(url.pathname || "");
    }

    return false;
  } catch {
    return false;
  }
}

function clampInt(value, min, max) {
  const n = Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) return null;
  return Math.min(max, Math.max(min, n));
}

async function postJson(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

const STEP_LABELS = [
  "Скачивание видео (mp4)",
  "Извлечение аудио (ffmpeg → wav)",
  "Транскрипция (WhisperX + diarization → txt)",
  "Разбиение на чанки (split_whisperx.py)",
  "Краткий пересказ (ChatGPT)",
];

export default function App() {
  const [url, setUrl] = useState("");
  const hosting = useMemo(() => detectHosting(url), [url]);
  const isLinkValid = useMemo(() => url.trim().length > 0 && hosting === "vk" && isValidVkMask(url), [url, hosting]);

  const [mode, setMode] = useState("summary"); // summary

  // Опции пересказа
  const [useDefaults, setUseDefaults] = useState(true);
  const [wordLimitEnabled, setWordLimitEnabled] = useState(false);
  const [wordLimit, setWordLimit] = useState("20000");
  const [cleanFiller, setCleanFiller] = useState(true);
  const [showLog, setShowLog] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [resultText, setResultText] = useState("");
  const [pipelineLog, setPipelineLog] = useState("");
  const [stepIndex, setStepIndex] = useState(-1);
  const [abortCtrl, setAbortCtrl] = useState(null);
  const [error, setError] = useState("");

  const canRun = url.trim().length > 0 && mode === "summary" && hosting === "vk";

  function applyDefaultsOnToggle(nextUseDefaults) {
    setUseDefaults(nextUseDefaults);
    if (nextUseDefaults) {
      setWordLimitEnabled(false);
      setWordLimit("20000");
      setCleanFiller(true);
      setShowLog(false);
    }
  }

  async function onRun() {
    setError("");
    setResultText("");
    setPipelineLog("");
    setStepIndex(-1);

    const trimmed = url.trim();
    if (!trimmed) {
      setError("Введите ссылку на VK видео.");
      return;
    }

    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
    } catch {
      setError(
        "Ссылка выглядит некорректно. Примеры: https://vk.com/abc?z=video-123456 или https://vkvideo.ru/video-123456"
      );
      return;
    }

    if (!isValidVkMask(trimmed)) {
      setError(
        "Ссылка не подходит под маску. Нужны форматы: https://vk.com/{sometext}?z=video-{number} или https://vkvideo.ru/video-{number}"
      );
      return;
    }

    const wl = wordLimitEnabled ? clampInt(wordLimit, 100, 200000) : null;
    if (wordLimitEnabled && wl === null) {
      setError("Лимит слов должен быть целым числом.");
      return;
    }

    const ctrl = new AbortController();
    setAbortCtrl(ctrl);

    setIsRunning(true);
    try {
      setStepIndex(0);
      const json = await postJson(
        "/api/vk/summary",
        {
          url: trimmed,
          options: {
            word_limit: wl, // null => default
            clean: cleanFiller,
            log: showLog,
          },
        },
        ctrl.signal
      );

      if (typeof json?.steps === "number") setStepIndex(Math.min(STEP_LABELS.length - 1, json.steps));
      else setStepIndex(STEP_LABELS.length - 1);

      setResultText(json?.summary || "");
      setPipelineLog(json?.log || "");

      if (!json?.summary) {
        setError("Backend не вернул пересказ.");
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        setError("Операция отменена.");
      } else {
        setError(e?.message || "Не удалось выполнить пересказ.");
      }
    } finally {
      setIsRunning(false);
      setAbortCtrl(null);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-3xl p-6">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Summarizer</h1>
        </header>

        <section className="rounded-2xl bg-white shadow-sm ring-1 ring-neutral-200 p-5">
          <div className="grid gap-4">
            <div>
              <label className="text-sm font-medium">Ссылка на видео</label>
              <div className="mt-2 flex gap-2">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-300"
                />
                <div className="shrink-0 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
                  <span className="text-neutral-500">Ссылка:</span>{" "}
                  <span
                    className={`font-medium ${
                      !url.trim() ? "text-neutral-400" : isLinkValid ? "text-emerald-600" : "text-red-600"
                    }`}
                  >
                    {!url.trim() ? "—" : isLinkValid ? "верная" : "не подходит"}
                  </span>
                </div>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">Что сделать</label>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setMode("summary")}
                  className={`rounded-xl px-3 py-2 text-sm ring-1 ${
                    mode === "summary"
                      ? "bg-neutral-900 text-white ring-neutral-900"
                      : "bg-white text-neutral-900 ring-neutral-200 hover:bg-neutral-50"
                  }`}
                >
                  Краткий пересказ
                </button>
                <button
                  type="button"
                  disabled
                  className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 bg-neutral-50 text-neutral-400 cursor-not-allowed"
                >
                  Shorts (позже)
                </button>
                <button
                  type="button"
                  disabled
                  className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 bg-neutral-50 text-neutral-400 cursor-not-allowed"
                >
                  Highlight (позже)
                </button>
              </div>
              <p className="mt-2 text-sm text-neutral-600">Сейчас поддерживается только VK и только «краткий пересказ».</p>
            </div>

            {mode === "summary" && (
              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Опции пересказа</div>
                    <div className="text-xs text-neutral-600">По умолчанию используются безопасные настройки.</div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={useDefaults}
                      onChange={(e) => applyDefaultsOnToggle(e.target.checked)}
                      className="h-4 w-4"
                    />
                    Дефолт
                  </label>
                </div>

                <div className={`mt-4 grid gap-3 ${useDefaults ? "opacity-60" : ""}`}>
                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Задать лимит слов</span>
                    <input
                      type="checkbox"
                      disabled={useDefaults}
                      checked={wordLimitEnabled}
                      onChange={(e) => setWordLimitEnabled(e.target.checked)}
                      className="h-4 w-4"
                    />
                  </label>

                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={100}
                      max={200000}
                      disabled={useDefaults || !wordLimitEnabled}
                      value={wordLimit}
                      onChange={(e) => setWordLimit(e.target.value)}
                      className="w-40 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-300 disabled:bg-neutral-50"
                    />
                    <div className="text-xs text-neutral-600">Диапазон: 100–200000</div>
                  </div>

                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Чистить от мусорных слов</span>
                    <input
                      type="checkbox"
                      disabled={useDefaults}
                      checked={cleanFiller}
                      onChange={(e) => setCleanFiller(e.target.checked)}
                      className="h-4 w-4"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Выводить лог</span>
                    <input
                      type="checkbox"
                      disabled={useDefaults}
                      checked={showLog}
                      onChange={(e) => setShowLog(e.target.checked)}
                      className="h-4 w-4"
                    />
                  </label>

                  {useDefaults && <div className="text-xs text-neutral-600">Чтобы менять опции, выключите «Дефолт».</div>}
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onRun}
                disabled={!canRun || isRunning}
                className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {isRunning ? "Выполняю…" : "Сделать пересказ"}
              </button>

              {isRunning && (
                <button
                  type="button"
                  onClick={() => abortCtrl?.abort()}
                  className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 hover:bg-neutral-50"
                >
                  Отменить
                </button>
              )}

              <div className="text-xs text-neutral-600">
                UI вызывает <span className="font-mono">POST /api/vk/summary</span>.
              </div>
            </div>

            <div className="rounded-2xl border border-neutral-200 p-4">
              <div className="text-sm font-medium">Пайплайн</div>
              <ol className="mt-2 grid gap-2">
                {STEP_LABELS.map((label, i) => {
                  const state =
                    stepIndex < 0 ? "idle" : i < stepIndex ? "done" : i === stepIndex ? "active" : "todo";
                  return (
                    <li key={label} className="flex items-center justify-between gap-3 text-sm">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ring-1 ${
                            state === "done"
                              ? "bg-neutral-900 text-white ring-neutral-900"
                              : state === "active"
                              ? "bg-neutral-100 text-neutral-900 ring-neutral-300"
                              : "bg-white text-neutral-400 ring-neutral-200"
                          }`}
                        >
                          {i + 1}
                        </span>
                        <span className={state === "todo" ? "text-neutral-400" : "text-neutral-900"}>{label}</span>
                      </div>
                      <span className="text-xs text-neutral-500">
                        {state === "done" ? "готово" : state === "active" ? (isRunning ? "в работе" : "") : ""}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-3 text-xs text-neutral-600">Реальный прогресс возможен, если backend возвращает steps/log.</div>
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-2xl bg-white shadow-sm ring-1 ring-neutral-200 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Результат</h2>
            {resultText && (
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(resultText)}
                className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 hover:bg-neutral-50"
              >
                Копировать
              </button>
            )}
          </div>

          {!resultText ? (
            <p className="mt-3 text-sm text-neutral-600">Пока пусто. Введите VK-ссылку и нажмите «Сделать пересказ».</p>
          ) : (
            <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-neutral-50 p-4 text-sm leading-relaxed ring-1 ring-neutral-200">
              {resultText}
            </pre>
          )}

          {showLog && (
            <div className="mt-5">
              <div className="text-sm font-semibold">Лог</div>
              {!pipelineLog ? (
                <p className="mt-2 text-sm text-neutral-600">Лог пустой (backend может не возвращать его в MVP).</p>
              ) : (
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-neutral-50 p-4 text-xs leading-relaxed ring-1 ring-neutral-200">
                  {pipelineLog}
                </pre>
              )}
            </div>
          )}
        </section>

        <footer className="mt-6 text-xs text-neutral-500">
          VK-only MVP. Для работы backend нужны: yt-dlp, ffmpeg, python + whisperx, HF_TOKEN, OPENAI_API_KEY.
        </footer>
      </div>
    </div>
  );
}
