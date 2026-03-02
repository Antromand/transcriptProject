# VK Video Summarizer MVP (UI + Backend)

## Что это
- UI: React (Vite) на `http://localhost:5173`
- Backend: Node/Express на `http://localhost:3000`
- UI вызывает: `POST /api/vk/summary`

## Требования
### Утилиты
- `yt-dlp` в PATH
- `ffmpeg` в PATH
- `python` в PATH + WhisperX/diarization зависимости
- `run_whisperx.py` и `split_whisperx.py` (положите рядом с проектом или укажите пути в env)

### ENV
- `HF_TOKEN`
- `OPENAI_API_KEY`
- опционально: `OPENAI_MODEL` (по умолчанию `gpt-5`), `WHISPERX_SCRIPT`, `SPLIT_SCRIPT`, `TRANSCRIPT_PATH`, `COOKIES_FILE` (только если нужен доступ через cookies к закрытым/ограниченным видео)

## Установка
```bash
npm install
npm --prefix server install
npm --prefix ui install
```

## Запуск DEV
```bash
npm run dev
```

## Прод (опционально)
```bash
npm run build
npm run start
```
