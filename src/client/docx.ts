import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

function plainText(value: string): TextRun {
  return new TextRun({ text: value });
}

function markdownParagraphs(markdown: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  const flushCode = () => {
    if (!codeLines.length) return;
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: codeLines.join("\n"), font: "Consolas" })],
        spacing: { after: 140 },
      }),
    );
    codeLines = [];
  };

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = heading[1]!.length;
      paragraphs.push(
        new Paragraph({
          text: heading[2]!,
          heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          spacing: { before: 180, after: 90 },
        }),
      );
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      paragraphs.push(new Paragraph({ text: bullet[1]!, bullet: { level: 0 }, spacing: { after: 70 } }));
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numbered) {
      paragraphs.push(new Paragraph({ text: numbered[1]!, numbering: { reference: "shared-document-numbering", level: 0 }, spacing: { after: 70 } }));
      continue;
    }

    if (!line.trim()) {
      if (paragraphs.length) {
        paragraphs.push(new Paragraph({ text: "", spacing: { after: 60 } }));
      }
      continue;
    }

    paragraphs.push(new Paragraph({ children: [plainText(line)], spacing: { after: 110 } }));
  }

  if (inCode) flushCode();
  return paragraphs.length ? paragraphs : [new Paragraph({ text: "" })];
}

/** Convert the shared Markdown document into a standards-compliant DOCX blob. */
export async function documentToDocx(markdown: string): Promise<Blob> {
  const document = new Document({
    numbering: {
      config: [{ reference: "shared-document-numbering", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: "left" }] }],
    },
    sections: [{ children: markdownParagraphs(markdown) }],
  });
  return Packer.toBlob(document);
}

export async function downloadDocx(markdown: string, filename: string): Promise<void> {
  const blob = await documentToDocx(markdown);
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
