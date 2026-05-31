import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const rootDir = process.cwd();
const accentColorsTsPath = join(rootDir, 'accent-colors.ts');
const stylesheetCssPath = join(rootDir, 'stylesheet.css');

// Read the TS file and parse ACCENT_COLORS dynamically
const tsContent = readFileSync(accentColorsTsPath, 'utf8');
const jsContent = tsContent
    .replace(/export const ACCENT_COLORS =/, 'const ACCENT_COLORS =')
    .replace(/as const;[\s\S]*$/, '')
    .trim();

const ACCENT_COLORS = new Function(jsContent + '\nreturn ACCENT_COLORS;')();

function generateAccentBlock(name, c) {
    return `
/* ── ${name.charAt(0).toUpperCase() + name.slice(1)} ${'─'.repeat(60 - name.length)} */
.ormic-accent-${name} .ormic-entry { caret-color: ${c.accent}; }
.ormic-accent-${name} .ormic-result.selected { background-color: rgba(${c.rgb}, 0.09); }
.ormic-accent-${name} .ormic-result.selected .ormic-accent-bar { background-color: ${c.accent}; }
.ormic-accent-${name} .ormic-result.selected .ormic-name { color: ${c.accent}; }
.ormic-accent-${name} .ormic-fav-btn:hover { color: ${c.accent}; }
.ormic-accent-${name} .ormic-fav-btn.is-fav { color: ${c.accent}; }
.ormic-accent-${name} .ormic-fav-btn.is-fav:hover { background-color: rgba(${c.rgb}, 0.12); }
.ormic-accent-${name} .ormic-kbd-badge { color: rgba(${c.rgb}, 0.72); background-color: rgba(${c.rgb}, 0.07); border: 1px solid rgba(${c.rgb}, 0.18); }
.ormic-accent-${name} .ormic-result.selected .ormic-kbd-badge { border-color: ${c.accent}; }
.ormic-accent-${name} .ormic-grid-item.selected { border-color: rgba(${c.rgb}, 0.32); }
.ormic-accent-${name} .ormic-category-tab.active { border-color: rgba(${c.rgb}, 0.85); }
.ormic-accent-${name} .ormic-editor-entry { caret-color: ${c.accent}; }
.ormic-accent-${name} .ormic-editor-entry:focus { border-color: ${c.accent}; }
.ormic-accent-${name} .ormic-editor-btn.save-btn { background-color: ${c.accent}; border: 1px solid ${c.accent}; }
.ormic-accent-${name} .ormic-editor-btn.save-btn:hover { background-color: ${c.hover}; border-color: ${c.hover}; }
.ormic-accent-${name} .ormic-edit-row.selected { background-color: rgba(${c.rgb}, 0.06); border-color: rgba(${c.rgb}, 0.14); }
.ormic-accent-${name} .ormic-edit-row.selected .ormic-edit-checkbox { color: ${c.accent}; }
.ormic-accent-${name} .ormic-prompt-entry { caret-color: ${c.accent}; }
.ormic-accent-${name} .ormic-prompt-entry:focus { border-color: ${c.accent}; }
.ormic-accent-${name} .ormic-prompt-btn.create-btn { background-color: ${c.accent}; border: 1px solid ${c.accent}; }
.ormic-accent-${name} .ormic-prompt-btn.create-btn:hover { background-color: ${c.hover}; border-color: ${c.hover}; }
.ormic-accent-${name} .ormic-prompt-btn.create-btn:active { background-color: ${c.active}; border-color: ${c.active}; }
.ormic-accent-${name} .ormic-tip-key { color: rgba(${c.rgb}, 0.80); background-color: rgba(${c.rgb}, 0.09); }
`.trimStart();
}

// Read the static part of stylesheet.css (everything before the accent section)
const staticCss = readFileSync(stylesheetCssPath, 'utf8');
const marker = '/* ═══════════════════════════════════════════════════════════════════════════\n   Dynamic Accent Color Overrides';
const markerIndex = staticCss.indexOf(marker);

if (markerIndex === -1) {
    throw new Error('Could not find dynamic accent color overrides marker in stylesheet.css');
}

const staticPart = staticCss.substring(0, markerIndex);

// Generate dynamic part
const dynamicPart = [
    `/* ═══════════════════════════════════════════════════════════════════════════
   Dynamic Accent Color Overrides — generated, do not edit manually
   Each .ormic-accent-{color} class on the overlay triggers these rules.
   ═══════════════════════════════════════════════════════════════════════════ */
`,
    ...Object.entries(ACCENT_COLORS).map(([name, c]) => generateAccentBlock(name, c))
].join('\n');

writeFileSync(stylesheetCssPath, staticPart + dynamicPart, 'utf8');
console.log(`Generated accent CSS for ${Object.keys(ACCENT_COLORS).length} colors.`);
