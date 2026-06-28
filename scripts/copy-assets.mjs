// Копирует не-TS ассеты в dist после сборки (кросс-платформенно).
import { cp } from 'node:fs/promises';

await cp('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('✓ migrations скопированы в dist/db/migrations');
