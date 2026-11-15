// Types for web/a11y-check.js (R9, docs/ACCESSIBILITY.md).
export interface Finding { rule: string; where: string; detail?: string }
export interface A11yNode { tag: string; attrs: Record<string, string>; children: A11yNode[]; text?: string; parent: A11yNode | null; line?: number }
export function parseHtml(html: string): A11yNode;
export function fromDom(node: unknown, o?: { visible?: (el: unknown) => boolean }): A11yNode;
export function checkTree(root: A11yNode): Finding[];
export function checkHtml(html: string): Finding[];
export function themeVars(css: string, theme: string): Record<string, string>;
export function parseColor(v: string | undefined): [number, number, number, number] | null;
export function contrast(fg: number[], bg: number[]): number;
export const PAIRS: [string, string, number][];
export function checkContrast(css: string, theme: string): Finding[];
export function hasFocusVisible(css: string): boolean;
