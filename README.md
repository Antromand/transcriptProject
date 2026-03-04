# Video Summarizer MVP (UI + Backend)

Приложение для получения структурированного пересказа из видео:
- по ссылке (VK / YouTube / Twitch),
- или из локального видеофайла.

Пайплайн:
1. Подготовка аудио (`yt-dlp` для URL или `ffmpeg` для локального файла) -> `audio.wav`
2. Транскрипция (`WhisperX` + diarization) -> `.txt`
3. Разбиение текста на чанки (`split_whisperx.py`)
4. Пересказ через LLM

## Что реализовано

- UI: React (Vite), по умолчанию `http://localhost:5173`
- Backend: Node/Express, по умолчанию `http://localhost:3000`
- Асинхронные job + polling статуса
- Запуск с шага `1/2/3/4`
- Источник шага 1:
  - URL
  - Локальный файл (через file picker)
- Кнопка остановки процесса на любом шаге
- Диагностический режим (показывает полный технический warning/stderr)
- Хранение выбранного формата пересказа и диагностики в `localStorage`
- Автоочистка папок результатов в `work/` (оставляются последние 20 job-папок)
- Аудит-логи сохраняются помесячно в `work/audit/`

## Поддерживаемые LLM-провайдеры

- OpenAI
- DeepSeek
- Grok
- Gemini

## Требования

### Базовые утилиты
- `node` 18+
- `npm`
- `python` 3.10+
- `ffmpeg` в `PATH`
- `yt-dlp` в `PATH` (если используете URL-источник на шаге 1)

### Python-часть
- `run_whisperx.py` и `split_whisperx.py` в корне проекта
- установленный `whisperx` и зависимости

Важно по diarization:
- `pip install whisperx` не всегда достаточно для рабочего diarization.
- Нужен `HF_TOKEN` и доступ к нужным pyannote-моделям в Hugging Face (включая принятие условий моделей).

## Установка

```bash
npm install
npm --prefix server install
npm --prefix ui install
```

## Рекомендуемая подготовка Python-окружения (Windows PowerShell)

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install whisperx
```

## Запуск в dev

```bash
npm run dev
```

## Продакшен (опционально)

```bash
npm run build
npm run start
```

## Основные API endpoint'ы

- `POST /api/video/summary` — запуск с шага 1 (URL/локальный путь)
- `GET /api/video/summary/status/:jobId` — статус job
- `POST /api/video/summary/cancel/:jobId` — остановка job
- `POST /api/pipeline/summary` — запуск с произвольного шага (в т.ч. multipart с `input_file`)

Совместимость со старыми маршрутами сохранена:
- `/api/vk/summary`
- `/api/vk/summary/status/:jobId`
- `/api/vk/summary/cancel/:jobId`

## Переменные окружения

### Обязательные для полного пайплайна
- `HF_TOKEN` — для WhisperX/diarization
- один из ключей LLM:
  - `OPENAI_API_KEY`
  - `DEEPSEEK_API_KEY`
  - `GROK_API_KEY`
  - `GEMINI_API_KEY`

### Опциональные
- `PORT` (по умолчанию `3000`)
- `WORK_ROOT` (по умолчанию `./work`)
- `UI_DIST` (по умолчанию `./ui/dist`)

- `YTDLP_BIN` (по умолчанию `yt-dlp`)
- `FFMPEG_BIN` (по умолчанию `ffmpeg`)
- `PYTHON_BIN` (по умолчанию `python`)

- `WHISPERX_SCRIPT` (по умолчанию `run_whisperx.py`)
- `SPLIT_SCRIPT` (по умолчанию `split_whisperx.py`)
- `TRANSCRIPT_PATH` (override пути транскрипта)
- `COOKIES_FILE` (cookies для `yt-dlp`, если нужен доступ к ограниченному контенту)

- `YTDLP_JS_RUNTIMES` (по умолчанию `node deno`)
- `YTDLP_REMOTE_COMPONENTS` (по умолчанию `ejs:github`)
- `YTDLP_YOUTUBE_EXTRACTOR_ARGS` (по умолчанию `player_client=android,web`)
- `YTDLP_YOUTUBE_PO_TOKEN` (если нужен `po_token` для YouTube)

- `OPENAI_MODEL`
- `DEEPSEEK_MODEL`
- `GROK_MODEL`
- `GEMINI_MODEL`

### Политика хранения
- `AUDIT_LOG_KEEP_LAST`:
  - по умолчанию `0` (не обрезать аудит-лог по количеству строк)
- `WORK_RESULTS_KEEP_LAST`:
  - по умолчанию `20` (оставлять последние 20 job-директорий в `work/`)

## Где хранятся данные

- Рабочие артефакты: `work/<job-id>/...`
- Аудит: `work/audit/audit-log-YYYY-MM.jsonl`
- Секреты UI/env: `work/env-secrets.json`

`work/` добавлена в `.gitignore`.

## Troubleshooting

- Если шаг 1 по URL дает warning YouTube:
  - включите диагностический режим в UI и смотрите полный stderr
  - проверьте `yt-dlp --version`, `ffmpeg -version`
  - при необходимости настройте `YTDLP_YOUTUBE_PO_TOKEN`

- Если WhisperX/diarization не стартует:
  - проверьте `HF_TOKEN`
  - проверьте доступ к pyannote-моделям на Hugging Face
  - проверьте Python-окружение и версии зависимостей

- Если нужно прервать выполнение:
  - используйте кнопку `Остановить` в UI (она вызывает backend cancel endpoint)
