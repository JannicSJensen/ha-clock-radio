import assert from "node:assert/strict";
import test from "node:test";
import { swipeStep } from "../web/js/core/swipe.js";

test("touch gestures distinguish page and panel axes and enforce actual thresholds", () => {
  assert.equal(swipeStep(-64, 0, 1200, "horizontal"), 1);
  assert.equal(swipeStep(64, 0, 1200, "horizontal"), -1);
  assert.equal(swipeStep(0, -64, 1200, "vertical"), 1);
  assert.equal(swipeStep(0, 64, 1200, "vertical"), -1);
  for (const [dx, dy, elapsed, axis] of [[-63, 0, 100, "horizontal"], [0, -63, 100, "vertical"], [-64, 0, 1201, "horizontal"], [-80, 60, 500, "horizontal"], [-100, 0, 500, "vertical"]]) {
    assert.equal(swipeStep(dx, dy, elapsed, axis), 0);
  }
});
