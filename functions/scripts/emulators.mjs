#!/usr/bin/env node
// Levanta los emuladores (auth, firestore, storage, functions + UI) con el
// proyecto `demo-farmajyv` y persiste los datos en `.emulator-data/` al salir.
//
// Solo pasa `--import` si ya hay una exportación previa: el CLI falla cuando la
// carpeta no existe o está vacía, y así el primer arranque no necesita pasos extra.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = join(root, '.emulator-data');
const args = [
    'emulators:start',
    '--config', join(root, 'firebase.json'),
    '--project', 'demo-farmajyv',
    '--export-on-exit', dataDir,
];
if (existsSync(join(dataDir, 'firebase-export-metadata.json'))) {
    args.push('--import', dataDir);
}

const child = spawn('firebase', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
