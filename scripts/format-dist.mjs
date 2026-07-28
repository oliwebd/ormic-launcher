/* global console */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function formatSource(src) {
    // ── Pass 1: fix `}\nelse` / `}\ncatch` / `}\nfinally` → `} else` etc.
    let s = src.replace(/\}\n(\s+)(else|catch|finally)\b/g, '} $2');

    const lines = s.split('\n');
    const out = [];

    // Track indent depth to distinguish top-level from inside-class/function
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const next = lines[i + 1] ?? '';
        const nextTrimmed = next.trim();
        const prev = out[out.length - 1] ?? '';
        const prevTrimmed = prev.trim();

        // Count braces to track nesting depth (before pushing, so depth reflects
        // the depth of the CURRENT line's content when we decide on blanks below)
        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        const depthBefore = depth;
        depth += opens - closes;

        out.push(line);

        // Never insert after an already-blank line or before an already-blank next
        if (trimmed === '' || nextTrimmed === '') continue;

        // ── Top-level decisions (depth 0 after accounting for this line) ──────
        if (depthBefore === 0) {
            const nextIsImport = /^import\s/.test(nextTrimmed);
            const curIsImport = /^import\s/.test(trimmed);
            const nextIsExport = /^export\s/.test(nextTrimmed);
            const curIsExport = /^export\s/.test(trimmed);
            const nextIsClass = /^(export\s+)?(default\s+)?class\s/.test(nextTrimmed);
            const nextIsConst = /^(export\s+)?(const|let|var)\s/.test(nextTrimmed);
            const nextIsComment = /^\/\//.test(nextTrimmed);
            const nextIsBlock = /^\/\*/.test(nextTrimmed);
            const curIsConst = /^(export\s+)?(const|let|var)\s/.test(trimmed);

            // Blank between different import groups (e.g. gi:// vs resource:// vs relative)
            if (curIsImport && nextIsImport) {
                const curKind = importKind(trimmed);
                const nextKind = importKind(nextTrimmed);
                if (curKind !== nextKind) {
                    out.push('');
                    continue;
                }
            }

            // Blank after last import before anything else
            if (curIsImport && !nextIsImport) {
                out.push('');
                continue;
            }

            // Don't split consecutive related const/let/var blocks
            if (curIsConst && nextIsConst) continue;

            // Blank before class / export default class
            if (nextIsClass && prevTrimmed !== '') {
                out.push('');
                continue;
            }

            // Blank before top-level comment / JSDoc that follows a declaration
            if ((nextIsComment || nextIsBlock) && !curIsImport && prevTrimmed !== '') {
                if (!/^\/\//.test(trimmed) && !/^\/\*/.test(trimmed)) {
                    out.push('');
                    continue;
                }
            }

            // Blank before any export decl that follows a non-blank non-comment line
            if ((nextIsExport || nextIsConst) && !curIsImport) {
                if (!/^\/\//.test(trimmed) && !/^\/\*/.test(trimmed) && !/^export/.test(trimmed)) {
                    out.push('');
                }
            }
        }

        // ── Class-body decisions (depth 1 = inside a class) ──────────────────
        if (depthBefore === 1) {
            const curIsClosingBrace = /^\s+\}$/.test(line);
            const nextIsMethod = /^\s+[\w#].*\(.*\)\s*\{?\s*$/.test(next) && !/^\s+\//.test(next);
            const nextIsGetter = /^\s+(get|set)\s+\w/.test(next);
            const nextIsComment = /^\s+\/\//.test(next);
            const nextIsBlock = /^\s+\/\*/.test(next);
            const nextIsField = /^\s+[\w#_][\w]*\s*(=|;)/.test(next);

            // After a method body's closing brace, blank before next member
            if (curIsClosingBrace && depth === 1) {
                if (nextIsMethod || nextIsGetter || nextIsComment || nextIsBlock || nextIsField) {
                    out.push('');
                }
            }
        }
    }

    // ── Pass 3: collapse 3+ consecutive blank lines to max 2
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// Classify import source into groups for blank-line separation
function importKind(line) {
    const m = line.match(/from\s+['"]([^'"]+)['"]/);
    if (!m) return 'other';
    const src = m[1];
    if (src.startsWith('gi://')) return 'gi';
    if (src.startsWith('resource://')) return 'resource';
    if (src.startsWith('.')) return 'local';
    return 'other';
}

let _count = 0;

function processFile(filePath) {
    const original = readFileSync(filePath, 'utf8');
    const formatted = formatSource(original);
    if (formatted !== original) {
        writeFileSync(filePath, formatted, 'utf8');
        _count++;
    }
}

function walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.js')) processFile(full);
    }
}

walk('dist');
console.log(`format-dist: ${_count} file${_count === 1 ? '' : 's'} formatted.`);
