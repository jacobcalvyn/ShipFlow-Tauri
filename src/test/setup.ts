import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";
import { installTestBridge } from "./bridge";

beforeEach(() => {
  installTestBridge();
});
