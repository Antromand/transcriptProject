# Video Summarizer MVP (UI + Backend)

Приложение для получения структурированного пересказа из видео и прямого скачивания роликов по ссылке:
- по ссылке (VK / YouTube / Twitch / Kick),
- или из локального видеофайла.

В UI есть два отдельных сценария:
- `Пересказ видео` — полный пайплайн `yt-dlp/ffmpeg -> WhisperX -> чанки -> LLM`
- `Скачать видео` — прямое скачивание файла по URL без транскрипции и без LLM

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
- Отдельная вкладка `Скачать видео` для прямого скачивания по ссылке
- Загрузка списка доступных качеств и контейнеров (`mp4`, `webm`, если они реально есть у источника)
- Прогресс-бар прямого скачивания с polling статуса job
- Автоочистка папок результатов в `work/` (оставляются последние 20 job-папок)
- Аудит-логи сохраняются помесячно в `work/audit/`

## Прямое скачивание видео

- Поддерживается для URL-источников (`VK`, `YouTube`, `Twitch`, `Kick`)
- Перед скачиванием UI запрашивает список форматов через `yt-dlp`
- Если у варианта указано `звук встроен`, аудио уже есть в потоке
- Если у варианта указано `аудио добавится`, это video-only поток; сервер автоматически подтянет лучшую совместимую аудиодорожку и соберет итоговый файл со звуком
- Для YouTube это нормальное поведение: высокие качества часто доступны только как отдельное видео без встроенного аудио
- При выборе `mp4` или `webm` сервер старается сохранить именно этот контейнер; если сайт или набор потоков не позволяют сделать это без потерь, итоговый контейнер может зависеть от `ffmpeg/yt-dlp`
- Прогресс прямого скачивания показывает ход загрузки и финальную стадию merge/fixup

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

Если планируете скачивать `Kick` или другие сайты, которым нужен impersonation/TLS fingerprinting, ставьте `curl_cffi` в то же Python-окружение, где запускается `yt-dlp`:

```powershell
python -m pip install --upgrade yt-dlp curl_cffi
yt-dlp --list-impersonate-targets
```

Проверка считается успешной, если в выводе `yt-dlp --list-impersonate-targets` есть доступные targets, а не только `unavailable`.

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

### Пересказ
- `POST /api/video/summary` — запуск с шага 1 (URL/локальный путь)
- `GET /api/video/summary/status/:jobId` — статус job
- `POST /api/video/summary/cancel/:jobId` — остановка job
- `POST /api/pipeline/summary` — запуск с произвольного шага (в т.ч. multipart с `input_file`)

### Прямое скачивание
- `POST /api/video/download/formats` — получить список доступных форматов/качеств для URL
- `POST /api/video/download/start` — запустить асинхронное прямое скачивание
- `GET /api/video/download/status/:jobId` — статус и прогресс прямого скачивания
- `POST /api/video/download/prepare` — синхронно подготовить файл к скачиванию (fallback/совместимость)
- `GET /api/video/download/file/:fileId` — скачать подготовленный файл

Для `GET /api/video/download/status/:jobId` важные поля ответа:
- `progress_pct` — процент загрузки
- `progress_label` — текстовая стадия (`Скачивание видео`, `Скачивание аудио`, `Подготовка файла`)
- `download_url` — ссылка на готовый файл, когда job завершен
- `warnings` — технические предупреждения `yt-dlp`, если они есть

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

Примечание по YouTube:
- `YTDLP_YOUTUBE_EXTRACTOR_ARGS` и `YTDLP_YOUTUBE_PO_TOKEN` используются в пайплайне пересказа
- при загрузке списка качеств и прямом скачивании приложение намеренно не форсирует эти extractor args, потому что для части роликов это может искусственно ограничивать доступные качества до `360p`

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
- Временные файлы прямого скачивания: `work/downloads/<download-id>/...`
- Аудит: `work/audit/audit-log-YYYY-MM.jsonl`
- Секреты UI/env: `work/env-secrets.json`

`work/` добавлена в `.gitignore`.

Файлы из `work/downloads/` считаются временными и автоматически очищаются после истечения TTL.

## Troubleshooting

- Если шаг 1 по URL дает warning YouTube:
  - включите диагностический режим в UI и смотрите полный stderr
  - проверьте `yt-dlp --version`, `ffmpeg -version`
  - при необходимости настройте `YTDLP_YOUTUBE_PO_TOKEN`

- Если во вкладке `Скачать видео` у YouTube высокие качества отмечены как `аудио добавится`:
  - это нормально, `yt-dlp` часто отдает `720p/1080p+` как отдельные video-only потоки
  - итоговый файл все равно будет собран со звуком, если сервер смог скачать совместимую аудиодорожку

- Если во вкладке `Скачать видео` доступны только низкие качества YouTube:
  - проверьте `yt-dlp --version`
  - проверьте `COOKIES_FILE`, если ролик ограничен
  - при необходимости проверьте `YTDLP_YOUTUBE_PO_TOKEN` для основного пайплайна
  - учитывайте, что список качеств для прямого скачивания специально строится без `YTDLP_YOUTUBE_EXTRACTOR_ARGS`, чтобы не занижать качество на части роликов

- Если `Kick` возвращает `403 Forbidden`:
  - проверьте, что `curl_cffi` установлен в то же Python-окружение, где запускается `yt-dlp`
  - выполните `yt-dlp --list-impersonate-targets` и убедитесь, что хотя бы часть targets доступна
  - если impersonation уже доступен, но видео все равно не открывается, попробуйте указать `COOKIES_FILE`

- Если прогресс прямого скачивания долго стоит около `99%`:
  - это обычно стадия merge/fixup после раздельной загрузки видео и аудио
  - итоговый файл будет доступен только после завершения этой стадии

- Если WhisperX/diarization не стартует:
  - проверьте `HF_TOKEN`
  - проверьте доступ к pyannote-моделям на Hugging Face
  - проверьте Python-окружение и версии зависимостей

- Если нужно прервать выполнение:
  - используйте кнопку `Остановить` в UI (она вызывает backend cancel endpoint)
