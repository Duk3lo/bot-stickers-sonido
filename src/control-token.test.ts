import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlTokenError, loadOrCreateControlToken } from "./control-token.js";

async function tokenPath(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "control-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "control-token");
}

test("crea un token de 32 bytes con permisos 0600 y lo reutiliza", async (t) => {
  const path = await tokenPath(t);
  const token = await loadOrCreateControlToken(path);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, "utf8")).trim(), token);
  assert.equal(await loadOrCreateControlToken(path), token);
});

test("devuelve a 0600 un token con permisos abiertos", async (t) => {
  const path = await tokenPath(t);
  await loadOrCreateControlToken(path);
  await chmod(path, 0o644);
  await loadOrCreateControlToken(path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("un token mal formado es un error y no se sobrescribe ni se repite", async (t) => {
  const path = await tokenPath(t);
  await writeFile(path, "corto-secreto");
  await assert.rejects(
    loadOrCreateControlToken(path),
    (error: unknown) => error instanceof ControlTokenError && !error.message.includes("corto-secreto"),
  );
  assert.equal(await readFile(path, "utf8"), "corto-secreto");
});
