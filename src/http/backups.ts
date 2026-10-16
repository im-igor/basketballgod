import type { FastifyInstance, FastifyReply } from 'fastify';
import { getBackupConfig, updateBackupConfig } from '../db/repos/backupConfig.repo.js';
import { backupHostRoot, backupPaths, listBackupArchives, openBackupArchive, prepareBackupDirectory, runBackup, type BackupArchive } from '../services/backup.service.js';
import { reloadBackupScheduler } from '../scheduler/backup.js';
import { layout, esc } from './views.js';
import { env } from '../config/env.js';

const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const sizeUnits = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
const sizeNumber = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatFileSize(bytes: number): string {
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < sizeUnits.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${sizeNumber.format(size)} ${sizeUnits[unit]}`;
}

function redirect(reply: FastifyReply, message: string): FastifyReply {
  return reply.redirect(`/backups?msg=${encodeURIComponent(message)}`);
}

const restoreGuide = `<div class="card restore-guide"><h2>Полное восстановление на новой ВМ</h2>
  <ol>
    <li>Останови приложение на старой ВМ, чтобы два экземпляра бота не работали одновременно. Скачай архив выше и передай его на новую ВМ защищённым способом.</li>
    <li>Установи Docker и Compose. Клонируй репозиторий в <code>~/basketballgod</code> и перейди в него. Создай папку <code>~/basketballgod-backups</code> с правами пользователя UID 1000: <code>mkdir -p "$HOME/basketballgod-backups" &amp;&amp; chmod 700 "$HOME/basketballgod-backups"</code>.</li>
    <li>Распакуй архив и верни конфигурацию (строку с <code>secrets</code> выполняй, только если такая папка есть в архиве):
      <pre>RESTORE_DIR=$(mktemp -d)
tar -xzf /путь/к/basketballgod_ДАТА.tar.gz -C "$RESTORE_DIR"
cp "$RESTORE_DIR/.env" .env
chmod 600 .env
if [ -d "$RESTORE_DIR/secrets" ]; then
  mkdir -p secrets
  cp -R "$RESTORE_DIR/secrets/." secrets/
  chmod 600 secrets/*
fi</pre>Если в старой <code>.env</code> задан <code>BACKUP_HOST_ROOT</code>, проверь, что этот путь существует на новой ВМ и доступен UID 1000.</li>
    <li>Подними БД и дождись готовности: <pre>docker compose up -d db
docker compose exec -T db pg_isready -U basketballgod</pre></li>
    <li>Восстанови данные. Команда заменяет существующее содержимое БД:
      <pre>docker compose exec -T db pg_restore -U basketballgod -d basketballgod --clean --if-exists --exit-on-error &lt; "$RESTORE_DIR/db.dump"</pre></li>
    <li>Запусти приложение и проверь БД, бота и админку:
      <pre>docker compose up -d --build app
docker compose ps
docker compose logs --tail=100 app
curl http://localhost:3000/healthz</pre></li>
    <li>После проверки удали распакованные секреты: <code>test -n "$RESTORE_DIR" &amp;&amp; rm -r -- "$RESTORE_DIR"</code>. Исходный архив храни вне ВМ.</li>
  </ol>
  <p class="muted">Код берётся из Git. Архив содержит дамп БД, <code>.env</code>, файлы <code>secrets/</code> (если были) и манифест.</p>
</div>`;

export function registerBackupRoutes(app: FastifyInstance): void {
  app.get('/backups', async (req, reply) => {
    const config = await getBackupConfig();
    const path = backupPaths(config.subdir).host;
    let archives: BackupArchive[] = [];
    let storageError = '';
    try { archives = await listBackupArchives(config.subdir); }
    catch (err) { storageError = (err as Error).message; }
    const q = req.query as { msg?: string };
    const option = (value: string, label: string) =>
      `<option value="${value}"${config.frequency === value ? ' selected' : ''}>${label}</option>`;
    const dayOptions = days.map((day, index) =>
      `<option value="${index + 1}"${config.weekday === index + 1 ? ' selected' : ''}>${day}</option>`).join('');
    const rows = archives.map((archive) => `<tr>
      <td><code>${esc(archive.name)}</code></td><td>${formatFileSize(archive.size)}</td>
      <td>${esc(new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: env.TZ }).format(archive.modified))}</td>
      <td><a href="/backups/download/${encodeURIComponent(archive.name)}" download>Скачать</a></td></tr>`).join('');
    const status = config.last_success_at
      ? `Последняя успешная копия: ${esc(new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: env.TZ }).format(config.last_success_at))}.`
      : 'Успешных копий через админку пока нет.';
    const body = `<h1>Резервные копии</h1>
      <div class="card"><h2>Расписание и хранение</h2>
        <p class="muted">Путь на ВМ: <code>${esc(path)}</code>. Часовой пояс: ${esc(env.TZ)}.</p>
        <form method="post" action="/backups/settings">
          <label class="inline" style="display:flex;gap:8px;align-items:center;margin:0 0 14px">
            <input type="checkbox" name="enabled" value="yes"${config.enabled ? ' checked' : ''} style="width:auto">Автоматически создавать копии</label>
          <div class="row">
            <div><label>Периодичность</label><select name="frequency">${option('daily', 'Ежедневно')}${option('weekly', 'Еженедельно')}${option('monthly', 'Ежемесячно')}</select></div>
            <div><label>День недели (еженедельно)</label><select name="weekday">${dayOptions}</select></div>
            <div><label>Число месяца (ежемесячно, 1–28)</label><input name="month_day" type="number" min="1" max="28" value="${config.month_day}" required></div>
            <div><label>Время (ЧЧ:ММ)</label><input name="run_time" type="time" value="${esc(config.run_time)}" required></div>
          </div>
          <div class="row" style="margin-top:12px">
            <div style="flex:3"><label>Полный путь к папке на ВМ</label><input name="host_path" value="${esc(path)}" required></div>
            <div><label>Сколько последних архивов хранить</label><input name="keep_count" type="number" min="1" max="100" value="${config.keep_count}" required></div>
          </div>
          <p class="muted">Папка должна находиться внутри <code>${esc(backupHostRoot())}</code> — это смонтированный в контейнер каталог. Для другого диска измени BACKUP_HOST_ROOT в Docker Compose и пересоздай контейнер.</p>
          <button>Сохранить настройки</button>
        </form>
        <p class="muted">${status}${config.last_error ? ` Последняя ошибка: ${esc(config.last_error)}.` : ''}</p>
        <form method="post" action="/backups/run"><button class="ghost">Создать копию сейчас</button></form>
      </div>
      <div class="card"><h2>Архивы в текущей папке</h2>
        <p class="muted">Архив содержит базу данных и секреты. Сохраняй скачанный файл в защищённом месте.</p>
        ${storageError ? `<p class="badge no">Папка недоступна: ${esc(storageError)}</p>` : archives.length ? `<div class="table-scroll"><table class="backup-table"><thead><tr><th>Архив</th><th>Размер</th><th>Создан</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">Архивов пока нет.</p>'}
      </div>${restoreGuide}`;
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(layout('Резервные копии', body, { flash: q.msg }));
  });

  app.post('/backups/settings', async (req, reply) => {
    const b = req.body as Record<string, string>;
    const frequency = b.frequency;
    const weekday = Number(b.weekday);
    const monthDay = Number(b.month_day);
    const keep = Number(b.keep_count);
    const time = b.run_time || '';
    if (!frequency || !['daily', 'weekly', 'monthly'].includes(frequency) ||
        !Number.isInteger(weekday) || weekday < 1 || weekday > 7 ||
        !Number.isInteger(monthDay) || monthDay < 1 || monthDay > 28 ||
        !Number.isInteger(keep) || keep < 1 || keep > 100 ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return redirect(reply, 'Некорректные настройки расписания');
    try {
      const hostPath = b.host_path?.trim();
      if (!hostPath) throw new Error('Укажи путь к папке на ВМ');
      const selected = await prepareBackupDirectory(hostPath);
      await updateBackupConfig({ enabled: b.enabled === 'yes',
        frequency: frequency as 'daily' | 'weekly' | 'monthly',
        weekday, month_day: monthDay, run_time: time, subdir: selected.subdir, keep_count: keep });
      await reloadBackupScheduler();
      return redirect(reply, 'Настройки резервного копирования сохранены');
    } catch (err) { return redirect(reply, `Не удалось сохранить: ${(err as Error).message}`); }
  });

  app.post('/backups/run', async (_req, reply) => {
    try { return redirect(reply, `Создан архив ${await runBackup()}`); }
    catch (err) { return redirect(reply, `Ошибка: ${(err as Error).message}`); }
  });

  app.get('/backups/download/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const config = await getBackupConfig();
    try {
      const archive = await openBackupArchive(config.subdir, name);
      if (!archive) return reply.code(404).send('Архив не найден');
      return reply.header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .header('Content-Length', archive.size)
        .type('application/gzip').send(archive.stream);
    } catch (err) {
      if (['ENOENT', 'ELOOP'].includes((err as NodeJS.ErrnoException).code || '')) return reply.code(404).send('Архив не найден');
      throw err;
    }
  });
}
