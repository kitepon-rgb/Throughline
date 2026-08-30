#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractMarkdownTargets } from './verify-pack-markdown-links.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRECTORIES = new Set(['.git', '.lattice', 'node_modules']);
const COMPATIBILITY_STUBS = Object.freeze({
  '12_desktop_clear_handoff_plan.md': 'archive/12_desktop_clear_handoff_plan.md',
  '15_windows_ci_release_latency_plan.md': 'archive/15_windows_ci_release_latency_plan.md',
  '16_readonly_handoff_context_plan.md': 'archive/16_readonly_handoff_context_plan.md',
  'plan_grok-successor-launch.md': 'archive/plan_grok-successor-launch.md',
});

export function verifyDocs(root = DEFAULT_ROOT) {
  const errors = [];
  const markdownFiles = collectMarkdown(root);
  for (const file of markdownFiles) verifyLocalLinks(file, errors);

  const docsRoot = join(root, 'docs');
  const overviewPath = join(docsRoot, '00_overview.md');
  const overview = readFileSync(overviewPath, 'utf8');
  for (const name of readdirSync(docsRoot).filter((name) => extname(name) === '.md' && name !== '00_overview.md')) {
    if (!overview.includes(`](${name})`)) errors.push(`docs/00_overview.md: 未分類のtop-level文書 ${name}`);
  }

  const archiveRoot = join(docsRoot, 'archive');
  const archiveIndexPath = join(archiveRoot, 'README.md');
  const archiveIndex = readFileSync(archiveIndexPath, 'utf8');
  const archiveNames = readdirSync(archiveRoot)
    .filter((name) => extname(name) === '.md' && name !== 'README.md');
  for (const name of archiveNames) {
    if (!archiveIndex.includes(`](${name})`)) errors.push(`docs/archive/README.md: 未索引のarchive文書 ${name}`);
  }

  const requiredStubs = new Map(Object.entries(COMPATIBILITY_STUBS));
  for (const fixedPath of fixedDocumentReferences(join(root, '.lattice'))) {
    if (!fixedPath.startsWith('docs/') || fixedPath.startsWith('docs/archive/')) continue;
    const name = fixedPath.slice('docs/'.length);
    if (name.includes('/') || !existsSync(join(archiveRoot, name))) continue;
    requiredStubs.set(name, `archive/${name}`);
  }

  for (const [name, archiveTarget] of requiredStubs) {
    const path = join(docsRoot, name);
    if (!existsSync(path)) {
      errors.push(`docs/${name}: 固定参照用stubがない`);
      continue;
    }
    const source = readFileSync(path, 'utf8');
    if (!source.includes(`](${archiveTarget})`)) errors.push(`docs/${name}: archiveへの案内がない`);
    if (Buffer.byteLength(source) > 2_000) errors.push(`docs/${name}: 互換stubが2,000 bytesを超えている`);
  }

  return {
    errors,
    markdownCount: markdownFiles.length,
    archiveCount: archiveNames.length,
    stubCount: requiredStubs.size,
  };
}

function collectMarkdown(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && extname(entry.name) === '.md') files.push(path);
    }
  };
  visit(root);
  return files;
}

function verifyLocalLinks(file, errors) {
  const source = readFileSync(file, 'utf8');
  for (const link of extractMarkdownTargets(source)) {
    const target = normalizeTarget(link.raw);
    if (target === null) continue;
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) {
      errors.push(`${relative(DEFAULT_ROOT, file)}:${link.line}: link切れ ${link.raw}`);
    }
  }
}

function fixedDocumentReferences(directory) {
  if (!existsSync(directory)) return [];
  const references = new Set();
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).size <= 1_000_000) {
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/docs\/[A-Za-z0-9_./-]+\.md/g)) references.add(match[0]);
      }
    }
  };
  visit(directory);
  return [...references];
}

function normalizeTarget(raw) {
  let target = raw.trim();
  if (!target || target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  target = target.split('#', 1)[0].split('?', 1)[0];
  if (!target) return null;
  try { return decodeURIComponent(target); } catch { return target; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyDocs();
  if (result.errors.length > 0) {
    process.stderr.write(`${result.errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`docs verified: ${result.markdownCount} Markdown, ${result.archiveCount} archive entries, ${result.stubCount} compatibility stubs\n`);
  }
}
