import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIDEBAR_BOOT_ATTRIBUTE,
  SIDEBAR_BOOT_SCRIPT,
  SIDEBAR_STORAGE_KEY,
  readSidebarOpen,
  saveSidebarOpen,
} from "../lib/sidebar.ts";

function memoryStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}
const blocked = () => {
  throw new Error("SecurityError: storage is disabled");
};
const failing = {
  getItem: blocked,
  setItem: blocked,
};

test("the sidebar starts open on a device that saved nothing", () => {
  assert.equal(readSidebarOpen(() => memoryStorage()), true);
});

test("the sidebar starts collapsed only when this device saved it collapsed", () => {
  assert.equal(readSidebarOpen(() => memoryStorage({ [SIDEBAR_STORAGE_KEY]: "collapsed" })), false);
  assert.equal(readSidebarOpen(() => memoryStorage({ [SIDEBAR_STORAGE_KEY]: "expanded" })), true);
  assert.equal(readSidebarOpen(() => memoryStorage({ [SIDEBAR_STORAGE_KEY]: "sideways" })), true);
});

test("the sidebar starts open when storage is blocked", () => {
  assert.equal(readSidebarOpen(blocked), true);
  assert.equal(readSidebarOpen(() => failing), true);
});

test("saving remembers collapsed and expanded under one key", () => {
  const storage = memoryStorage();
  saveSidebarOpen(false, () => storage);
  assert.equal(storage.data.get(SIDEBAR_STORAGE_KEY), "collapsed");
  assert.equal(readSidebarOpen(() => storage), false);
  saveSidebarOpen(true, () => storage);
  assert.equal(storage.data.get(SIDEBAR_STORAGE_KEY), "expanded");
  assert.equal(readSidebarOpen(() => storage), true);
});

test("saving does nothing, and does not throw, when storage is blocked", () => {
  assert.doesNotThrow(() => saveSidebarOpen(false, blocked));
  assert.doesNotThrow(() => saveSidebarOpen(false, () => failing));
});

// The inline script runs in <head> before the page paints.
function runBootScript(storage) {
  const attributes = new Map();
  const document = {
    documentElement: { setAttribute: (name, value) => attributes.set(name, value) },
  };
  new Function("localStorage", "document", SIDEBAR_BOOT_SCRIPT)(storage, document);
  return attributes;
}

test("before the app loads, a saved rail marks the page so the first paint shows it", () => {
  const attributes = runBootScript(memoryStorage({ [SIDEBAR_STORAGE_KEY]: "collapsed" }));
  assert.equal(attributes.get(SIDEBAR_BOOT_ATTRIBUTE), "collapsed");
});

test("before the app loads, an open or unsaved sidebar leaves the page alone", () => {
  assert.equal(runBootScript(memoryStorage()).size, 0);
  assert.equal(runBootScript(memoryStorage({ [SIDEBAR_STORAGE_KEY]: "expanded" })).size, 0);
});

test("the early script does not throw when storage is blocked", () => {
  assert.doesNotThrow(() => runBootScript(failing));
  assert.equal(runBootScript(failing).size, 0);
});
