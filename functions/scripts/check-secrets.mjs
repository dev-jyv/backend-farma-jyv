#!/usr/bin/env node
// Antes de `firebase deploy`: cada secreto de src/config/secrets.ts tiene que
// existir en el proyecto destino con su última versión habilitada.
//
// Sin este chequeo, un `firebase deploy` interactivo que no encuentra un secreto
// PIDE su valor en la terminal y lo crea al vuelo: se salta el orden de rotación
// (RUNBOOK «Secretos») y, si alguien solo pulsa Enter, despliega `api` con un valor
// basura. Aquí el deploy se detiene antes de subir nada y nombra el que falta.
//
// Uso: node scripts/check-secrets.mjs <dev|prod|proyecto>
// Solo consulta METADATOS (`functions:secrets:get` lista versiones y su estado);
// nunca lee ni imprime valores.
import { spawn } from 'node:child_process';
import { functionsDir, readSecretNames } from './secret-names.mjs';

const project = process.argv[2];
if (!project) {
    console.error('Uso: node scripts/check-secrets.mjs <dev|prod|proyecto>');
    process.exit(2);
}

const run = (args) =>
    new Promise((resolvePromise) => {
        const child = spawn('firebase', args, {
            cwd: functionsDir,
            shell: process.platform === 'win32',
        });
        let stdout = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.resume();
        child.on('error', (error) => resolvePromise({ code: 1, stdout: '', error }));
        child.on('close', (code) => resolvePromise({ code, stdout }));
    });

const checkSecret = async (name) => {
    const { code, stdout, error } = await run([
        'functions:secrets:get', name, '--project', project, '--json',
    ]);
    if (error) {
        return `${name}: no se pudo ejecutar firebase (${error.message})`;
    }
    let parsed = null;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        parsed = null;
    }
    if (code !== 0 || parsed?.status !== 'success') {
        const detail = parsed?.error ? String(parsed.error).split('\n')[0] : 'no existe o no hay acceso';
        return `${name}: ${detail}`;
    }
    const versions = parsed.result?.secrets ?? [];
    const latest = versions
        .slice()
        .sort((a, b) => Number(b.versionId) - Number(a.versionId))[0];
    if (!latest) {
        return `${name}: existe pero no tiene ninguna versión`;
    }
    if (latest.state !== 'ENABLED') {
        return `${name}: su última versión (${latest.versionId}) está ${latest.state}`;
    }
    return null;
};

const names = readSecretNames();
const problems = (await Promise.all(names.map(checkSecret))).filter(Boolean);

if (problems.length) {
    console.error(`Secretos faltantes o no verificables en Secret Manager de "${project}":`);
    problems.forEach((problem) => console.error(`  - ${problem}`));
    console.error(
        'Créalos antes de desplegar (RUNBOOK «Secretos»):\n' +
        `  firebase functions:secrets:set <NOMBRE> --project ${project}\n` +
        'El deploy se detuvo sin subir nada.',
    );
    process.exit(1);
}

console.log(`Secretos verificados en "${project}": ${names.join(', ')}`);
