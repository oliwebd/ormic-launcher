// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Common Types

export interface SearchResult {
    id: string;
    desktopId?: string;
    name: string;
    description: string;
    score: number;
    providerPriority: number;
    icon?: any;
    createIcon?: (size: number) => any;
    iconName?: string;
    categoryIcon: string;
    category: string;
    activate: () => void;
}
