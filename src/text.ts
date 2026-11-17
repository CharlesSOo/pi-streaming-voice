/**
 * Separator to put before a new transcript at the cursor, given the character
 * just before it: a space unless the cursor already follows whitespace or sits
 * at the start of a line.
 */
export function separatorBefore(charBefore: string, atLineStart: boolean): string {
  return atLineStart || charBefore === "" || /\s/.test(charBefore) ? "" : " ";
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function splitGraphemes(text: string): string[] {
  return Array.from(graphemes.segment(text), (s) => s.segment);
}

/**
 * Edit that turns `shown` (text just before the cursor) into `target`: delete
 * `backspaces` graphemes, then type `insert`. Keeps the common prefix, so a
 * growing transcript is a pure append.
 */
export function planReplace(shown: string, target: string): { backspaces: number; insert: string } {
  const a = splitGraphemes(shown);
  const b = splitGraphemes(target);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return { backspaces: a.length - common, insert: b.slice(common).join("") };
}
