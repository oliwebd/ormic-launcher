/* global console */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function formatSource(src) {
    const lines = src.split('\n');
    const out = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const next = lines[i + 1] ?? '';
        const prev = out[out.length - 1] ?? '';

        out.push(line);

        // Skip if current line is already blank or next is blank
        if (line.trim() === '' || next.trim() === '') continue;

        // Blank line BEFORE top-level export function / export class / export const (function expr)
        const isTopLevelDecl =
            /^export\s+(function|class|async\s+function)/.test(next) ||
            /^export\s+const\s+\w+\s*=\s*(async\s*)?\(/.test(next) ||
            /^export\s+const\s+\w+\s*=\s*(async\s*)?function/.test(next);

        // Blank line BEFORE JSDoc block at top level
        const isJsDoc = /^\/\*\*/.test(next) && !/^\s/.test(next);

        // Blank line BEFORE top-level comment at top level
        const isTopLevelComment = /^\/\//.test(next) && !/^\s/.test(next);

        // Blank line after closing brace of a top-level function/class body
        const isClosingBrace = /^\}$/.test(line);

        if (isClosingBrace && (isTopLevelDecl || isJsDoc || isTopLevelComment)) {
            out.push('');
            continue;
        }

        if (isTopLevelDecl || isJsDoc) {
            // Only add blank line if previous non-blank line isn't already producing one
            if (prev.trim() !== '' && !/^\/\*\*/.test(line) && !/^\/\//.test(line)) {
                out.push('');
            }
        }
    }

    // Normalize: never more than 2 consecutive blank lines
    return out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
}

function processFile(filePath) {
    const original = readFileSync(filePath, 'utf8');
    const formatted = formatSource(original);
    if (formatted !== original) {
        writeFileSync(filePath, formatted, 'utf8');
        console.log(`  formatted: ${filePath}`);
    }
}

function walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.js')) processFile(full);
    }
}

console.log('Running format-dist...');
walk('dist');
console.log('Done.');
