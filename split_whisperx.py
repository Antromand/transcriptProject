from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List


# =========================
# WhisperX формат
# =========================
SPEAKER_RE = re.compile(r"^\[SPEAKER_\d+\]:")

# ---- Читаемый и расширяемый список мусора ----
FILLER_PATTERNS: List[str] = [
    r"[эеё]+",      # эээ, еее
    r"м+",          # ммм
    r"эм+",         # эмм
    r"ээ+м+",       # ээм
    r"ну",          # ну
    r"а",           # а
    r"\.+",         # ...
    r"—+",          # —
    r"-+",          # ---
    r"…+",          # …
]

FILLER_ONLY_RE = re.compile(
    rf"^\[SPEAKER_\d+\]:\s*(?:{'|'.join(FILLER_PATTERNS)})\s*$",
    re.IGNORECASE,
)


# =========================
# Конфигурация (дефолты)
# =========================
DEFAULT_WORDS_LIMIT = 20000
MIN_FRACTION = 0.80
LOOKBACK_LINES = 80
PREFER_BLANK_LINE = True


# =========================
# Лог чанков (опционально)
# =========================
@dataclass
class ChunkStat:
    part: int
    file: Path
    lines: int
    words: int
    dropped_filler_lines: int


# =========================
# Вспомогательные функции
# =========================
def count_words(text: str) -> int:
    return len(text.split())


def is_blank(line: str) -> bool:
    return not line.strip()


def is_speaker_line(line: str) -> bool:
    return bool(SPEAKER_RE.match(line))


def is_filler_line(line: str) -> bool:
    # Удаляем только реплики вида [SPEAKER_XX]: <мусор>
    return is_speaker_line(line) and bool(FILLER_ONLY_RE.match(line))


def find_cut_index(lines: List[str], words: int, words_limit: int) -> int:
    """
    Ищет лучшую границу, чтобы не резать слишком рано.
    Резка всегда по границе строк (строку не разрываем).
    """
    if words < words_limit * MIN_FRACTION:
        return len(lines)

    start = max(0, len(lines) - LOOKBACK_LINES)

    if PREFER_BLANK_LINE:
        # самая поздняя пустая строка в хвосте
        for i in range(len(lines) - 1, start - 1, -1):
            if is_blank(lines[i]):
                return i + 1

    # иначе режем по концу чанка
    return len(lines)


def safe_preview(s: str, n: int = 80) -> str:
    s = s.strip().replace("\t", " ")
    return (s[:n] + "…") if len(s) > n else s


# =========================
# Основная логика
# =========================
def split_whisperx_file(
    input_path: Path,
    out_dir: Path,
    words_limit: int = DEFAULT_WORDS_LIMIT,
    clean_fillers: bool = True,
    write_log: bool = True,
) -> List[ChunkStat]:
    if words_limit <= 0:
        raise ValueError("words_limit должен быть положительным числом")

    text = input_path.read_text(encoding="utf-8")
    lines = text.splitlines()

    out_dir.mkdir(parents=True, exist_ok=True)
    base_name = input_path.stem

    chunk: List[str] = []
    chunk_words = 0
    part = 1

    dropped_total = 0
    dropped_in_current_chunk = 0

    stats: List[ChunkStat] = []

    def save_chunk(data: List[str], idx: int, dropped: int) -> None:
        out_file = out_dir / f"{base_name}_part_{idx:02}.txt"
        out_file.write_text("\n".join(data) + "\n", encoding="utf-8")

        words = sum(count_words(l) for l in data if l.strip())
        stats.append(
            ChunkStat(
                part=idx,
                file=out_file,
                lines=len(data),
                words=words,
                dropped_filler_lines=dropped,
            )
        )

    for line in lines:
        if clean_fillers and is_filler_line(line):
            dropped_total += 1
            dropped_in_current_chunk += 1
            continue

        chunk.append(line)
        chunk_words += count_words(line)

        if chunk_words >= words_limit:
            cut = find_cut_index(chunk, chunk_words, words_limit)
            if cut <= 0:
                cut = len(chunk)

            save_chunk(chunk[:cut], part, dropped_in_current_chunk)
            part += 1

            # перенос остатка
            chunk = chunk[cut:]
            chunk_words = sum(count_words(l) for l in chunk if l.strip())
            dropped_in_current_chunk = 0

    if chunk:
        save_chunk(chunk, part, dropped_in_current_chunk)

    if write_log:
        log_path = out_dir / f"{base_name}_split_log.tsv"
        rows = ["part\tfile\tlines\twords\tdropped_filler_lines\tfirst_line\tlast_line"]
        for st in stats:
            content = st.file.read_text(encoding="utf-8").splitlines()
            first_line = safe_preview(content[0]) if content else ""
            last_line = safe_preview(content[-1]) if content else ""
            rows.append(
                f"{st.part}\t{st.file.name}\t{st.lines}\t{st.words}\t{st.dropped_filler_lines}\t{first_line}\t{last_line}"
            )
        rows.append(f"# dropped_total\t{dropped_total}")
        log_path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    return stats


# =========================
# CLI
# =========================
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Split WhisperX .txt transcription into chunks (words limit + cut on line boundaries)"
    )
    parser.add_argument(
        "input",
        type=Path,
        help="Путь к входному .txt файлу WhisperX"
    )
    parser.add_argument(
        "-o", "--out",
        type=Path,
        default=Path("parts"),
        help="Каталог для выходных файлов (по умолчанию: ./parts)"
    )
    parser.add_argument(
        "-w", "--words-limit",
        type=int,
        default=DEFAULT_WORDS_LIMIT,
        help=f"Лимит слов на чанк (по умолчанию: {DEFAULT_WORDS_LIMIT})"
    )
    parser.add_argument(
        "--no-clean",
        action="store_true",
        help="Не удалять мусорные реплики (эээ/ммм/...)"
    )
    parser.add_argument(
        "--no-log",
        action="store_true",
        help="Не писать лог-файл .tsv"
    )

    args = parser.parse_args()

    if not args.input.exists():
        raise FileNotFoundError(f"Файл не найден: {args.input}")

    stats = split_whisperx_file(
        input_path=args.input,
        out_dir=args.out,
        words_limit=args.words_limit,
        clean_fillers=not args.no_clean,
        write_log=not args.no_log,
    )

    print(f"Готово. Создано частей: {len(stats)}")
    if stats:
        print(f"Папка вывода: {args.out.resolve()}")
        print(f"Пример: {stats[0].file.name} (lines={stats[0].lines}, words={stats[0].words})")


if __name__ == "__main__":
    main()
