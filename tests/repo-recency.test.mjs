import assert from "node:assert/strict";
import test from "node:test";
import {
  REPO_RECENCY_KEY,
  loadRepoRecency,
  orderByRecency,
  recordRepoOpened,
} from "../lib/repo-recency.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function sealedStorage() {
  return {
    getItem: () => { throw new Error("Storage is unavailable."); },
    setItem: () => { throw new Error("Storage is unavailable."); },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
}

const repos = ["acme/alpha", "acme/beta", "acme/gamma"].map((fullName, id) => ({ id, fullName }));

test("orders opened repositories first, most recent first", () => {
  const storage = memoryStorage();
  recordRepoOpened(storage, "acme/gamma", 1000);
  recordRepoOpened(storage, "acme/beta", 2000);

  const ordered = orderByRecency(repos, loadRepoRecency(storage));

  assert.deepEqual(ordered.map((repo) => repo.fullName), ["acme/beta", "acme/gamma", "acme/alpha"]);
});

test("keeps the API order when nothing has been opened", () => {
  assert.deepEqual(orderByRecency(repos, {}), repos);
});

test("caps the map at 50 entries by dropping the oldest", () => {
  const storage = memoryStorage();
  for (let index = 0; index < 60; index += 1) recordRepoOpened(storage, `acme/repo-${index}`, 1000 + index);

  const recency = loadRepoRecency(storage);

  assert.equal(Object.keys(recency).length, 50);
  assert.equal(recency["acme/repo-59"], 1059);
  assert.equal(recency["acme/repo-9"], undefined);
});

test("ignores malformed stored recency", () => {
  const storage = memoryStorage();
  storage.setItem(REPO_RECENCY_KEY, "not json");
  assert.deepEqual(loadRepoRecency(storage), {});

  storage.setItem(REPO_RECENCY_KEY, JSON.stringify({ "acme/alpha": "yesterday", "acme/beta": 5 }));
  assert.deepEqual(loadRepoRecency(storage), { "acme/beta": 5 });
});

test("survives storage that throws or is unreachable", () => {
  const storage = sealedStorage();

  assert.deepEqual(loadRepoRecency(storage), {});
  assert.deepEqual(recordRepoOpened(storage, "acme/alpha", 1000), { "acme/alpha": 1000 });
  assert.deepEqual(loadRepoRecency(null), {});
  assert.deepEqual(recordRepoOpened(null, "acme/alpha", 1000), { "acme/alpha": 1000 });
});
