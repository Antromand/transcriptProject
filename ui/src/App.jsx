import React, { useEffect, useMemo, useRef, useState } from "react";
import { isSupportedVideoUrl } from "./vkUrlRules";

/**
 * MVP (VK/YouTube/Twitch)
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
  "Подготовка аудио (ссылка через yt-dlp или локальный файл через ffmpeg > wav)",
  "Транскрипция (WhisperX + diarization > txt)",
  "Разбиение на чанки (split_whisperx.py)",
];

const START_STEP_INPUT_LABELS = {
  1: "Источник видео",
  2: ".wav файл",
  3: ".txt файл транскрипта",
  4: ".txt файл для пересказа",
};

const ROUTE_STEP_LABELS = [
  "\u0421\u043a\u0430\u0447\u0438\u0432\u0430\u043d\u0438\u0435 \u0430\u0443\u0434\u0438\u043e",
  "\u0422\u0440\u0430\u043d\u0441\u043a\u0440\u0438\u043f\u0446\u0438\u044f",
  "\u0420\u0430\u0437\u0431\u0438\u0435\u043d\u0438\u0435 \u043d\u0430 \u0447\u0430\u043d\u043a\u0438",
  "\u041f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u043a\u0430 \u043f\u0435\u0440\u0435\u0441\u043a\u0430\u0437\u0430",
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
];

const SUMMARY_FORMAT_OPTIONS = [
  { id: "short", label: "Краткий" },
  { id: "medium", label: "Средний" },
  { id: "detailed", label: "Подробный" },
];
const SUMMARY_FORMAT_STORAGE_KEY = "summary_format";
const DIAGNOSTICS_MODE_STORAGE_KEY = "diagnostics_mode";

function normalizeSummaryFormat(value) {
  const id = String(value || "").trim().toLowerCase();
  return SUMMARY_FORMAT_OPTIONS.some((opt) => opt.id === id) ? id : "short";
}

function getSummaryFormatLabel(summaryFormat) {
  return SUMMARY_FORMAT_OPTIONS.find((f) => f.id === summaryFormat)?.label || "Краткий";
}

async function postFormData(url, formData, signal) {
  const res = await fetch(url, {
    method: "POST",
    body: formData,
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

function buildStepLabels(providerId, summaryFormat) {
  const provider = LLM_OPTIONS.find((p) => p.id === providerId);
  const llmLabel = provider?.label || "LLM";
  const summaryLabel = getSummaryFormatLabel(summaryFormat);
  return [...BASE_STEP_LABELS, `${summaryLabel} пересказ (${llmLabel})`];
}

export default function App() {
  const [url, setUrl] = useState("");
  const isLinkValid = useMemo(() => url.trim().length > 0 && isSupportedVideoUrl(url), [url]);
  const [sourceType, setSourceType] = useState("url");
  const [localVideoFile, setLocalVideoFile] = useState(null);
  const [startStep, setStartStep] = useState(1);
  const [audioFile, setAudioFile] = useState(null);
  const [transcriptFile, setTranscriptFile] = useState(null);
  const [summarySourceFile, setSummarySourceFile] = useState(null);

  const mode = "summary";
  const [activeTab, setActiveTab] = useState("run");
  const [llmProvider, setLlmProvider] = useState("deepseek");
  const [summaryFormat, setSummaryFormat] = useState(() => {
    try {
      return normalizeSummaryFormat(window.localStorage.getItem(SUMMARY_FORMAT_STORAGE_KEY));
    } catch {
      return "short";
    }
  });

  // Опции пересказа
  const [wordLimitEnabled, setWordLimitEnabled] = useState(false);
  const [wordLimit, setWordLimit] = useState("20000");
  const [cleanFiller, setCleanFiller] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [diagnosticsMode, setDiagnosticsMode] = useState(() => {
    try {
      return window.localStorage.getItem(DIAGNOSTICS_MODE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const [isRunning, setIsRunning] = useState(false);
  const [resultText, setResultText] = useState("");
  const [pipelineLog, setPipelineLog] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [stepIndex, setStepIndex] = useState(-1);
  const [stepDurationsMs, setStepDurationsMs] = useState([]);
  const [currentStepProgressPct, setCurrentStepProgressPct] = useState(null);
  const [currentStepProgressLabel, setCurrentStepProgressLabel] = useState("");
  const [activeStepStartedAt, setActiveStepStartedAt] = useState(null);
  const [activeStepElapsedMs, setActiveStepElapsedMs] = useState(0);
  const [abortCtrl, setAbortCtrl] = useState(null);
  const [currentJobId, setCurrentJobId] = useState("");
  const [error, setError] = useState("");
  const [llmKeys, setLlmKeys] = useState({
    openai: "",
    deepseek: "",
    grok: "",
    gemini: "",
  });
  const [hfToken, setHfToken] = useState("");
  const [envStatus, setEnvStatus] = useState({
    openai_api_key_set: false,
    deepseek_api_key_set: false,
    grok_api_key_set: false,
    gemini_api_key_set: false,
    hf_token_set: false,
  });
  const [toasts, setToasts] = useState([]);
  const [envBusy, setEnvBusy] = useState(false);
  const [showLlmKey, setShowLlmKey] = useState(false);
  const [showHfToken, setShowHfToken] = useState(false);
  const resultSectionRef = useRef(null);
  const stepLabels = useMemo(() => buildStepLabels(llmProvider, summaryFormat), [llmProvider, summaryFormat]);
  const selectedProvider = useMemo(
    () => LLM_OPTIONS.find((p) => p.id === llmProvider) || LLM_OPTIONS[0],
    [llmProvider]
  );
  function scrollToResultSmooth() {
    const target = resultSectionRef.current;
    if (!target) return;
    const startY = window.scrollY || window.pageYOffset || 0;
    const targetY = target.getBoundingClientRect().top + startY - 12;
    const distance = targetY - startY;
    const durationMs = 500;
    const startedAt = performance.now();
    const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
    const tick = (now) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = easeInOut(progress);
      window.scrollTo(0, startY + distance * eased);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function getInputErrorByStep(step) {
    const trimmed = url.trim();
    if (step === 1) {
      if (sourceType === "local_file") {
        if (!localVideoFile) return "Выберите локальный видеофайл.";
        return "";
      }
      if (!trimmed) return "Введите ссылку на видео (VK, YouTube или Twitch).";
      try {
        // eslint-disable-next-line no-new
        new URL(trimmed);
      } catch {
        return "Ссылка выглядит некорректно. Пример: https://youtu.be/... или https://www.twitch.tv/videos/...";
      }
      if (!isSupportedVideoUrl(trimmed)) {
        return "Поддерживаются ссылки VK, YouTube и Twitch.";
      }
      return "";
    }

    if (step === 2) {
      if (!audioFile) return "Выберите .wav файл для транскрипции.";
      if (!String(audioFile.name || "").toLowerCase().endsWith(".wav")) return "Допустим только .wav файл.";
      return "";
    }

    if (step === 3) {
      if (!transcriptFile) return "Выберите .txt файл транскрипта.";
      if (!String(transcriptFile.name || "").toLowerCase().endsWith(".txt")) return "Допустим только .txt файл.";
      return "";
    }

    if (step === 4) {
      if (!summarySourceFile) return "Выберите .txt файл для пересказа.";
      if (!String(summarySourceFile.name || "").toLowerCase().endsWith(".txt")) return "Допустим только .txt файл.";
      return "";
    }

    return "Некорректный номер шага.";
  }

  const canRun = mode === "summary" && getInputErrorByStep(startStep) === "";
  function getRouteHintFromStep(step) {
    const from = Math.max(1, Math.min(4, Number(step) || 1));
    return ROUTE_STEP_LABELS.slice(from - 1).join(" -> ");
  }
  const routeHint = useMemo(() => {
    return getRouteHintFromStep(startStep);
  }, [startStep]);
  function getStepDurationText(step) {
    const stepIdx = step - 1;
    const doneMs = Number(stepDurationsMs?.[stepIdx]);
    const hasDoneDuration = Number.isFinite(doneMs) && doneMs >= 0;
    if (isRunning && stepIndex === stepIdx) return `${(activeStepElapsedMs / 1000).toFixed(1)} \u0441\u0435\u043a`;
    if (hasDoneDuration) return `${(doneMs / 1000).toFixed(1)} \u0441\u0435\u043a`;
    return "";
  }

  useEffect(() => {
    syncEnvStatus().catch(() => {});
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SUMMARY_FORMAT_STORAGE_KEY, normalizeSummaryFormat(summaryFormat));
    } catch {
      // ignore storage errors
    }
  }, [summaryFormat]);

  useEffect(() => {
    try {
      window.localStorage.setItem(DIAGNOSTICS_MODE_STORAGE_KEY, diagnosticsMode ? "1" : "0");
    } catch {
      // ignore storage errors
    }
  }, [diagnosticsMode]);

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
      };
      const field = keyFieldByProvider[llmProvider] || "openai_api_key";
      const keyValue = llmKeys[llmProvider] || "";
      const data = await postJson("/api/env/set", { [field]: keyValue });
      setEnvStatus({
        openai_api_key_set: Boolean(data?.openai_api_key_set),
        deepseek_api_key_set: Boolean(data?.deepseek_api_key_set),
        grok_api_key_set: Boolean(data?.grok_api_key_set),
        gemini_api_key_set: Boolean(data?.gemini_api_key_set),
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
        gemini_api_key_set: Boolean(data?.gemini_api_key_set),
        hf_token_set: Boolean(data?.hf_token_set),
      });
      pushToast(data?.hf_token_set ? "HF_TOKEN сохранен в серверном процессе." : "HF_TOKEN очищен.", "success");
    } catch (e) {
      pushToast(e?.message || "Не удалось сохранить HF_TOKEN.", "error");
    } finally {
      setEnvBusy(false);
    }
  }

  async function onResetLlmKey() {
    setLlmKeys((prev) => ({
      ...prev,
      [llmProvider]: "",
    }));
    setEnvBusy(true);
    try {
      const keyFieldByProvider = {
        openai: "openai_api_key",
        deepseek: "deepseek_api_key",
        grok: "grok_api_key",
        gemini: "gemini_api_key",
      };
      const field = keyFieldByProvider[llmProvider] || "openai_api_key";
      const data = await postJson("/api/env/set", { [field]: "" });
      setEnvStatus({
        openai_api_key_set: Boolean(data?.openai_api_key_set),
        deepseek_api_key_set: Boolean(data?.deepseek_api_key_set),
        grok_api_key_set: Boolean(data?.grok_api_key_set),
        gemini_api_key_set: Boolean(data?.gemini_api_key_set),
        hf_token_set: Boolean(data?.hf_token_set),
      });
      pushToast(`${selectedProvider.keyName} очищен.`, "success");
    } catch (e) {
      pushToast(e?.message || `Не удалось очистить ${selectedProvider.keyName}.`, "error");
    } finally {
      setEnvBusy(false);
    }
  }

  async function onResetHF() {
    setHfToken("");
    setEnvBusy(true);
    try {
      const data = await postJson("/api/env/set", { hf_token: "" });
      setEnvStatus({
        openai_api_key_set: Boolean(data?.openai_api_key_set),
        deepseek_api_key_set: Boolean(data?.deepseek_api_key_set),
        grok_api_key_set: Boolean(data?.grok_api_key_set),
        gemini_api_key_set: Boolean(data?.gemini_api_key_set),
        hf_token_set: Boolean(data?.hf_token_set),
      });
      pushToast("HF_TOKEN очищен.", "success");
    } catch (e) {
      pushToast(e?.message || "Не удалось очистить HF_TOKEN.", "error");
    } finally {
      setEnvBusy(false);
    }
  }

  async function onRun(forcedStep = startStep) {
    setError("");
    setResultText("");
    setPipelineLog("");
    setWarnings([]);
    setStepIndex(-1);
    setStepDurationsMs([]);
    setCurrentStepProgressPct(null);
    setCurrentStepProgressLabel("");
    setActiveStepStartedAt(null);
    setActiveStepElapsedMs(0);
    setCurrentJobId("");

    const resolvedStep = Math.max(1, Math.min(4, Number(forcedStep) || 1));
    setStartStep(resolvedStep);
    const inputError = getInputErrorByStep(resolvedStep);
    if (inputError) {
      setError(inputError);
      return;
    }

    const wl = wordLimitEnabled ? clampInt(wordLimit, 100, 200000) : null;
    if (wordLimitEnabled && wl === null) {
      setError("Лимит слов должен быть целым числом.");
      return;
    }

    const trimmed = url.trim();
    if (resolvedStep === 1) {
      if (sourceType === "local_file") {
        if (!localVideoFile) {
          setError("Выберите локальный видеофайл.");
          return;
        }
      } else {
        if (!trimmed) {
          setError("Введите ссылку на видео (VK, YouTube или Twitch).");
          return;
        }

        try {
          // eslint-disable-next-line no-new
          new URL(trimmed);
        } catch {
          setError(
            "Ссылка выглядит некорректно. Примеры: https://youtu.be/dQw4w9WgXcQ или https://www.twitch.tv/videos/123456789"
          );
          return;
        }

        if (!isSupportedVideoUrl(trimmed)) {
          setError(
            "Ссылка не поддерживается. Подходят форматы VK, YouTube (watch/shorts/youtu.be) и Twitch (videos/clips)."
          );
          return;
        }
      }
    }

    const ctrl = new AbortController();
    setAbortCtrl(ctrl);

    setIsRunning(true);
    try {
      setStepIndex(resolvedStep - 1);
      setActiveStepStartedAt(Date.now());
      setActiveStepElapsedMs(0);
      const commonOptions = {
        llm_provider: llmProvider,
        summary_format: summaryFormat,
        word_limit: wl, // null => default
        clean: cleanFiller,
        log: showLog,
        diagnostics: diagnosticsMode,
        async: true,
      };

      let startJson = null;
      if (resolvedStep === 1) {
        if (sourceType === "local_file") {
          const formData = new FormData();
          formData.append("start_step", "1");
          formData.append("options", JSON.stringify(commonOptions));
          formData.append("input_file", localVideoFile);
          startJson = await postFormData("/api/pipeline/summary", formData, ctrl.signal);
        } else {
          startJson = await postJson(
            "/api/video/summary",
            {
              url: trimmed,
              options: commonOptions,
            },
            ctrl.signal
          );
        }
      } else {
        const inputFile = resolvedStep === 2 ? audioFile : resolvedStep === 3 ? transcriptFile : summarySourceFile;
        const formData = new FormData();
        formData.append("start_step", String(resolvedStep));
        if (trimmed) formData.append("url", trimmed);
        formData.append("options", JSON.stringify(commonOptions));
        formData.append("input_file", inputFile);
        startJson = await postFormData("/api/pipeline/summary", formData, ctrl.signal);
      }

      if (startJson?.job_id) {
        setCurrentJobId(startJson.job_id);
        while (true) {
          await delay(700, ctrl.signal);
          const statusJson = await getJson(`/api/video/summary/status/${startJson.job_id}`, ctrl.signal);

          if (typeof statusJson?.steps === "number") setStepIndex(Math.min(stepLabels.length - 1, statusJson.steps));
          setCurrentStepProgressPct(
            Number.isFinite(statusJson?.current_step_progress_pct) ? statusJson.current_step_progress_pct : null
          );
          setCurrentStepProgressLabel(statusJson?.current_step_progress_label || "");
          setWarnings(Array.isArray(statusJson?.warnings) ? statusJson.warnings : []);
          setStepDurationsMs(Array.isArray(statusJson?.step_durations_ms) ? statusJson.step_durations_ms : []);
          if (showLog) setPipelineLog(statusJson?.log || "");

          if (statusJson?.status === "done") {
            setStepIndex(stepLabels.length);
            setActiveStepStartedAt(null);
            setCurrentStepProgressPct(null);
            setCurrentStepProgressLabel("");
            setResultText(statusJson?.summary || "");
            setCurrentJobId("");
            if (!statusJson?.summary) setError("Backend не вернул пересказ.");
            setTimeout(() => scrollToResultSmooth(), 0);
            break;
          }
          if (statusJson?.status === "error") {
            setActiveStepStartedAt(null);
            setCurrentStepProgressPct(null);
            setCurrentStepProgressLabel("");
            setCurrentJobId("");
            setError(statusJson?.error || "Не удалось выполнить пересказ.");
            setTimeout(() => scrollToResultSmooth(), 0);
            break;
          }
          if (statusJson?.status === "canceled") {
            setActiveStepStartedAt(null);
            setCurrentStepProgressPct(null);
            setCurrentStepProgressLabel("");
            setCurrentJobId("");
            setError(statusJson?.error || "Остановлено пользователем.");
            setTimeout(() => scrollToResultSmooth(), 0);
            break;
          }
        }
      } else {
        if (typeof startJson?.steps === "number") setStepIndex(Math.min(stepLabels.length, startJson.steps + 1));
        else setStepIndex(stepLabels.length);
        setActiveStepStartedAt(null);
        setCurrentStepProgressPct(null);
        setCurrentStepProgressLabel("");
        setResultText(startJson?.summary || "");
        setPipelineLog(startJson?.log || "");
        setWarnings(Array.isArray(startJson?.warnings) ? startJson.warnings : []);
        setStepDurationsMs(Array.isArray(startJson?.step_durations_ms) ? startJson.step_durations_ms : []);
        if (!startJson?.summary) {
          setError("Backend не вернул пересказ.");
        }
        setTimeout(() => scrollToResultSmooth(), 0);
      }
    } catch (e) {
      if (e?.name === "AbortError") {
        setError("Операция отменена.");
      } else {
        setWarnings(Array.isArray(e?.data?.warnings) ? e.data.warnings : []);
        setStepDurationsMs(Array.isArray(e?.data?.step_durations_ms) ? e.data.step_durations_ms : []);
        setError(e?.message || "Не удалось выполнить пересказ.");
      }
      setTimeout(() => scrollToResultSmooth(), 0);
    } finally {
      setIsRunning(false);
      setActiveStepStartedAt(null);
      setCurrentStepProgressPct(null);
      setCurrentStepProgressLabel("");
      setAbortCtrl(null);
    }
  }

  async function onStopProcess() {
    if (!isRunning || !currentJobId) return;
    const ok = window.confirm("Остановить текущий процесс?");
    if (!ok) return;
    try {
      await postJson(`/api/video/summary/cancel/${currentJobId}`, {});
    } catch {
      // ignore transient cancel API errors; polling will reflect actual state
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-3xl p-6">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Summarizer</h1>
        </header>

        <section className="rounded-2xl bg-white shadow-sm ring-1 ring-neutral-200 p-5">
          <div className="mb-4 flex gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("run")}
              disabled={isRunning}
              className={`rounded-xl px-3 py-2 text-sm ring-1 ${
                activeTab === "run"
                  ? "bg-neutral-900 text-white ring-neutral-900"
                  : "bg-white text-neutral-900 ring-neutral-200 hover:bg-neutral-50"
              }`}
            >
              Запуск
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("settings")}
              disabled={isRunning}
              className={`rounded-xl px-3 py-2 text-sm ring-1 ${
                activeTab === "settings"
                  ? "bg-neutral-900 text-white ring-neutral-900"
                  : "bg-white text-neutral-900 ring-neutral-200 hover:bg-neutral-50"
              }`}
            >
              Настройки
            </button>
            {isRunning && (
              <button
                type="button"
                onClick={onStopProcess}
                className="rounded-xl bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Остановить
              </button>
            )}
          </div>
          <div className="grid gap-4">

            {activeTab === "run" && (
              <>
            <div className="rounded-2xl border border-neutral-200 p-4">
              <div className="text-sm font-medium">Старт пайплайна</div>
              <div className="mt-1 text-xs text-neutral-600">Выберите шаг и нажмите "Начать с этого шага".</div>
              <div className="mt-3 grid gap-3">
                {[1, 2, 3, 4].map((step) => {
                  const isSelected = startStep === step;
                  const isRunningStep = isRunning && stepIndex === step - 1;
                  const stepTitle = stepLabels[step - 1] || `Шаг ${step}`;
                  const inputError = getInputErrorByStep(step);
                  const durationText = getStepDurationText(step);
                  const showStep1ProgressBar =
                    step === 1 && isRunningStep && Number.isFinite(currentStepProgressPct) && currentStepProgressPct >= 0;
                  return (
                    <div
                      key={step}
                      className={`rounded-xl border p-3 ${
                        isRunningStep
                          ? "border-emerald-500 bg-emerald-50"
                          : isSelected
                          ? "border-neutral-900 bg-neutral-50"
                          : "border-neutral-200 bg-white"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (isRunning) return;
                          setStartStep(step);
                        }}
                        disabled={isRunning}
                        className="flex w-full items-center justify-between gap-2 text-left"
                      >
                        <div className="text-sm font-medium">
                          {step}. {stepTitle}
                        </div>
                        <div className="flex items-center gap-2">
                          {durationText && (
                            <span className={`text-xs ${isRunningStep ? "text-emerald-700 font-medium" : "text-neutral-600"}`}>
                              {durationText}
                            </span>
                          )}
                          {isRunningStep && (
                            <span className="rounded-lg bg-emerald-600 px-2 py-1 text-xs font-medium text-white">в работе</span>
                          )}
                          {isSelected && (
                            <span className="rounded-lg bg-neutral-900 px-2 py-1 text-xs font-medium text-white">выбран</span>
                          )}
                        </div>
                      </button>

                      <div
                        className={`grid transition-all duration-500 ease-in-out ${
                          isSelected ? "mt-3 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0"
                        }`}
                      >
                        <div className="overflow-hidden">
                          <label className="mt-3 block text-xs font-medium text-neutral-600">{START_STEP_INPUT_LABELS[step]}</label>
                          {step === 1 && (
                            <div className="mt-2 grid gap-2">
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  type="button"
                                  onClick={() => setSourceType("url")}
                                  disabled={isRunning}
                                  className={`rounded-xl px-3 py-2 text-sm ring-1 ${
                                    sourceType === "url"
                                      ? "bg-neutral-900 text-white ring-neutral-900"
                                      : "bg-white text-neutral-900 ring-neutral-200"
                                  }`}
                                >
                                  По ссылке
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSourceType("local_file")}
                                  disabled={isRunning}
                                  className={`rounded-xl px-3 py-2 text-sm ring-1 ${
                                    sourceType === "local_file"
                                      ? "bg-neutral-900 text-white ring-neutral-900"
                                      : "bg-white text-neutral-900 ring-neutral-200"
                                  }`}
                                >
                                  Локальный файл
                                </button>
                              </div>

                              {sourceType === "url" ? (
                                <div className="flex gap-2">
                                  <input
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                    disabled={isRunning}
                                    className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-300"
                                  />
                                  <div className="shrink-0 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs">
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
                              ) : (
                                <div className="mt-1">
                                  <input
                                    type="file"
                                    accept="video/*,.mp4,.mkv,.mov,.avi,.webm,.m4v"
                                    disabled={isRunning}
                                    onChange={(e) => setLocalVideoFile(e.target.files?.[0] || null)}
                                    className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-900 file:px-3 file:py-1 file:text-xs file:text-white"
                                  />
                                  <div className="mt-1 text-xs text-neutral-500">
                                    {localVideoFile ? localVideoFile.name : "Файл не выбран"}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {step === 2 && (
                            <div className="mt-2">
                              <input
                                type="file"
                                accept=".wav,audio/wav"
                                disabled={isRunning}
                                onChange={(e) => setAudioFile(e.target.files?.[0] || null)}
                                className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-900 file:px-3 file:py-1 file:text-xs file:text-white"
                              />
                              <div className="mt-1 text-xs text-neutral-500">{audioFile ? audioFile.name : "Файл не выбран"}</div>
                            </div>
                          )}

                          {step === 3 && (
                            <div className="mt-2">
                              <input
                                type="file"
                                accept=".txt,text/plain"
                                disabled={isRunning}
                                onChange={(e) => setTranscriptFile(e.target.files?.[0] || null)}
                                className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-900 file:px-3 file:py-1 file:text-xs file:text-white"
                              />
                              <div className="mt-1 text-xs text-neutral-500">{transcriptFile ? transcriptFile.name : "Файл не выбран"}</div>
                            </div>
                          )}

                          {step === 4 && (
                            <div className="mt-2">
                              <input
                                type="file"
                                accept=".txt,text/plain"
                                disabled={isRunning}
                                onChange={(e) => setSummarySourceFile(e.target.files?.[0] || null)}
                                className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-900 file:px-3 file:py-1 file:text-xs file:text-white"
                              />
                              <div className="mt-1 text-xs text-neutral-500">
                                {summarySourceFile ? summarySourceFile.name : "Файл не выбран"}
                              </div>
                            </div>
                          )}

                          <div className="mt-3 flex items-center justify-between gap-2">
                            <div className={`text-xs ${inputError ? "text-red-600" : "text-neutral-600"}`}>
                              {inputError || `Будут выполнены шаги: ${getRouteHintFromStep(step)}`}
                            </div>
                            <button
                              type="button"
                              onClick={() => onRun(step)}
                              disabled={isRunning || Boolean(inputError) || mode !== "summary"}
                              className="rounded-xl bg-neutral-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                            >
                              Начать с этого шага
                            </button>
                          </div>
                          {showStep1ProgressBar && (
                            <div className="mt-3">
                              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-neutral-600">
                                <span>{currentStepProgressLabel || "Подготовка аудио"}</span>
                                <span>{Math.round(currentStepProgressPct)}%</span>
                              </div>
                              <div className="h-2 overflow-hidden rounded-full bg-neutral-200">
                                <div
                                  className="h-full rounded-full bg-emerald-500 transition-all duration-300 ease-out"
                                  style={{ width: `${Math.max(0, Math.min(100, currentStepProgressPct))}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 text-xs text-neutral-600">Что будет выполнено: {routeHint}</div>
            </div>
              </>
            )}

            {activeTab === "settings" && (
              <>
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
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 min-w-0">
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
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={onCheckLlmStatus}
                      disabled={envBusy}
                      className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 hover:bg-neutral-50 disabled:opacity-50 whitespace-nowrap"
                    >
                      Проверить наличие
                    </button>
                    <button
                      type="button"
                      onClick={onSetLlmKey}
                      disabled={envBusy}
                      className="rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50 whitespace-nowrap"
                    >
                      Сохранить
                    </button>
                    
                    <button
                      type="button"
                      onClick={onResetLlmKey}
                      disabled={envBusy}
                      className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 hover:bg-neutral-50 disabled:opacity-50 whitespace-nowrap"
                    >
                      Сбросить
                    </button>
                  </div>
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
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 min-w-0">
                    <input
                      type={showHfToken ? "text" : "password"}
                      value={hfToken}
                      onChange={(e) => setHfToken(e.target.value)}
                      placeholder="hf_..."
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 pr-10 text-sm outline-none focus:ring-2 focus:ring-neutral-300"
                    />
                    <button
                      type="button"
                      onClick={() => setShowHfToken((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-neutral-500 hover:text-neutral-900"
                      aria-label={showHfToken ? "Скрыть токен" : "Показать токен"}
                      title={showHfToken ? "Скрыть" : "Показать"}
                    >
                      {showHfToken ? (
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
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={onCheckHFStatus}
                      disabled={envBusy}
                      className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 hover:bg-neutral-50 disabled:opacity-50 whitespace-nowrap"
                    >
                      Проверить наличие
                    </button>
                    <button
                      type="button"
                      onClick={onSetHF}
                      disabled={envBusy}
                      className="rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50 whitespace-nowrap"
                    >
                      Сохранить
                    </button>
                    
                    <button
                      type="button"
                      onClick={onResetHF}
                      disabled={envBusy}
                      className="rounded-xl px-3 py-2 text-sm ring-1 ring-neutral-200 hover:bg-neutral-50 disabled:opacity-50 whitespace-nowrap"
                    >
                      Сбросить
                    </button>
                  </div>
                </div>
              </div>

            </div>

            {mode === "summary" && (
              <div className="rounded-2xl border border-neutral-200 p-4">
                <div>
                  <div className="text-sm font-medium">Опции пересказа</div>
                  <div className="text-xs text-neutral-600">Настройки применяются сразу.</div>
                </div>

                <div className="mt-4 grid gap-3">
                  <label className="text-sm">
                    <span className="mb-1 block">Формат пересказа</span>
                    <select
                      value={summaryFormat}
                      onChange={(e) => setSummaryFormat(e.target.value)}
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-300"
                    >
                      {SUMMARY_FORMAT_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Задать лимит слов</span>
                    <input
                      type="checkbox"
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
                      disabled={!wordLimitEnabled}
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
                      checked={cleanFiller}
                      onChange={(e) => setCleanFiller(e.target.checked)}
                      className="h-4 w-4"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Выводить лог</span>
                    <input
                      type="checkbox"
                      checked={showLog}
                      onChange={(e) => setShowLog(e.target.checked)}
                      className="h-4 w-4"
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 text-sm">
                    <span>Диагностический режим (подробные warning)</span>
                    <input
                      type="checkbox"
                      checked={diagnosticsMode}
                      onChange={(e) => setDiagnosticsMode(e.target.checked)}
                      className="h-4 w-4"
                    />
                  </label>
                </div>
              </div>
            )}
              </>
            )}

            {activeTab === "run" && (
              <>
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

              </>
            )}

            
          </div>
        </section>

        <section ref={resultSectionRef} className="mt-6 rounded-2xl bg-white shadow-sm ring-1 ring-neutral-200 p-5">
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
            <p className="mt-3 text-sm text-neutral-600">Пока пусто. Выберите стартовый шаг, задайте входные данные и нажмите запуск.</p>
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
          MVP: запуск с шагов 1-4. Для backend нужны: yt-dlp/ffmpeg (если старт с шага 1), python + whisperx (если старт с шага 1-2), HF_TOKEN и ключ выбранного LLM.
        </footer>
      </div>

      <div className="fixed top-4 right-4 z-50 flex w-96 max-w-full flex-col gap-2">
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


