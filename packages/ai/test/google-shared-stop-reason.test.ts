import { FinishReason } from "@google/genai";
import { expect, it } from "vitest";
import { mapStopReason } from "../src/api/google-shared.ts";

it("maps Google's tool-call limit to an error instead of throwing", () => {
	expect(mapStopReason(FinishReason.TOO_MANY_TOOL_CALLS)).toBe("error");
});
