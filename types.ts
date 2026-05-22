// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Common Types

export interface SearchResult {
    id: string;
    desktopId?: string;
    name: string;
    description: string;
    score: number;
    providerPriority: number;   // secondary sort key
    icon?: any;                 // pre-rendered Clutter texture
    createIcon?: (size: number) => any; // function to lazily create the icon
    iconName?: string;          // symbolic fallback
    categoryIcon: string;
    category: string;           // right-pill label: "App", "Web", "Window", …
    activate: () => void;
}
