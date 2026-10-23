import { Hono } from "hono";
import { z } from "zod";
import { FleetError, type FleetService } from "../services/machines/fleet-projection.js";

export function createFleetRoutes(service: FleetService) {
  const app = new Hono();
  const identity = z.object({ hostId: z.string().min(1), session: z.string().min(1) });
  const operator = (request: Request) => request.headers.get("authorization") ?? request.headers.get("cookie") ?? "";
  app.onError((error, context) => {
    if (error instanceof FleetError) return context.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: "Invalid request" }, 400);
    return context.json({ error: "Fleet authority unavailable" }, 503);
  });
  app.post("/enrollments", async context => {
    const body = z.object({ hostId: z.string().min(1), capacity: z.number().int().positive(), ttlMs: z.number().positive() }).parse(await context.req.json());
    return context.json(await service.issue(operator(context.req.raw), body.hostId, body.capacity, body.ttlMs));
  });
  app.post("/enroll", async context => {
    const body = z.object({ token: z.string().min(1) }).parse(await context.req.json());
    return context.json(await service.enroll(body.token));
  });
  app.post("/poll", async context => {
    const body = identity.parse(await context.req.json());
    return context.json(await service.poll(body.hostId, body.session));
  });
  app.post("/complete", async context => {
    const body = identity.extend({ jobId: z.string(), attempt: z.number().int().positive(), success: z.boolean() }).parse(await context.req.json());
    await service.complete(body.hostId, body.session, body.jobId, body.attempt, body.success);
    return context.json({ ok: true });
  });
  app.post("/jobs", async context => {
    const body = z.object({ id: z.string().min(1), threadId: z.string().min(1), payload: z.string() }).parse(await context.req.json());
    await service.enqueue(operator(context.req.raw), body.id, body.threadId, body.payload);
    return context.json({ ok: true }, 201);
  });
  app.get("/", async context => context.json(await service.snapshot(operator(context.req.raw))));
  app.get("/view", async context => {
    const snapshot = await service.snapshot(operator(context.req.raw));
    const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
    return context.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="5"><title>Hyperfide hosts</title><style>body{font:18px Georgia;margin:3vw;background:#f6f2e9;color:#193c38}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:1rem;border-bottom:1px solid #b6c9bf}table{overflow-wrap:anywhere}</style><h1>Hosts</h1><table><tr><th>Host</th><th>Status</th><th>Capacity</th><th>Jobs</th></tr>${snapshot.hosts.map(h => `<tr><td>${escape(h.id)}</td><td>${h.online ? "Online" : "Lost"}</td><td>${h.jobs.length} / ${h.capacity}</td><td>${h.jobs.map(escape).join(", ")}</td></tr>`).join("")}</table><h2>Jobs</h2><table><tr><th>Thread</th><th>Job</th><th>Host</th><th>Status</th><th>Attempt</th></tr>${snapshot.jobs.map(j => `<tr><td>${escape(j.threadId)}</td><td>${escape(j.id)}</td><td>${escape(j.hostId ?? "Waiting")}</td><td>${j.state}</td><td>${j.attempt}</td></tr>`).join("")}</table></html>`);
  });
  return app;
}
