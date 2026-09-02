import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContextGauge, WorkspaceActions, WorkspacePanel } from "../src/client/components";
import { IdePanel } from "../src/client/IdePanel";
import { contextUsage } from "../src/shared/context";
import { DEFAULT_SETTINGS, EMPTY_LEDGER } from "../src/shared/models";
import { NO_GITHUB } from "../src/shared/protocol";
import { NO_WORKSPACE } from "../src/shared/workspace";
import { contextTokensAfterUsage, type Usage } from "../src/server/model";

const usage = (promptTokens: number): Usage => ({
  model: "claude-sonnet-4-5",
  in: promptTokens,
  cacheWrite: 0,
  cacheRead: 0,
  out: 10,
  promptTokens,
});

describe("context token accounting", () => {
  it("reports exact used and available tokens and clamps invalid values", () => {
    expect(contextUsage(42_250, 100_000)).toEqual({
      used: 42_250,
      limit: 100_000,
      available: 57_750,
      percent: 42.25,
    });
    expect(contextUsage(-20, 0)).toEqual({ used: 0, limit: 0, available: null, percent: 0 });
  });

  it("updates context from the main prompt but ignores auxiliary worker usage", () => {
    expect(contextTokensAfterUsage(38_000, usage(7_500), false)).toBe(38_000);
    expect(contextTokensAfterUsage(38_000, usage(7_500), true)).toBe(7_500);
    expect(contextTokensAfterUsage(38_000, usage(0), true)).toBe(0);
  });

  it("renders the exact count and reflects a refill immediately", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      context: { ...DEFAULT_SETTINGS.context, maxContextTokens: 100_000 },
    };
    const before = renderToStaticMarkup(createElement(ContextGauge, {
      context: { messages: 18, tokens: 82_500 },
      settings,
      cost: EMPTY_LEDGER,
    }));
    const after = renderToStaticMarkup(createElement(ContextGauge, {
      context: { messages: 7, tokens: 9_250 },
      settings,
      cost: EMPTY_LEDGER,
    }));

    expect(before).toContain("82,500 / 100,000 tokens");
    expect(before).toContain("17,500 available before compaction");
    expect(after).toContain("9,250 / 100,000 tokens");
    expect(after).toContain("90,750 available before compaction");
  });
});

describe("workspace and IDE", () => {
  it("places IDE immediately after Workspace in the chat actions", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceActions, {
      visible: true,
      onWorkspace: () => undefined,
      onIde: () => undefined,
    }));
    expect(html.indexOf(">Workspace<")).toBeGreaterThan(-1);
    expect(html.indexOf(">IDE<")).toBeGreaterThan(html.indexOf(">Workspace<"));
    expect(html).not.toContain(">Terminal<");
    expect(html).not.toContain("Code workspace");
  });

  it("keeps local and GitHub connections alongside the IDE", () => {
    const html = renderToStaticMarkup(createElement(WorkspacePanel, {
      workspace: NO_WORKSPACE,
      supported: true,
      hosting: false,
      canWrite: false,
      github: { ...NO_GITHUB, oauth: true },
      repos: null,
      reposLoading: false,
      onAttach: () => undefined,
      onDetach: () => undefined,
      onConnectGithub: () => undefined,
      onAuthGithub: () => undefined,
      onListRepos: () => undefined,
      onSignOutGithub: () => undefined,
      onRequest: async () => ({ ok: false, error: "not connected" }),
      canEdit: false,
      onClose: () => undefined,
    }));

    expect(html).toContain("A Folder On Your Computer");
    expect(html).toContain("A GitHub Repository");
    expect(html).toContain(">Connections<");
    expect(html).toContain(">IDE<");
    expect(html).toContain("Connect files or edit code in the same workspace.");
  });

  it("gives an unconnected IDE a direct path to workspace connections", () => {
    const html = renderToStaticMarkup(createElement(IdePanel, {
      embedded: true,
      workspace: NO_WORKSPACE,
      canEdit: false,
      onRequest: async () => ({ ok: false, error: "not connected" }),
      onClose: () => undefined,
      onOpenConnections: () => undefined,
    }));

    expect(html).toContain("Connect a workspace to begin.");
    expect(html).toContain(">Open Connections<");
    expect(html).toContain("Connect a workspace to edit code");
  });
});
