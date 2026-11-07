import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Toutes les sources, sauf la page de fond elle-même. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );
}

describe("pages de l'extension", () => {
  it("n'importent jamais la page de fond : elle s'y relancerait en double", () => {
    const offenders = sources("src").filter((file) => !file.endsWith("background.ts") && /from\s+"[./]+\/?background"/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
