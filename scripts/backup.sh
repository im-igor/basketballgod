#!/usr/bin/env bash
#
# Еженедельный бэкап basketballgod: дамп БД + .env + secrets/.
# Кладёт один .tar.gz с датой в $BACKUP_DIR и хранит только $KEEP последних копий.
# Всё остальное (код, миграции, docker-compose.yml) — в GitHub, бэкапить не нужно.
#
# Запуск вручную:   ./scripts/backup.sh
# По расписанию:    см. scripts/BACKUP.md (раздел «Автозапуск раз в неделю»).
#
set -euo pipefail

# cron запускается с урезанным PATH — docker может быть не найден. Дополняем.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# Корень проекта = папка на уровень выше scripts/ (там лежит docker-compose.yml).
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# Куда складывать бэкапы — ВНЕ git-репозитория. Переопределяется переменной окружения.
BACKUP_DIR="${BACKUP_DIR:-$HOME/basketballgod-backups}"
KEEP="${KEEP:-2}"   # сколько последних копий хранить

STAMP="$(date +%Y-%m-%d_%H%M)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$BACKUP_DIR"

echo "▶ basketballgod backup ${STAMP}"

# 1. Дамп Postgres в custom-формате (сжатый, восстанавливается pg_restore).
echo "  • дамп БД…"
docker compose exec -T db pg_dump -U basketballgod -Fc basketballgod > "$WORK/db.dump"

# 2. Конфиг и секреты (их нет в GitHub).
if [ -f .env ]; then
  cp .env "$WORK/.env"
else
  echo "  ⚠️  .env не найден — пропущен"
fi
if [ -d secrets ] && [ -n "$(ls -A secrets 2>/dev/null)" ]; then
  cp -R secrets "$WORK/secrets"
  echo "  • secrets/ добавлены"
fi

# 3. Манифест: когда снято и на каком коммите крутился сервер.
{
  echo "basketballgod backup"
  echo "created:    ${STAMP}"
  echo "host:       $(hostname 2>/dev/null || echo n/a)"
  echo "git commit: $(git rev-parse --short HEAD 2>/dev/null || echo n/a)"
} > "$WORK/MANIFEST.txt"

# 4. Упаковка в один архив с датой.
ARCHIVE="$BACKUP_DIR/basketballgod_${STAMP}.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" .
echo "  ✅ $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# 5. Ротация: оставляем $KEEP самых свежих, остальные удаляем.
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/basketballgod_*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))")
for old in "${OLD[@]:-}"; do
  [ -n "$old" ] || continue
  rm -f "$old"
  echo "  🗑  удалён старый бэкап: $(basename "$old")"
done

echo "▶ готово. Копий в $BACKUP_DIR: $(ls -1 "$BACKUP_DIR"/basketballgod_*.tar.gz 2>/dev/null | wc -l | tr -d ' ')"
