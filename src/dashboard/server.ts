import { createServer, type Server } from "node:http";
import type { Logger } from "../core/logger.js";
import { buildFleetSnapshot, type AgentMeta } from "./data.js";
import { dashboardPage } from "./page.js";

/**
 * Read-only local dashboard. Serves the single-page UI and a JSON snapshot of
 * the fleet's state (runs, approvals, costs, memory). Binds to 127.0.0.1
 * only — run records and memories are sensitive.
 */
export interface DashboardOptions {
  dataDir: string;
  port: number;
  metas?: Map<string, AgentMeta>;
  log: Logger;
}

export function createDashboardServer(opts: DashboardOptions): Server {
  const metas = opts.metas ?? new Map<string, AgentMeta>();

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(dashboardPage());
        return;
      }
      if (url.pathname === "/api/fleet") {
        const snapshot = await buildFleetSnapshot(opts.dataDir, metas);
        res
          .writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
          .end(JSON.stringify(snapshot));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    })().catch((err) => {
      opts.log.error("dashboard request failed", { error: (err as Error).message });
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    });
  });
}

export function startDashboard(opts: DashboardOptions): Promise<{ server: Server; url: string }> {
  const server = createDashboardServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}
