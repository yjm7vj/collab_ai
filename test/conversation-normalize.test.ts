/**
 * The stored conversation after a replayed round.
 *
 * A room evicted mid-round is picked back up from storage, and the round it
 * resumes may already be recorded — so the same `tool_use` block, or a second
 * result for it, can end up in the history a second time. Anthropic rejects
 * the whole request when that happens ("each tool_use must have a single
 * result"), and because the bad state is what was persisted, every later turn
 * in that room fails the same way until something removes the copy.
 *
 * The shape that used to survive is the one below: not a duplicate inside one
 * message, but a duplicate a few messages later, where each half still looks
 * well-formed on its own.
 */
import { describe, expect, it } from "vitest";

import { normalizeConversation } from "../src/server/room";
import { repairToolConversation } from "../src/server/model";

const ID = "toolu_01SRz81Vso59SASs2wBK92zo";

const call = (id: string) => ({
  role: "assistant" as const,
  content: [
    { type: "thinking" as const, thinking: "…", signature: "sig" },
    { type: "tool_use" as const, id, name: "edit_file", input: { path: "src/app.ts" } },
  ],
});

const answer = (id: string) => ({
  role: "user" as const,
  content: [{ type: "tool_result" as const, tool_use_id: id, content: "edited" }],
});

describe("conversation normalization", () => {
  it("leaves a well-formed exchange alone", () => {
    const convo = [{ role: "user" as const, content: "edit it" }, call(ID), answer(ID)];
    // Identity, not just equality: `#convo` writes back only when this differs.
    expect(normalizeConversation(convo)).toBe(convo);
  });

  it("does not read a result as a duplicate of the call it answers", () => {
    const convo = [call(ID), answer(ID), call("toolu_second"), answer("toolu_second")];
    expect(normalizeConversation(convo)).toBe(convo);
  });

  it("drops a tool call replayed into a later message", () => {
    const convo = [
      { role: "user" as const, content: "edit it" },
      call(ID),
      answer(ID),
      call(ID),
      answer(ID),
    ];

    const normalized = normalizeConversation(convo);
    const uses = normalized.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_use")
        : [],
    );
    expect(uses).toHaveLength(1);

    // What is left of the replayed round is a result with nothing to answer,
    // which is the case `repairToolConversation` already knows how to clear.
    const { messages } = repairToolConversation(normalized);
    const results = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_result")
        : [],
    );
    expect(results).toHaveLength(1);
  });

  it("drops a second result for a call already answered", () => {
    const normalized = normalizeConversation([call(ID), answer(ID), answer(ID)]);
    // The repeated result was the message's only block, so the message goes
    // too — the API rejects an empty content array.
    expect(normalized).toHaveLength(2);
  });

  it("keeps the text a duplicated block was sitting next to", () => {
    const normalized = normalizeConversation([
      call(ID),
      answer(ID),
      {
        role: "user" as const,
        content: [
          { type: "tool_result" as const, tool_use_id: ID, content: "edited" },
          { type: "text" as const, text: "[Ada]: does that build?" },
        ],
      },
    ]);

    expect(normalized.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "[Ada]: does that build?" }],
    });
  });
});
