import React, { useEffect, useMemo, useState } from "react";
import { isValidVkMask } from "./vkUrlRules";

/**
 * MVP (VK-only)
 * UI вызывает backend endpoint, который выполняет пайплайн:
 * 1) download mp4
 * 2) ffmpeg -> wav
 * 3) WhisperX + diarization -> txt
 * 4) split_whisperx.py -> чанки
 * 5) ChatGPT -> краткий пересказ
 */

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
    const err = new Error(msg);
    err.data = json;
    throw err;
  }
  return json;
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.data = json;
    throw err;
  }
  return json;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const BASE_STEP_LABELS = [
  "Скачивание аудио (yt-dlp → wav)",
  "Транскрипция (WhisperX + diarization → txt)",
  "Разбиение на чанки (split_whisperx.py)",
];

const LLM_OPTIONS = [
  {
    id: "openai",
    label: "ChatGPT",
    keyName: "OPENAI_API_KEY",
    keyStatusField: "openai_api_key_set",
    placeholder: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHelp: "Получить API-ключ: OpenAI Platform -> API keys.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keyName: "DEEPSEEK_API_KEY",
    keyStatusField: "deepseek_api_key_set",
    placeholder: "sk-...",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyHelp: "Получить API-ключ: DeepSeek Platform -> API Keys.",
  },
  {
    id: "grok",
    label: "Grok",
    keyName: "GROK_API_KEY",
    keyStatusField: "grok_api_key_set",
    placeholder: "xai-...",
    keyUrl: "https://console.x.ai/",
    keyHelp: "Получить API-ключ: xAI Console -> API keys.",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    keyName: "GEMINI_API_KEY",
    keyStatusField: "gemini_api_key_set",
    placeholder: "AIza...",
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyHelp: "Получить API-ключ: Google AI Studio -> API keys.",
  },
  {
    id: "yandexgpt",
    label: "YandexGPT",
    keyName: "YANDEXGPT_API_KEY",
    keyStatusField: "yandexgpt_api_key_set",
    placeholder: "AQVN...",
    keyUrl: "https://oauth.yandex.ru/",
    keyHelp: "Для 300.ya.ru используйте OAuth-токен Яндекса (формат AQVN...).",
  },
];

function buildStepLabels(providerId) {
  const provider = LLM_OPTIONS.find((p) => p.id === providerId);
  const llmLabel = provider?.label || "LLM";
  return [...BASE_STEP_LABELS, `Краткий пересказ (${llmLabel})`];
}

