#!/usr/bin/env node
// Lista en el resumen del run los PRs con la etiqueta `requiere-paso-manual`
// incluidos desde el tag anterior (SPEC 39, requisito 6). Corre en un job previo
// al de producción, así que el aprobador lo ve ANTES de aprobar. No hay otro
// registro: aprobar es confirmar que esos pasos se hicieron.
//
// Solo lee (git local + `gh pr list`). Si no puede leer los PRs, falla: una
// lista vacía por error haría creer que no hay nada pendiente.
//
// Entorno (lo pone GitHub Actions): GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF_NAME,
// GITHUB_STEP_SUMMARY, GH_TOKEN. Requiere checkout con `fetch-depth: 0`.
// Para probarlo en local: MANUAL_STEPS_LABEL (otra etiqueta) y PREVIOUS_REF (un
// commit en lugar del tag anterior).
// Archivo idéntico en backend-farma-jyv y farma-jyv-admin.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const LABEL = process.env.MANUAL_STEPS_LABEL || 'requiere-paso-manual';
const STEP_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:paso manual|runbook)(?:\*\*)?\s*:\s*(.+)$/im;
const SECTION_REF = /§\s?\d+[a-z]?/gi;

const repo = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const tag = process.env.GITHUB_REF_NAME ?? sha;
if (!repo || !sha) {
    console.error('::error::Faltan GITHUB_REPOSITORY o GITHUB_SHA.');
    process.exit(1);
}

const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
const isAncestor = (ancestor, of) => {
    try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, of], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};
const hasCommit = (oid) => {
    try {
        execFileSync('git', ['cat-file', '-e', `${oid}^{commit}`], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

const findPreviousTag = () => {
    try {
        return git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${sha}^`);
    } catch {
        return null; // primer tag del repo: se revisa toda la historia
    }
};
const previousTag = process.env.PREVIOUS_REF || findPreviousTag();

const search = previousTag
    ? `merged:>=${git('log', '-1', '--format=%cs', previousTag)}`
    : '';
const prs = JSON.parse(execFileSync('gh', [
    'pr', 'list',
    '--repo', repo,
    '--state', 'merged',
    '--label', LABEL,
    '--limit', '500',
    '--json', 'number,title,url,body,mergeCommit,mergedAt',
    ...(search ? ['--search', search] : []),
], { encoding: 'utf8' }));

// El filtro por fecha es grueso (día); el corte exacto es la ascendencia.
const included = prs
    .filter(({ mergeCommit }) => mergeCommit?.oid && hasCommit(mergeCommit.oid))
    .filter(({ mergeCommit }) => isAncestor(mergeCommit.oid, sha))
    .filter(({ mergeCommit }) => !previousTag || !isAncestor(mergeCommit.oid, previousTag))
    .sort((a, b) => a.number - b.number);

const stepOf = (body) => {
    const text = body ?? '';
    const line = text.match(STEP_LINE)?.[1]?.trim();
    if (line) return line;
    const refs = [...new Set(text.match(SECTION_REF) ?? [])];
    if (refs.length) return `RUNBOOK ${refs.join(', ')}`;
    return '**No indicado en el PR — ábrelo y confirma el paso antes de aprobar.**';
};
const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const range = previousTag ? `${previousTag}..${tag}` : `inicio..${tag}`;
const lines = [`## Pasos manuales antes de liberar ${tag}`, ''];
if (!included.length) {
    lines.push(`Ningún PR con la etiqueta \`${LABEL}\` en ${range}.`);
} else {
    lines.push(
        `**${included.length} PR(s) con \`${LABEL}\` en ${range}.** ` +
        'Confirma que cada paso se hizo en producción **antes** de aprobar el environment ' +
        '`production` (RUNBOOK §8). Aprobar es la confirmación; no hay otro registro.',
        '',
        '| PR | Título | Paso del RUNBOOK |',
        '|---|---|---|',
        ...included.map((pr) => `| [#${pr.number}](${pr.url}) | ${cell(pr.title)} | ${cell(stepOf(pr.body))} |`),
    );
}
const markdown = `${lines.join('\n')}\n`;

console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
if (included.length) {
    console.log(`::warning::${included.length} PR(s) con ${LABEL} en ${range}; ver el resumen del run.`);
}
