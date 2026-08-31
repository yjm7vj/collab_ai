import { isValidElement, type ReactNode } from "react";
import { inlineMarkdown } from "../src/client/markdown";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

/** Flatten the rendered nodes back to tagged text so cases read as strings. */
function render(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(render).join("");
  if (isValidElement(node)) {
    const tag = String(node.type);
    const { children } = node.props as { children?: ReactNode };
    return `<${tag}>${render(children)}</${tag}>`;
  }
  return "";
}

const cases: [string, string][] = [
  ["**bold**", "<strong>bold</strong>"],
  ["a **bold** b", "a <strong>bold</strong> b"],
  ["*italic*", "<em>italic</em>"],
  ["_italic_", "<em>italic</em>"],
  ["__bold__", "<strong>bold</strong>"],
  ["***both***", "<strong><em>both</em></strong>"],
  ["**bold *and italic***", "<strong>bold <em>and italic</em></strong>"],
  ["`code`", "<code>code</code>"],
  ["`a ** b`", "<code>a ** b</code>"],
  ["**`code` bold**", "<strong><code>code</code> bold</strong>"],
  ["multi\n**line**", "multi\n<strong>line</strong>"],
  // Plain text that must survive untouched.
  ["no markup here", "no markup here"],
  ["3 * 4 * 5", "3 * 4 * 5"],
  ["snake_case_name", "snake_case_name"],
  ["unclosed **bold", "unclosed **bold"],
  ["a * b", "a * b"],
  [String.raw`\*not italic\*`, "*not italic*"],
  ["**", "**"],
  ["****", "****"],
  ["-- a_b_c --", "-- a_b_c --"],
];

for (const [input, expected] of cases) {
  const actual = render(inlineMarkdown(input));
  assert(actual === expected, `inlineMarkdown(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// Agent text is never treated as markup.
const injected = render(inlineMarkdown("**<script>alert(1)</script>**"));
assert(injected === "<strong><script>alert(1)</script></strong>", `unexpected: ${injected}`);

console.log(`Inline Markdown check passed (${cases.length + 1} cases)`);
