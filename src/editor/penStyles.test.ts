import { describe, expect, it } from "vitest";
import { clampInkSize, defaultInkStyles, inkWidthMillimeters, loadInkStyles, saveInkStyles } from "./penStyles";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("ink styles", () => {
  it("remembers the chosen pen and highlighter across sessions", () => {
    const storage = memoryStorage();
    saveInkStyles(storage, {
      pen: { color: "#dc2626", size: 6 },
      highlighter: { color: "#4ade80", size: 22 },
    });
    expect(loadInkStyles(storage)).toEqual({
      pen: { color: "#dc2626", size: 6 },
      highlighter: { color: "#4ade80", size: 22 },
    });
  });

  it("keeps a custom colour and thickness from the pen menu", () => {
    const storage = memoryStorage();
    saveInkStyles(storage, {
      pen: { color: "#123456", size: 4.5 },
      highlighter: { color: "#ABCDEF", size: 30 },
    });
    expect(loadInkStyles(storage)).toEqual({
      pen: { color: "#123456", size: 4.5 },
      highlighter: { color: "#abcdef", size: 30 },
    });
  });

  it("falls back per tool when stored values are malformed or out of range", () => {
    const storage = memoryStorage();
    storage.setItem(
      "canvink:ink-styles:v1",
      JSON.stringify({ pen: { color: "red", size: 3 }, highlighter: { color: "#f472b6", size: 400 } }),
    );
    expect(loadInkStyles(storage)).toEqual(defaultInkStyles());
  });

  it("shows widths in millimetres and keeps them in the slider range", () => {
    expect(inkWidthMillimeters(3)).toBe(0.79);
    expect(clampInkSize("pen", 100)).toBe(24);
    expect(clampInkSize("highlighter", 1)).toBe(4);
  });

  it("uses the defaults for missing or corrupt storage", () => {
    const storage = memoryStorage();
    storage.setItem("canvink:ink-styles:v1", "{not json");
    expect(loadInkStyles(storage)).toEqual(defaultInkStyles());
    expect(loadInkStyles(null)).toEqual(defaultInkStyles());
  });
});
