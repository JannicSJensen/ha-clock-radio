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
  const translation = YAML.parse(read(path.join(addon, "translations/en.yaml")));
  assert.deepEqual(Object.keys(config.options).sort(), Object.keys(translation.configuration).sort());
  assert.ok(!("image" in config), "Supervisor should build locally");
});
