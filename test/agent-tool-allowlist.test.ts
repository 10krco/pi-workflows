import { describe, expect, it, vi } from "vitest";
import { compileWorkflowDefinition } from "../src/workflows/composition.js";
import {
  agent,
  assistantMessage,
  compute,
  defineWorkflow,
  includeWorkflow,
} from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { createDefinitionSnapshot, WorkflowRunStore } from "../src/workflows/store.js";
import { makeStateDatabasePath, ScriptedExecutor } from "./helpers.js";

describe("agent tool allowlists", () => {
  it.each(
    ["read", [""], ["read", "read"], ["workflow"], ["read", 1], ["bash; rm"]].map(
      (allowedTools) => ({ allowedTools }),
    ),
  )("rejects malformed or ambiguous names: $allowedTools", ({ allowedTools }) => {
    expect(() => agent({ prompt: () => "Inspect", allowedTools: allowedTools as never })).toThrow(
      /allowedTools/,
    );
  });

  it("passes the exact allowlist in the durable request and prompt", async () => {
    const executor = new ScriptedExecutor().respond("inspect", {
      output: { inspected: true },
    });
    const workflow = defineWorkflow({
      name: "restricted-agent",
      startAt: "inspect",
      nodes: {
        inspect: agent({ prompt: () => "Inspect", allowedTools: ["read", "list_sessions"] }),
      },
      edges: [],
    });
    const { state } = await new WorkflowEngine({
      executor,
      databasePath: await makeStateDatabasePath("restricted-agent"),
    }).run(workflow, {});
    expect(state.status).toBe("completed");
    expect(executor.requests[0]?.contract.allowedTools).toEqual(["read", "list_sessions"]);
    expect(executor.requests[0]?.prompt).toContain(
      'permits only these tools: ["read","list_sessions"]',
    );
  });

  it.each([false, true])(
    "preserves restrictions in child graphs and their definition snapshots (assistant=%s)",
    (assistant) => {
      const child = defineWorkflow({
        name: "restricted-child",
        startAt: "inspect",
        nodes: {
          inspect: assistant
            ? agent({
                prompt: () => "Inspect",
                allowedTools: ["read"],
                expectedOutput: assistantMessage(),
              })
            : agent({ prompt: () => "Inspect", allowedTools: ["read"] }),
        },
        edges: [],
        exits: { done: { from: "inspect", validate: (value: unknown) => value } },
      });
      const parent = defineWorkflow({
        name: "restricted-parent",
        startAt: "start",
        nodes: {
          start: compute({ run: () => ({}) }),
        },
        includes: { child: includeWorkflow(child) },
        edges: [{ from: "start", to: "child" }],
      });
      const compiled = compileWorkflowDefinition(parent);
      expect(compiled.nodes["child/inspect"]).toMatchObject({ allowedTools: ["read"] });
      const snapshot = createDefinitionSnapshot(compiled);
      expect(snapshot.nodes["child/inspect"]).toMatchObject({ allowedTools: ["read"] });
      child.nodes.inspect.allowedTools = [];
      expect(createDefinitionSnapshot(compileWorkflowDefinition(parent))).not.toEqual(snapshot);
    },
  );

  it("binds passive terminal delivery to the editable root definition and stored run", async () => {
    const workflow = defineWorkflow({
      name: "passive-terminal",
      terminalTurn: "notify",
      startAt: "inspect",
      nodes: { inspect: agent({ prompt: () => "Inspect", allowedTools: [] }) },
      edges: [],
    });
    expect(createDefinitionSnapshot(compileWorkflowDefinition(workflow)).terminalTurn).toBe(
      "notify",
    );
    expect(() =>
      defineWorkflow({
        ...workflow,
        name: "invalid-terminal",
        terminalTurn: "unrestricted" as never,
      }),
    ).toThrow(/terminalTurn must be model or notify/);
    const databasePath = await makeStateDatabasePath("passive-terminal");
    const executor = new ScriptedExecutor().respond("inspect", { output: "done" });
    const { state } = await new WorkflowEngine({ executor, databasePath }).run(workflow, {});
    expect(state.status).toBe("completed");
    const store = new WorkflowRunStore(databasePath);
    try {
      expect(store.readTerminalData(state.runId)?.terminalTurn).toBe("notify");
    } finally {
      store.close();
    }
    expect(
      createDefinitionSnapshot(
        compileWorkflowDefinition({
          ...workflow,
          terminalTurn: "model",
        }),
      ).terminalTurn,
    ).toBe("model");
  });

  it("fails before calling an executor that cannot enforce restrictions", async () => {
    const runAgentStep = vi.fn();
    const workflow = defineWorkflow({
      name: "unsupported-allowlist",
      startAt: "inspect",
      nodes: {
        inspect: agent({ prompt: () => "Inspect", allowedTools: [] }),
      },
      edges: [],
    });
    const { state } = await new WorkflowEngine({
      executor: { runAgentStep },
      databasePath: await makeStateDatabasePath("unsupported-allowlist"),
    }).run(workflow, {});
    expect(state.status).toBe("failed");
    expect(state.error).toContain("cannot enforce the agent tool allowlist");
    expect(runAgentStep).not.toHaveBeenCalled();
  });
});
