import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlTokenError, defaultControlDir, loadOrCreateControlToken, setUpControlToken } from "./control-token.js";

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

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "control-setup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("la carpeta por defecto sigue XDG_CONFIG_HOME y si no ~/.config", () => {
  assert.equal(defaultControlDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u"), "/x/cfg/bot-stickers-sonido");
  assert.equal(defaultControlDir({}, "/home/u"), "/home/u/.config/bot-stickers-sonido");
  assert.equal(defaultControlDir({ XDG_CONFIG_HOME: " " }, "/home/u"), "/home/u/.config/bot-stickers-sonido");
});

test("sin CONTROL_TOKEN_FILE crea carpeta 0700, token 0600 y conexion.json 0600", async (t) => {
  const base = await tempDir(t);
  const env = { XDG_CONFIG_HOME: join(base, "cfg") };
  const token = await setUpControlToken({ env, port: 9001, legacyPath: join(base, "no-existe") });
  const dir = join(base, "cfg", "bot-stickers-sonido");
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await readFile(join(dir, "control-token"), "utf8")).trim(), token);
  assert.equal((await stat(join(dir, "control-token"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "conexion.json"), "utf8")), { version: 1, puerto: 9001 });
  assert.equal((await stat(join(dir, "conexion.json"))).mode & 0o777, 0o600);
});

test("mueve el ./control-token antiguo para que el token no cambie", async (t) => {
  const base = await tempDir(t);
  const legacyPath = join(base, "control-token");
  const old = await loadOrCreateControlToken(legacyPath);
  const env = { XDG_CONFIG_HOME: join(base, "cfg") };
  assert.equal(await setUpControlToken({ env, port: 8787, legacyPath }), old);
  await assert.rejects(stat(legacyPath), { code: "ENOENT" });
  assert.equal(await setUpControlToken({ env, port: 8787, legacyPath }), old);
});

test("si el token nuevo ya existe no toca el antiguo", async (t) => {
  const base = await tempDir(t);
  const legacyPath = join(base, "control-token");
  const old = await loadOrCreateControlToken(legacyPath);
  const env = { XDG_CONFIG_HOME: join(base, "cfg") };
  const first = await setUpControlToken({ env, port: 1, legacyPath: join(base, "nada") });
  assert.equal(await setUpControlToken({ env, port: 2, legacyPath }), first);
  assert.equal(await readFile(legacyPath, "utf8"), `${old}\n`);
});

test("con CONTROL_TOKEN_FILE usa esa ruta, sin migrar, y deja conexion.json al lado", async (t) => {
  const base = await tempDir(t);
  const legacyPath = join(base, "control-token");
  await loadOrCreateControlToken(legacyPath);
  const custom = join(base, "otro", "token");
  const env = { CONTROL_TOKEN_FILE: custom };
  await mkdir(join(base, "otro"));
  const token = await setUpControlToken({ env, port: 8787, legacyPath });
  assert.equal((await readFile(custom, "utf8")).trim(), token);
  assert.equal(JSON.parse(await readFile(join(base, "otro", "conexion.json"), "utf8")).puerto, 8787);
  assert.equal((await stat(legacyPath)).isFile(), true);
});
