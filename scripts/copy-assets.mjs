// Копирует не-TS ассеты в dist после сборки (кросс-платформенно).
import { chmod, cp, readdir } from 'node:fs/promises';

await cp('src/db/migrations', 'dist/db/migrations', { recursive: true });
// Git checkout может работать со строгой umask. В runtime SQL читает
// непривилегированный пользователь app, поэтому права исходников не наследуем.
await chmod('dist/db/migrations', 0o755);
for (const file of await readdir('dist/db/migrations')) {
  await chmod(`dist/db/migrations/${file}`, 0o644);
}
console.log('✓ migrations скопированы в dist/db/migrations');
