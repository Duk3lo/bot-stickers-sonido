import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAuthFiles, loadAuthState, UnreadableSessionError } from "./auth-files.js";

async function folder(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "auth-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("borra solo los archivos de Baileys y conserva la carpeta y lo demás", async (t) => {
  const dir = await folder(t);
  const own = [
    "creds.json", "pre-key-1.json", "session-abc.0.json", "sender-key-a--b--0.json", "sender-key-memory-x.json",
    "app-state-sync-key-AAAA.json", "app-state-sync-version-regular.json", "lid-mapping-1.json",
    "device-list-1.json", "tctoken-__index.json", "identity-key-a.json",
  ];
  const foreign = [".env", "package.json", "creds.json.bak", "notas.txt", "session-.json", "mi-creds.json"];
  for (const name of [...own, ...foreign]) {
    await writeFile(join(dir, name), "{}");
  }
  await mkdir(join(dir, "session-carpeta.json"));
  await clearAuthFiles(dir);
  assert.deepEqual((await readdir(dir)).sort(), [...foreign, "session-carpeta.json"].sort());
});

test("una carpeta que no existe no es un error", async (t) => {
  await clearAuthFiles(join(await folder(t), "no-existe"));
});

test("sin creds.json carga credenciales nuevas", async (t) => {
  const { state } = await loadAuthState(await folder(t));
  assert.equal(state.creds.registered, false);
});

test("un creds.json truncado o sin forma de objeto es un error y no se toca", async (t) => {
  for (const content of ['{"me":{"id":', "", "null", "[]"]) {
    const dir = await folder(t);
    await writeFile(join(dir, "creds.json"), content);
    await assert.rejects(loadAuthState(dir), UnreadableSessionError, JSON.stringify(content));
    assert.equal(await readFile(join(dir, "creds.json"), "utf8"), content);
  }
});

test("un creds.json sin permiso de lectura es un error", { skip: process.getuid?.() === 0 }, async (t) => {
  const dir = await folder(t);
  await writeFile(join(dir, "creds.json"), "{}");
  await chmod(join(dir, "creds.json"), 0o000);
  await assert.rejects(loadAuthState(dir), UnreadableSessionError);
});
