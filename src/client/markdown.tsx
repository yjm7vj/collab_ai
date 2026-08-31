import { type ReactNode } from "react";

/**
 * The agent writes Markdown whether or not anyone asked it to, so its prose
 * arrives full of `**emphasis**` that would otherwise read as literal
 * asterisks. This renders the inline subset that actually shows up in chat —
 * bold, italic and code spans — and nothing else: the surrounding blocks keep
 * `white-space: pre-wrap`, so block constructs (headings, lists, fences) are
 * already laid out correctly as plain text and are left alone.
 *
 * Output is React nodes, never HTML, so agent text can never inject markup.
 */

/** Delimiters that a backslash can escape, as in `\*not italic\*`. */
const ESCAPABLE = "*_`\\";

/** How deep emphasis may nest before we stop looking and emit plain text. */
const MAX_DEPTH = 4;

export function inlineMarkdown(text: string, depth = 0): ReactNode {
  if (depth >= MAX_DEPTH || !hasMarkup(text)) return text;

  const out: ReactNode[] = [];
  let plain = "";
  let i = 0;
  let key = 0;

  const flush = () => {
    if (plain) out.push(plain);
    plain = "";
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && ESCAPABLE.includes(text[i + 1] ?? "")) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const span = codeSpan(text, i);
      if (span) {
        flush();
        out.push(<code key={key++}>{span.body}</code>);
        i = span.end;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const run = text[i + 1] === ch ? 2 : 1;
      const span = emphasis(text, i, ch, run);
      if (span) {
        flush();
        const inner = inlineMarkdown(span.body, depth + 1);
        out.push(
          run === 2 ? <strong key={key++}>{inner}</strong> : <em key={key++}>{inner}</em>,
        );
        i = span.end;
        continue;
      }
    }

    plain += ch;
    i += 1;
  }

  flush();
  return out.length === 1 && typeof out[0] === "string" ? out[0] : out;
}

/** Cheap pre-check: most agent sentences carry no markup at all. */
function hasMarkup(text: string): boolean {
  return text.includes("*") || text.includes("_") || text.includes("`") || text.includes("\\");
}

/**
 * A code span opened at `start`: a run of N backticks closed by a run of
 * exactly N. Its body is never re-parsed, so `**` inside code stays literal.
 */
function codeSpan(text: string, start: number): { body: string; end: number } | null {
  let open = start;
  while (text[open] === "`") open += 1;
  const fence = open - start;

  for (let i = open; i < text.length; i += 1) {
    if (text[i] !== "`") continue;
    let close = i;
    while (text[close] === "`") close += 1;
    if (close - i === fence) {
      const body = text.slice(open, i);
      return body.trim() ? { body, end: close } : null;
    }
    i = close - 1;
  }
  return null;
}

/**
 * An emphasis span opened at `start` with `run` copies of `delim`. Follows the
 * flanking rules that keep arithmetic and snake_case intact: the delimiters
 * must hug non-space text, and `_` must not sit inside a word.
 */
function emphasis(
  text: string,
  start: number,
  delim: string,
  run: number,
): { body: string; end: number } | null {
  const open = start + run;
  if (isSpace(text[open])) return null;
  if (delim === "_" && isWordChar(text[start - 1])) return null;

  for (let i = open; i < text.length; i += 1) {
    // A code span inside the emphasis is opaque: skip past it so its
    // backticked `*` cannot close us early.
    if (text[i] === "`") {
      const span = codeSpan(text, i);
      if (span) {
        i = span.end - 1;
        continue;
      }
    }
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] !== delim) continue;

    let close = i;
    while (text[close] === delim) close += 1;
    if (close - i < run) {
      i = close - 1;
      continue;
    }
    // The closing run's *last* `run` delimiters are ours; any surplus belongs
    // to nesting inside us, so `***both***` becomes bold wrapping italic.
    const body = text.slice(open, close - run);
    if (!body || isSpace(body[body.length - 1])) {
      i = close - 1;
      continue;
    }
    if (delim === "_" && isWordChar(text[close])) {
      i = close - 1;
      continue;
    }
    return { body, end: close };
  }
  return null;
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w]/.test(ch);
}
