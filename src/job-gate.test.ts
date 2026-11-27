import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WINDOW_MS, JobGate } from "./job-gate.js";

test("un solo trabajo a la vez por remitente", () => {
  const gate = new JobGate();
  assert.equal(gate.tryStart("a"), "started");
  assert.equal(gate.tryStart("a"), "busy");
  assert.equal(gate.tryStart("b"), "started", "otros remitentes no se bloquean");
  gate.finish("a");
  assert.equal(gate.tryStart("a"), "started");
});

test("límite de trabajos por ventana deslizante", () => {
  let clock = 0;
  const gate = new JobGate({ maxJobsPerWindow: 2, windowMs: 1000, now: () => clock });

  assert.equal(gate.tryStart("a"), "started");
  gate.finish("a");
  clock = 100;
  assert.equal(gate.tryStart("a"), "started");
  gate.finish("a");
  clock = 200;
  assert.equal(gate.tryStart("a"), "rate-limited");

  clock = 1001;
  assert.equal(gate.tryStart("a"), "started", "el primero ya salió de la ventana");
});

test("respuestas sin trabajo: una por tipo y un tope por chat cada 10 minutos", () => {
  let now = 0;
  const gate = new JobGate({ now: () => now });
  assert.equal(gate.tryNotice("a", "ayuda"), true);
  assert.equal(gate.tryNotice("a", "ayuda"), false);
  assert.equal(gate.tryNotice("a", "no-es-video"), true);
  assert.equal(gate.tryNotice("a", "ajustes"), true);
  assert.equal(gate.tryNotice("a", "ocupado"), false);
  assert.equal(gate.tryNotice("b", "ocupado"), true);
  now = DEFAULT_WINDOW_MS - 1;
  assert.equal(gate.tryNotice("a", "ayuda"), false);
  now = DEFAULT_WINDOW_MS;
  assert.equal(gate.tryNotice("a", "ayuda"), true);
});
