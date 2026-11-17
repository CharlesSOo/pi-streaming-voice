/**
 * Text to insert for one finalized Deepgram segment, given the character just
 * before the cursor. Adds a separating space unless the cursor already follows
 * whitespace or sits at the start of a line.
 */
export function joinSegment(charBefore: string, text: string, atLineStart: boolean): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (atLineStart || charBefore === "" || /\s/.test(charBefore)) return trimmed;
  return ` ${trimmed}`;
}
