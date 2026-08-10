import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localFolderSelectionLimit,
  toggleLocalFolderSelection,
} from "../ui/src/lib/localFolderReferences.ts";

test("local folder selection preserves click order and toggles an existing image", () => {
  let selected: string[] = [];
  selected = toggleLocalFolderSelection(selected, "third.png", 4);
  selected = toggleLocalFolderSelection(selected, "first.png", 4);
  selected = toggleLocalFolderSelection(selected, "second.png", 4);
  assert.deepEqual(selected, ["third.png", "first.png", "second.png"]);

  selected = toggleLocalFolderSelection(selected, "first.png", 4);
  assert.deepEqual(selected, ["third.png", "second.png"]);
});

test("local folder selection stops at four without replacing earlier choices", () => {
  let selected = ["one.png", "two.png", "three.png", "four.png"];
  selected = toggleLocalFolderSelection(selected, "five.png", 4);
  assert.deepEqual(selected, ["one.png", "two.png", "three.png", "four.png"]);
});

test("local folder capacity follows the provider tray remainder", () => {
  assert.equal(localFolderSelectionLimit(5, 0), 4);
  assert.equal(localFolderSelectionLimit(5, 2), 3);
  assert.equal(localFolderSelectionLimit(3, 2), 1);
  assert.equal(localFolderSelectionLimit(1, 1), 0);
});
