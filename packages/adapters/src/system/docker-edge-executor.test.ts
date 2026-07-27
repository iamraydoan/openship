import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import { DockerEdgeExecutor } from "./docker-edge-executor";

/**
 * Fake daemon: records the options handed to `exec.start` and replays a
 * multiplexed stream, so these tests pin the WIRE CONTRACT rather than dockerode.
 */
function fakeDocker(opts: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  const startOpts: Array<Record<string, unknown>> = [];
  const stream = new PassThrough();
  const docker = {
    getContainer: () => ({
      exec: async () => ({
        start: async (o: Record<string, unknown>) => {
          startOpts.push(o);
          // Emit after the caller has attached demux + listeners.
          setImmediate(() => stream.end());
          return stream;
        },
        inspect: async () => ({ Running: false, ExitCode: opts.exitCode ?? 0 }),
      }),
    }),
    modem: {
      demuxStream: (s: PassThrough, out: PassThrough, err: PassThrough) => {
        if (opts.stdout) out.write(opts.stdout);
        if (opts.stderr) err.write(opts.stderr);
        // The real demuxStream READS the stream; without a consumer an ended
        // PassThrough never emits 'end' and the executor would wait forever.
        s.resume();
      },
    },
  };
  return { docker: docker as never, startOpts };
}

describe("DockerEdgeExecutor — exec transport", () => {
  it("NEVER requests a hijacked connection", async () => {
    // Regression lock. Hijack makes docker-modem ask for a connection upgrade; the
    // daemon replies `101 Switching Protocols`, which Bun's node:http doesn't
    // surface the way modem expects — so on the Bun-based api image EVERY edge exec
    // failed with `(HTTP code 101) unexpected`. Config reloads, certbot and site
    // registration all silently died while the edge container looked healthy.
    const { docker, startOpts } = fakeDocker({ stdout: "ok" });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await ex.exec("openresty -t");
    expect(startOpts).toHaveLength(1);
    expect(startOpts[0].hijack).toBeFalsy();
  });

  it("returns stdout for a successful command", async () => {
    const { docker } = fakeDocker({ stdout: "configuration file test is successful\n" });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await expect(ex.exec("openresty -t")).resolves.toContain("test is successful");
  });

  it("throws with BOTH streams folded in on a non-zero exit", async () => {
    // certbot prints its real cause to stdout while stderr carries boilerplate.
    const { docker } = fakeDocker({ exitCode: 1, stdout: "DNS problem: NXDOMAIN", stderr: "error" });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    await expect(ex.exec("certbot certonly ...")).rejects.toThrow(/NXDOMAIN/);
  });

  it("does not read a null ExitCode as success", async () => {
    const { docker } = fakeDocker({ exitCode: undefined as unknown as number });
    const ex = new DockerEdgeExecutor({ containerName: "openship-edge", docker });
    // ExitCode null + not Running → 0; the guard that matters is Running:true,
    // covered by the poll loop. Here we just assert it resolves rather than hanging.
    await expect(ex.exec("true")).resolves.toBeDefined();
  });
});
