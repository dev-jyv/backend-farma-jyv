#!/usr/bin/env node
// Levanta todo el ecosistema FarmaJyV contra los EMULADORES locales:
//   emu    → emuladores (auth, firestore, storage, functions, UI en :4000)
//   build  → tsc --watch del backend (el emulador recarga lib/ al cambiar)
//   admin  → panel admin en :4200
//   clinic → consultorio en :4300
//   pos    → renderer del POS en :4400 (con --electron también abre Electron)
//
// Los repos hermanos se buscan junto a este (../farma-jyv-admin, etc.); el que no
// exista se omite. Ctrl+C detiene todos los procesos.
//
// Uso: npm run dev:all            (desde la raíz de backend-farma-jyv)
//      npm run dev:all -- --electron
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siblings = resolve(backend, '..');
const withElectron = process.argv.includes('--electron');

const tasks = [
    { name: 'emu', cwd: join(backend, 'functions'), cmd: 'npm', args: ['run', 'emulators'] },
    { name: 'build', cwd: join(backend, 'functions'), cmd: 'npm', args: ['run', 'build:watch'] },
    { name: 'admin', cwd: join(siblings, 'farma-jyv-admin'), cmd: 'npm', args: ['start'] },
    { name: 'clinic', cwd: join(siblings, 'farma-jyv-clinic'), cmd: 'npm', args: ['start'] },
    { name: 'pos', cwd: join(siblings, 'farma-jyv-pos'), cmd: 'npm', args: ['start'] },
];
if (withElectron) {
    tasks.push({ name: 'electron', cwd: join(siblings, 'farma-jyv-pos'), cmd: 'npm', args: ['run', 'electron:dev'] });
}

const colors = [36, 33, 35, 32, 34, 31];
const children = [];

tasks.forEach((task, index) => {
    if (!existsSync(join(task.cwd, 'package.json'))) {
        console.log(`[dev:all] se omite ${task.name}: no existe ${task.cwd}`);
        return;
    }
    const prefix = `\x1b[${colors[index % colors.length]}m[${task.name}]\x1b[0m `;
    const child = spawn(task.cmd, task.args, {
        cwd: task.cwd,
        env: { ...process.env, FORCE_COLOR: '1' },
        shell: process.platform === 'win32',
    });
    const pipe = (stream, out) => {
        let buffer = '';
        stream.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach((line) => out.write(prefix + line + '\n'));
        });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('exit', (code) => console.log(`${prefix}terminó (código ${code})`));
    children.push(child);
});

const stopAll = () => {
    children.forEach((child) => child.kill('SIGINT'));
    setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
