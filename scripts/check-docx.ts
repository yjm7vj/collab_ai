import { documentToDocx } from "../src/client/docx";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const blob = await documentToDocx("# Hello\n\n- one\n- two\n\n```ts\nconst answer = 42;\n```");
const bytes = new Uint8Array(await blob.arrayBuffer());
assert(bytes.length > 1000, "DOCX output is unexpectedly small");
assert(bytes[0] === 0x50 && bytes[1] === 0x4b, "DOCX output is not a ZIP package");
console.log("DOCX smoke check passed");
