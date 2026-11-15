import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

const app = fileURLToPath(new URL("../", import.meta.url));
const addon = path.resolve(app, "..");
const root = path.resolve(addon, "..");
const read = (file) => fs.readFileSync(file, "utf8");

test("release versions match app metadata, package, lockfile and changelog", () => {
  const config = YAML.parse(read(path.join(addon, "config.yaml")));
  const pkg = JSON.parse(read(path.join(app, "package.json")));
  const lock = JSON.parse(read(path.join(app, "package-lock.json")));
  assert.equal(config.version, pkg.version);
  assert.equal(config.version, lock.version);
  assert.equal(config.version, lock.packages[""].version);
  assert.match(read(path.join(addon, "CHANGELOG.md")), new RegExp(`^## ${config.version.replaceAll(".", "\\.")}$`, "m"));
});

test("Supervisor packaging has persistent config, ingress and non-conflicting tablet port", () => {
  const config = YAML.parse(read(path.join(addon, "config.yaml")));
  const repository = YAML.parse(read(path.join(root, "repository.yaml")));
  assert.equal(config.url, repository.url);
  assert.deepEqual(config.arch, ["aarch64", "amd64"]);
  assert.equal(config.homeassistant_api, true);
  assert.equal(config.ingress, true);
  assert.equal(config.ingress_port, 8100);
  assert.equal(config.ports["8100/tcp"], 8100);
  assert.equal(config.map[0].type, "app_config");
  assert.equal(config.map[0].read_only, false);
  assert.deepEqual(Object.keys(config.map[0]).sort(), ["path", "read_only", "type"]);
  assert.equal(config.hassio_api, true);
  assert.ok(!("hassio_role" in config), "The default Supervisor role is implicit");
  assert.equal(config.schema.music_assistant_token, "password?");
  assert.equal(config.options.weather_entity, "");
  assert.equal(config.schema.weather_entity, "str?");
  assert.equal(config.options.sun_entity, "sun.sun");
  assert.equal(config.schema.sun_entity, "str?");
  const translation = YAML.parse(read(path.join(addon, "translations/en.yaml")));
  assert.deepEqual(Object.keys(config.options).sort(), Object.keys(translation.configuration).sort());
  assert.ok(!("image" in config), "Supervisor should build locally");
});

test("vendored renderer and fonts retain their full redistribution licenses", () => {
  assert.match(read(path.join(app, "web/clock/LICENSE")), /Apache License/);
  for (const file of ["web/clock/fonts/OFL.txt", "web/clock/fonts/OFL-Archivo.txt", "web/fonts/LICENSE.txt"]) {
    const license = read(path.join(app, file));
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(license, /PERMISSION (?:&|AND) CONDITIONS/);
    assert.match(license, /DISCLAIMER/);
  }
});
