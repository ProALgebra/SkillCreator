import { rmSync } from 'node:fs';
rmSync(new URL('../dist/tui.jsx', import.meta.url), { force: true });
rmSync(new URL('../dist/tui.jsx.map', import.meta.url), { force: true });