export default function App() {
  const [url, setUrl] = useState("");
  const isLinkValid = useMemo(() => url.trim().length > 0 && isValidVkMask(url), [url]);

  const [mode, setMode] = useState("summary"); // summary
  const [llmProvider, setLlmProvider] = useState("openai");

  // Опции пересказа
  const [useDefaults, setUseDefaults] = useState(true);
  const [wordLimitEnabled, setWordLimitEnabled] = useState(false);
  const [wordLimit, setWordLimit] = useState("20000");
  const [cleanFiller, setCleanFiller] = useState(true);
  const [showLog, setShowLog] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [resultText, setResultText] = useState("");
  const [pipelineLog, setPipelineLog] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [stepIndex, setStepIndex] = useState(-1);
  const [stepDurationsMs, setStepDurationsMs] = useState([]);
  const [activeStepStartedAt, setActiveStepStartedAt] = useState(null);
  const [activeStepElapsedMs, setActiveStepElapsedMs] = useState(0);
  const [abortCtrl, setAbortCtrl] = useState(null);
  const [error, setError] = useState("");
  const [llmKeys, setLlmKeys] = useState({
    openai: "",
    deepseek: "",
    grok: "",
    gemini: "",
    yandexgpt: "",
  });
  const [hfToken, setHfToken] = useState("");
  const [envStatus, setEnvStatus] = useState({
    openai_api_key_set: false,
    deepseek_api_key_set: false,
    grok_api_key_set: false,
    gemini_api_key_set: false,
    yandexgpt_api_key_set: false,
    hf_token_set: false,
  });
  const [toasts, setToasts] = useState([]);
  const [envBusy, setEnvBusy] = useState(false);
  const [showLlmKey, setShowLlmKey] = useState(false);
  const stepLabels = useMemo(() => buildStepLabels(llmProvider), [llmProvider]);
  const selectedProvider = useMemo(
    () => LLM_OPTIONS.find((p) => p.id === llmProvider) || LLM_OPTIONS[0],
    [llmProvider]
  );

  const canRun = url.trim().length > 0 && mode === "summary" && isLinkValid;

  useEffect(() => {
    syncEnvStatus().catch(() => {});
  }, []);

  useEffect(() => {
    if (!isRunning || activeStepStartedAt === null) return undefined;
    const timer = setInterval(() => {
      setActiveStepElapsedMs(Date.now() - activeStepStartedAt);
    }, 200);
    return () => clearInterval(timer);
  }, [isRunning, activeStepStartedAt]);

  useEffect(() => {
    if (!isRunning || stepIndex < 0) return;
    setActiveStepStartedAt(Date.now());
    setActiveStepElapsedMs(0);
  }, [isRunning, stepIndex]);

  function pushToast(message, tone = "info") {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }

  function pushStatusToast(prefix, isSet) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, tone: "info", prefix, isSet }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }

  async function syncEnvStatus() {
    const data = await getJson("/api/env/status");
    const nextStatus = {
      openai_api_key_set: Boolean(data?.openai_api_key_set),
      deepseek_api_key_set: Boolean(data?.deepseek_api_key_set),
      grok_api_key_set: Boolean(data?.grok_api_key_set),
      gemini_api_key_set: Boolean(data?.gemini_api_key_set),
      yandexgpt_api_key_set: Boolean(data?.yandexgpt_api_key_set),
      hf_token_set: Boolean(data?.hf_token_set),
    };
    setEnvStatus(nextStatus);
    return nextStatus;
  }

  async function onCheckLlmStatus() {
    setEnvBusy(true);
    try {
      const nextStatus = await syncEnvStatus();
      const isSet = Boolean(nextStatus[selectedProvider.keyStatusField]);
      pushStatusToast(`API-ключ для ${selectedProvider.label} `, isSet);
    } catch (e) {
      pushToast(e?.message || "Не удалось проверить переменные.", "error");
    } finally {
      setEnvBusy(false);
    }
  }

  async function onCheckHFStatus() {
    setEnvBusy(true);
    try {
      const nextStatus = await syncEnvStatus();
      pushStatusToast("HF_TOKEN ", Boolean(nextStatus.hf_token_set));
    } catch (e) {
      pushToast(e?.message || "Не удалось проверить переменные.", "error");
    } finally {
      setEnvBusy(false);
    }
  }

  async function onSetLlmKey() {
    setEnvBusy(true);
    try {
      const keyFieldByProvider = {
        openai: "openai_api_key",
        deepseek: "deepseek_api_key",
        grok: "grok_api_key",
        gemini: "gemini_api_key",
        yandexgpt: "yandexgpt_api_key",
      };
      const field = keyFieldByProvider[llmProvider] || "openai_api_key";
      const keyValue = llmKeys[llmProvider] || "";
      const data = await postJson("/api/env/set", { [field]: keyValue });
      setEnvStatus({
        openai_api_key_set: Boolean(data?.openai_api_key_set),
        deepseek_api_key_set: Boolean(data?.deepseek_api_key_set),
        grok_api_key_set: Boolean(data?.grok_api_key_set),
        yandexgpt_api_key_set: Boolean(data?.yandexgpt_api_key_set),
        hf_token_set: Boolean(data?.hf_token_set),
      });
      const isSet = Boolean(data?.[selectedProvider.keyStatusField]);
      pushToast(
        isSet ? `${selectedProvider.keyName} сохранен в серверном процессе.` : `${selectedProvider.keyName} очищен.`,
        "success"
      );
    } catch (e) {
      pushToast(e?.message || `Не удалось сохранить ${selectedProvider.keyName}.`, "error");
    } finally {
      setEnvBusy(false);
    }
  }

  async function onSetHF() {
    setEnvBusy(true);
    try {
      const data = await postJson("/api/env/set", { hf_token: hfToken });
      setEnvStatus({
        openai_api_key_set: Boolean(data?.openai_api_key_set),
        deepseek_api_key_set: Boolean(data?.deepseek_api_key_set),
        grok_api_key_set: Boolean(data?.grok_api_key_set),
        yandexgpt_api_key_set: Boolean(data?.yandexgpt_api_key_set),
        hf_token_set: Boolean(data?.hf_token_set),
      });
      pushToast(data?.hf_token_set ? "HF_TOKEN сохранен в серверном процессе." : "HF_TOKEN очищен.", "success");
    } catch (e) {
      pushToast(e?.message || "Не удалось сохранить HF_TOKEN.", "error");
    } finally {
      setEnvBusy(false);
    }
  }

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
    setWarnings([]);
    setStepIndex(-1);
    setStepDurationsMs([]);
    setActiveStepStartedAt(null);
    setActiveStepElapsedMs(0);

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
      setActiveStepStartedAt(Date.now());
      setActiveStepElapsedMs(0);
      const startJson = await postJson(
        "/api/vk/summary",
        {
          url: trimmed,
          options: {
            llm_provider: llmProvider,
            word_limit: wl, // null => default
            clean: cleanFiller,
            log: showLog,
            async: true,
          },
        },
        ctrl.signal
      );

      if (startJson?.job_id) {
        while (true) {
          await delay(700, ctrl.signal);
          const statusJson = await getJson(`/api/vk/summary/status/${startJson.job_id}`, ctrl.signal);

          if (typeof statusJson?.steps === "number") setStepIndex(Math.min(stepLabels.length - 1, statusJson.steps));
          setWarnings(Array.isArray(statusJson?.warnings) ? statusJson.warnings : []);
          setStepDurationsMs(Array.isArray(statusJson?.step_durations_ms) ? statusJson.step_durations_ms : []);
          if (showLog) setPipelineLog(statusJson?.log || "");

          if (statusJson?.status === "done") {
            setStepIndex(stepLabels.length);
            setActiveStepStartedAt(null);
            setResultText(statusJson?.summary || "");
            if (!statusJson?.summary) setError("Backend не вернул пересказ.");
            break;
          }
          if (statusJson?.status === "error") {
            setActiveStepStartedAt(null);
            setError(statusJson?.error || "Не удалось выполнить пересказ.");
            break;
          }
        }
      } else {
        if (typeof startJson?.steps === "number") setStepIndex(Math.min(stepLabels.length, startJson.steps + 1));
        else setStepIndex(stepLabels.length);
        setActiveStepStartedAt(null);
        setResultText(startJson?.summary || "");
        setPipelineLog(startJson?.log || "");
        setWarnings(Array.isArray(startJson?.warnings) ? startJson.warnings : []);
        setStepDurationsMs(Array.isArray(startJson?.step_durations_ms) ? startJson.step_durations_ms : []);
        if (!startJson?.summary) {
          setError("Backend не вернул пересказ.");
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        setError("Операция отменена.");
      } else {
        setWarnings(Array.isArray(e?.data?.warnings) ? e.data.warnings : []);
        setStepDurationsMs(Array.isArray(e?.data?.step_durations_ms) ? e.data.step_durations_ms : []);
        setError(e?.message || "Не удалось выполнить пересказ.");
      }
    } finally {
      setIsRunning(false);
      setActiveStepStartedAt(null);
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

            <div className="rounded-2xl border border-neutral-200 p-4">
              <div className="text-sm font-medium">Переменные окружения</div>
              <div className="mt-1 text-xs text-neutral-600">
                Значения задаются для текущего процесса сервера. После перезапуска задайте снова или вынесите в системные env.
              </div>

              <div className="mt-4 grid gap-3">
                <label className="text-sm font-medium">LLM провайдер</label>
                <select
                  value={llmProvider}
                  onChange={(e) => setLlmProvider(e.target.value)}
                  className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-300"
                >
                  {LLM_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <label className="text-sm font-medium">{selectedProvider.keyName}</label>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-full">
                    <input
                      type={showLlmKey ? "text" : "password"}
                      value={llmKeys[llmProvider] || ""}
                      onChange={(e) =>
                        setLlmKeys((prev) => ({
                          ...prev,
                          [llmProvider]: e.target.value,
                        }))
                      }
                      placeholder={selectedProvider.placeholder}
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 pr-10 text-sm outline-none focus:ring-2 focus:ring-neutral-300"
                    />
                    <button
                      type="button"
                      onClick={() => setShowLlmKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-neutral-500 hover:text-neutral-900"
                      aria-label={showLlmKey ? "Скрыть ключ" : "Показать ключ"}
                      title={showLlmKey ? "Скрыть" : "Показать"}
                    >
                      {showLlmKey ? (
                        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 3l18 18" />
                          <path d="M10.6 10.6a2 2 0 102.8 2.8" />
                          <path d="M9.5 5.2A11 11 0 0112 5c5 0 9 4.5 10 7-0.4 1-1.3 2.3-2.5 3.5" />
                          <path d="M6.7 6.7C4.8 8 3.4 9.7 2 12c1 2.5 5 7 10 7 2.3 0 4.3-.9 6-2.3" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={onCheckLlmStatus}
                    disabled={envBusy}
                    className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Проверить наличие
                  </button>
                  <button
                    type="button"
                    onClick={onSetLlmKey}
                    disabled={envBusy}
                    className="rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Сохранить
                  </button>
                </div>
                <div className="text-xs text-neutral-600">
                  {selectedProvider.keyHelp}{" "}
                  <a
                    href={selectedProvider.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-neutral-900 underline"
                  >
                    Открыть
                  </a>
                </div>
              </div>

              <div className="mt-4 grid gap-3">
                <label className="text-sm font-medium">HF_TOKEN</label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    value={hfToken}
                    onChange={(e) => setHfToken(e.target.value)}
                    placeholder="hf_..."
                    className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-300"
                  />
                  <button
                    type="button"
                    onClick={onCheckHFStatus}
                    disabled={envBusy}
                    className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Проверить наличие
                  </button>
                  <button
                    type="button"
                    onClick={onSetHF}
                    disabled={envBusy}
                    className="rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Сохранить
                  </button>
                </div>
              </div>

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
            {warnings.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {warnings.map((w, i) => (
                  <div key={`${w}-${i}`}>{w}</div>
                ))}
              </div>
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
                {stepLabels.map((label, i) => {
                  const state =
                    stepIndex < 0 ? "idle" : i < stepIndex ? "done" : i === stepIndex ? "active" : "todo";
                  const durationMs = Number(stepDurationsMs?.[i]);
                  const hasDuration = Number.isFinite(durationMs) && durationMs >= 0;
                  const durationText = hasDuration ? `${(durationMs / 1000).toFixed(1)}с` : "";
                  const liveDurationText = `${(activeStepElapsedMs / 1000).toFixed(1)}с`;
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
                        {state === "done"
                          ? hasDuration
                            ? `готово • ${durationText}`
                            : "готово"
                          : state === "active"
                          ? isRunning
                            ? `в работе • ${liveDurationText}`
                            : hasDuration
                            ? durationText
                            : ""
                          : ""}
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
          VK-only MVP. Для работы backend нужны: yt-dlp, ffmpeg, python + whisperx, HF_TOKEN и ключ выбранного LLM.
        </footer>
      </div>

      <div className="fixed bottom-4 right-4 z-50 flex w-96 max-w-full flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-xl px-3 py-2 text-sm shadow-sm ring-1 ${
              t.tone === "error"
                ? "border border-red-200 bg-red-50 text-red-800 ring-red-200"
                : t.tone === "success"
                ? "border border-emerald-200 bg-emerald-50 text-emerald-800 ring-emerald-200"
                : "border border-neutral-200 bg-white text-neutral-900 ring-neutral-200"
            }`}
          >
            {typeof t.isSet === "boolean" ? (
              <>
                {t.prefix}
                <span className={t.isSet ? "font-semibold text-emerald-700" : "font-semibold text-red-700"}>
                  {t.isSet ? "задан" : "не задан"}
                </span>
              </>
            ) : (
              t.message
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

