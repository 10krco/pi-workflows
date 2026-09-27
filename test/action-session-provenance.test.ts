import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { action, defineWorkflow, manualEffect } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import { WorkflowRunStore } from "../src/workflows/store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

const workflow = defineWorkflow({
  name: "session-provenance-probe",
  startAt: "inspect",
  nodes: {
    inspect: action({
      effect: manualEffect("test.session-provenance"),
      run: ({ originSessionId, input }) => ({
        claimedSessionId: (input as { originSessionId?: string }).originSessionId ?? null,
        actualSessionId: originSessionId ?? null,
      }),
    }),
  },
  edges: [],
});

async function observe(claimed: string, bound?: string | null) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-workflows-session-provenance-"));
  directories.push(dir);
  const store = new WorkflowRunStore(path.join(dir, "runs.sqlite"));
  try {
    const engine = new WorkflowEngine({
      store,
      executor: {
        runAgentStep: () => {
          throw new Error("no model");
        },
      } as never,
      ...(bound === undefined ? {} : { originSessionId: bound }),
    });
    const run = await engine.run(workflow, { originSessionId: claimed });
    return { status: run.state.status, final: run.state.finalOutput };
  } finally {
    store.close();
  }
}

describe("action context Pi session provenance", () => {
  it("passes only the server-bound identity, never a claimed identity from input", async () => {
    expect(await observe("fabricated", "trusted-session")).toMatchObject({
      status: "completed",
      final: {
        claimedSessionId: "fabricated",
        actualSessionId: "trusted-session",
      },
    });
    expect(await observe("fabricated")).toMatchObject({
      status: "completed",
      final: {
        claimedSessionId: "fabricated",
        actualSessionId: null,
      },
    });
  });
  it("rejects malformed trusted options", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-workflows-invalid-session-"));
    directories.push(dir);
    const store = new WorkflowRunStore(path.join(dir, "runs.sqlite"));
    try {
      expect(
        () => new WorkflowEngine({ store, executor: {} as never, originSessionId: "  " }),
      ).toThrow(/Invalid workflow origin/);
    } finally {
      store.close();
    }
  });
});
