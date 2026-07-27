"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Plus,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  dockerMigrationApi,
  type MigrationRun,
  type MigrationStatus,
} from "@/lib/api/server-migration";
import { systemApi } from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import { useI18n } from "@/components/i18n-provider";
import { ServerConnectionCard } from "@/app/(dashboard)/servers/[serverId]/_components/connection-card";
import { ServerMigrationWizard } from "./ServerMigrationWizard";

const IN_FLIGHT: MigrationStatus[] = [
  "queued",
  "adopting",
  "moving_data",
  "deploying",
  "verifying",
  "awaiting_cutover",
  "cutover",
];
const isInFlight = (s: MigrationStatus) => IN_FLIGHT.includes(s);

/** Status → theme-aware tone + icon (semantic tokens, never hardcoded colors). */
function statusTone(status: MigrationStatus): {
  text: string;
  bg: string;
  Icon: React.ElementType;
  spin?: boolean;
} {
  if (status === "succeeded")
    return { text: "text-success", bg: "bg-success-bg", Icon: CheckCircle2 };
  if (status === "failed" || status === "rolled_back")
    return { text: "text-danger", bg: "bg-danger-bg", Icon: XCircle };
  if (status === "awaiting_cutover" || status === "partial")
    return { text: "text-warning", bg: "bg-warning-bg", Icon: AlertTriangle };
  if (status === "queued")
    return { text: "text-muted-foreground", bg: "bg-muted", Icon: Clock };
  return { text: "text-warning", bg: "bg-warning-bg", Icon: Loader2, spin: true };
}

function relTime(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "";
  }
}

/**
 * Server-detail "Migrations" tab. Two in-page states, no modals:
 *   • list  — recent runs as rows (durable server truth) like a project's
 *             deployments; "New migration" starts the flow, a row opens that run.
 *   • flow  — the SAME `ServerMigrationWizard` (variant="tab") rendered in-page:
 *             a fresh scan-first migration when `runId` is unset, or an existing
 *             run's steps + logs when a row was clicked (incl. an ongoing one —
 *             it drops straight into the live progress, like a deployment).
 *
 * The wizard is one reusable component (tab here, modal elsewhere e.g. Library);
 * this tab adds only the list — no duplicated flow/progress/detail code.
 */
export function MigrationsTab({
  serverId,
  server,
}: {
  serverId: string;
  server?: {
    sshHost: string;
    sshPort?: number | null;
    sshUser?: string | null;
    sshAuthMethod?: string | null;
  } | null;
}) {
  const { t } = useI18n();
  const m = t.migration;
  const tab = m.tab;

  const [runs, setRuns] = useState<MigrationRun[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  // null = list; {} = new migration (scan first); {runId} = open that run.
  const [flow, setFlow] = useState<{ runId?: string } | null>(null);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await dockerMigrationApi.list(serverId);
      setRuns(res.runs);
    } catch {
      setRuns((prev) => prev ?? []);
    }
  }, [serverId]);

  useEffect(() => {
    void fetchRuns();
    void systemApi
      .listServers()
      .then((list) => {
        const map: Record<string, string> = {};
        for (const s of list) if (s.name) map[s.id] = s.name;
        setNames(map);
      })
      .catch(() => {});
  }, [fetchRuns]);

  // Poll while anything is in flight (and only while showing the list) so the
  // rows reflect live status without a second stream.
  const anyInFlight = Boolean(runs?.some((r) => isInFlight(r.status)));
  useEffect(() => {
    if (flow || !anyInFlight) return;
    const iv = setInterval(() => void fetchRuns(), 3500);
    return () => clearInterval(iv);
  }, [flow, anyInFlight, fetchRuns]);

  const backToList = () => {
    setFlow(null);
    void fetchRuns();
  };

  // ── In-page flow (reused wizard) ── the wizard renders the "← Back" inline in
  // its own header rows (via onBack), so it never adds a row that pushes down.
  if (flow) {
    return (
      <ServerMigrationWizard
        variant="tab"
        serverId={serverId}
        server={server}
        initialRunId={flow.runId}
        onClose={backToList}
        onBack={backToList}
      />
    );
  }

  const peerName = (run: MigrationRun): string | null => {
    if (run.mode === "same_server") return tab.inPlace;
    const peerId = run.targetServerId === serverId ? run.sourceServerId : run.targetServerId;
    return peerId ? (names[peerId] ?? tab.crossServer) : tab.crossServer;
  };

  // ── List ── two columns (rows left, Connection card right), same shell as
  // the other server tabs + the flow view — the tab spans full width, so the
  // right column lives here, not in the page's global sidebar.
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0">
      {runs === null ? (
        <div className="flex items-center justify-center rounded-2xl border border-border bg-card py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : runs.length === 0 ? (
        // Same card shell as the populated list, so the tab keeps its shape
        // either way; the safety note is a flush footer, not a nested panel.
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="inline-flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Boxes className="size-5" />
            </span>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">{tab.empty}</p>
              <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
                {tab.emptyDesc}
              </p>
            </div>
          </div>
          {/* Crystal-clear safety guarantee — migration COPIES, never moves;
              the source keeps running and nothing is deleted unless you opt in. */}
          <div className="flex items-start gap-2.5 border-t border-border bg-muted/30 px-5 py-3.5 text-start">
            <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">{tab.safetyTitle}</span> {tab.safetyBody}
            </p>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {runs.map((run) => {
            const tone = statusTone(run.status);
            const bytes = run.bytesMoved ? formatBytes(run.bytesMoved) : null;
            return (
              <button
                key={run.id}
                onClick={() => setFlow({ runId: run.id })}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-muted/40"
              >
                <span
                  className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full ${tone.bg} ${tone.text}`}
                >
                  <tone.Icon className={`size-4 ${tone.spin ? "animate-spin" : ""}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {run.projectName || "—"}
                    </span>
                    <span className={`shrink-0 text-[11px] font-medium ${tone.text}`}>
                      {tab.status[run.status] ?? run.status}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      {names[serverId] ?? tab.crossServer}
                      <ArrowRight className="size-3" />
                      {peerName(run)}
                    </span>
                    <span>·</span>
                    <span>{relTime(run.startedAt)}</span>
                    {bytes && (
                      <>
                        <span>·</span>
                        <span className="tabular-nums">{bytes}</span>
                      </>
                    )}
                  </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      )}
      </div>

      <div className="space-y-3 lg:sticky lg:top-6 lg:self-start">
        {server && <ServerConnectionCard server={server} />}
        <button
          onClick={() => setFlow({})}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
        >
          <Plus className="size-4" />
          {tab.new}
        </button>
      </div>
    </div>
  );
}
