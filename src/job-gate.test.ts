import { test } from "node:test";
import assert from "node:assert/strict";
import { JobGate } from "./job-gate.js";

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
