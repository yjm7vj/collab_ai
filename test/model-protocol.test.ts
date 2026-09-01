import { describe, expect, it } from "vitest";

import { repairToolConversation } from "../src/server/model";

describe("tool conversation recovery", () => {
  it("keeps a complete client tool exchange unchanged", () => {
    const messages = [
      { role: "user" as const, content: "list files" },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "toolu_ok", name: "list_files", input: {} }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "toolu_ok", content: "src" }],
      },
    ];

    expect(repairToolConversation(messages)).toEqual({ messages, repaired: false });
  });

  it("repairs an orphan at messages.12 and preserves the user's retry", () => {
    const prefix = Array.from({ length: 6 }, (_, index) => [
      { role: "user" as const, content: `request ${index}` },
      { role: "assistant" as const, content: `response ${index}` },
    ]).flat();
    const result = repairToolConversation([
      ...prefix,
      {
        role: "assistant" as const,
        content: [{
          type: "tool_use" as const,
          id: "toolu_01XF56uT63yvQ73vUvLVv5gT",
          name: "list_files",
          input: {},
        }],
      },
      { role: "user" as const, content: "try again" },
    ]);

    expect(result.repaired).toBe(true);
    expect(result.messages.some((message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_use"),
    )).toBe(false);
    expect(result.messages.at(-1)).toEqual({ role: "user", content: "try again" });
  });

  it("does not require a result for a paused server tool", () => {
    const messages = [
      { role: "user" as const, content: "search" },
      {
        role: "assistant" as const,
        content: [{ type: "server_tool_use" as const, id: "srvtoolu_1", name: "web_search", input: {} }],
      },
    ];

    expect(repairToolConversation(messages)).toEqual({ messages, repaired: false });
  });
});
