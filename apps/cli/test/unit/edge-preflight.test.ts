import { describe, it, expect, vi } from "vitest";
import { planAndApplyHostEdge, type EdgePreflightDeps } from "../../src/lib/edge-preflight";

/** A blocked-edge EdgeStatus double (only `classification` is read by the code). */
function status(classification = "known") {
  return { classification, occupants: [{ command: "nginx", port: 80 }], canProceedClean: false } as any;
}

const tlsSite = {
  serverNames: ["a.com"],
  ssl: true,
  target: { kind: "proxy", url: "http://127.0.0.1:3000" },
  tls: { certPath: "/etc/ssl/a.crt", keyPath: "/etc/ssl/a.key" },
} as any;

/** Fully-faked deps; individual tests override what they assert on. */
function deps(over: Partial<EdgePreflightDeps> = {}): EdgePreflightDeps {
  return {
    platform: "linux",
    interactive: true,
    makeExecutor: () => ({}) as any,
    foreignProxyOnEdge: vi.fn(async () => ({ status: status(), blocked: true, owner: "nginx" })),
    importSites: vi.fn(async () => ({ sites: [tlsSite], warnings: [] })),
    beginEdgeTakeover: vi.fn(async () => {}),
    recoverInterruptedTakeover: vi.fn(async () => {}),
    ourEdgeContainerRunning: vi.fn(async () => false),
    readCert: vi.fn((p: string) => (p.endsWith(".crt") ? "CERT" : "KEY")),
    render: vi.fn(),
    confirm: vi.fn(async () => "cancel"),
    warn: vi.fn(),
    ...over,
  };
}

describe("planAndApplyHostEdge", () => {
  it("skips entirely on non-Linux hosts", async () => {
    const d = deps({ platform: "darwin" });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: true });
    expect(d.foreignProxyOnEdge).not.toHaveBeenCalled();
  });

  it("proceeds without prompting when the edge is free/ours", async () => {
    const d = deps({
      foreignProxyOnEdge: vi.fn(async () => ({ status: status("free"), blocked: false, owner: "" })),
    });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: true });
    expect(d.importSites).not.toHaveBeenCalled();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.beginEdgeTakeover).not.toHaveBeenCalled();
  });

  it("cancels (no take-over) when the user declines", async () => {
    const d = deps({ confirm: vi.fn(async () => "cancel") });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: false });
    expect(d.beginEdgeTakeover).not.toHaveBeenCalled();
  });

  it("takeover stops the proxy and carries no sites", async () => {
    const d = deps({ confirm: vi.fn(async () => "takeover") });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan.proceed).toBe(true);
    expect(plan.action).toBe("takeover");
    expect(plan.sites).toBeUndefined();
    expect(d.beginEdgeTakeover).toHaveBeenCalledTimes(1);
  });

  it("migrate stops the proxy, returns sites, and collects safe cert PEMs", async () => {
    const d = deps({ confirm: vi.fn(async () => "migrate") });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan.proceed).toBe(true);
    expect(plan.action).toBe("migrate");
    expect(plan.sites).toEqual([tlsSite]);
    expect(plan.certPems).toEqual({ "/etc/ssl/a.crt": { certPem: "CERT", keyPem: "KEY" } });
    expect(d.beginEdgeTakeover).toHaveBeenCalledTimes(1);
  });

  it("does not collect PEMs for unsafe cert paths", async () => {
    const unsafe = { ...tlsSite, tls: { certPath: "/etc/ssl/../$(x).crt", keyPath: "/etc/ssl/a.key" } };
    const d = deps({
      confirm: vi.fn(async () => "migrate"),
      importSites: vi.fn(async () => ({ sites: [unsafe], warnings: [] })),
    });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan.certPems).toEqual({});
    expect(d.readCert).not.toHaveBeenCalled();
  });

  it("stops the proxy through the JOURNALED path (so a failed bring-up can roll back)", async () => {
    const order: string[] = [];
    const d = deps({
      confirm: vi.fn(async () => "migrate"),
      beginEdgeTakeover: vi.fn(async () => {
        order.push("begin");
      }),
      importSites: vi.fn(async () => {
        order.push("import");
        return { sites: [tlsSite], warnings: [] };
      }),
    });
    await planAndApplyHostEdge({}, d);
    // beginEdgeTakeover journals then frees — the CLI must never call the raw
    // freeEdgeTargets, or a failed compose up leaves 80/443 dark with no record.
    expect(order).toEqual(["import", "begin"]);
  });

  it("restores an interrupted takeover BEFORE probing, and reports our edge health", async () => {
    const calls: string[] = [];
    const d = deps({
      recoverInterruptedTakeover: vi.fn(async (_e, _l, isEdgeHealthy) => {
        calls.push("recover");
        await isEdgeHealthy?.();
      }),
      ourEdgeContainerRunning: vi.fn(async () => {
        calls.push("edge-health");
        return false;
      }),
      foreignProxyOnEdge: vi.fn(async () => {
        calls.push("probe");
        return { status: status("free"), blocked: false, owner: "" };
      }),
    });
    await planAndApplyHostEdge({}, d);
    expect(calls).toEqual(["recover", "edge-health", "probe"]);
  });

  it("honors the --edge flag without prompting", async () => {
    const d = deps({ confirm: vi.fn() });
    const plan = await planAndApplyHostEdge({ edge: "cancel" }, d);
    expect(plan).toEqual({ proceed: false });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("defaults to cancel in a non-interactive run with no flag", async () => {
    const d = deps({ interactive: false, confirm: vi.fn() });
    const plan = await planAndApplyHostEdge({}, d);
    expect(plan).toEqual({ proceed: false });
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalled();
  });
});
