export const ACCENT_COLORS = {
    yellow: { accent: '#FAB84B', rgb: '250, 184, 75', hover: '#fccb7b', active: '#e5a43b' },
    blue:   { accent: '#3B82F6', rgb: '59, 130, 246',  hover: '#60A5FA', active: '#2563EB' },
    purple: { accent: '#8B5CF6', rgb: '139, 92, 246',  hover: '#A78BFA', active: '#7C3AED' },
    red:    { accent: '#EF4444', rgb: '239, 68, 68',   hover: '#F87171', active: '#DC2626' },
    green:  { accent: '#10B981', rgb: '16, 185, 129',  hover: '#34D399', active: '#059669' },
    pink:   { accent: '#EC4899', rgb: '236, 72, 153',  hover: '#F472B6', active: '#DB2777' },
    teal:   { accent: '#14B8A6', rgb: '20, 184, 166',  hover: '#2DD4BF', active: '#0D9488' },
    orange: { accent: '#F97316', rgb: '249, 115, 22',  hover: '#FB923C', active: '#EA580C' },
    slate:  { accent: '#64748B', rgb: '100, 116, 139', hover: '#94A3B8', active: '#475569' },
    brown:  { accent: '#A16207', rgb: '161, 98, 7',    hover: '#CA8A04', active: '#854D0E' },
    mixed:  { accent: '#64748B', rgb: '100, 116, 139', hover: '#94A3B8', active: '#475569' },
} as const;

export type AccentColorKey = keyof typeof ACCENT_COLORS;
export const ACCENT_COLOR_KEYS = new Set<string>(Object.keys(ACCENT_COLORS));
