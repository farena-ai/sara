// 3.3.0 (ezplain): types for web/everyday-words.js (the server's settings guide imports it).
export interface EverydayEntry {
  id: string;
  page?: string;
  place?: string;
  title: string;
  how: string;
  words: string[];
}
export const EVERYDAY: EverydayEntry[];
export function everydayMatches(question: string): EverydayEntry[];
