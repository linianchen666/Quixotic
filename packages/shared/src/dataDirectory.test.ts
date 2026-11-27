import { describe, expect, it } from "vite-plus/test";

import {
  normalizeComparablePath,
  parseDataDirectoryPointer,
  serializeDataDirectoryPointer,
  validateDataDirectoryTarget,
} from "./dataDirectory.ts";

describe("dataDirectory", () => {
  it("serializes and parses a valid pointer file", () => {
    const raw = serializeDataDirectoryPointer({
      baseDir: "D:\\QuixoticData",
      migratedFrom: "C:\\Users\\Alice\\.t3",
      migratedAt: "2026-11-27T02:00:00.000Z",
    });

    expect(parseDataDirectoryPointer(raw, "win32")).toEqual({
      version: 1,
      baseDir: "D:\\QuixoticData",
      migratedFrom: "C:\\Users\\Alice\\.t3",
      migratedAt: "2026-11-27T02:00:00.000Z",
    });
  });

  it("rejects malformed or relative pointer files", () => {
    expect(parseDataDirectoryPointer("not json", "linux")).toBeNull();
    expect(parseDataDirectoryPointer(JSON.stringify({ version: 2, baseDir: "/tmp/a" }), "linux")).toBeNull();
    expect(parseDataDirectoryPointer(JSON.stringify({ version: 1, baseDir: "relative/dir" }), "linux")).toBeNull();
    expect(parseDataDirectoryPointer(JSON.stringify({ version: 1, baseDir: "D:relative" }), "win32")).toBeNull();
  });

  it("validates Windows and POSIX target directories safely", () => {
    expect(
      validateDataDirectoryTarget({
        currentBaseDir: "C:\\Users\\Alice\\.t3",
        targetBaseDir: "D:\\QuixoticData\\",
        platform: "win32",
      }),
    ).toEqual({ ok: true, normalizedTarget: "D:\\QuixoticData" });

    expect(
      validateDataDirectoryTarget({
        currentBaseDir: "C:\\Users\\Alice\\.t3",
        targetBaseDir: "c:/users/alice/.t3/",
        platform: "win32",
      }),
    ).toEqual({ ok: false, reason: "same-directory" });

    expect(
      validateDataDirectoryTarget({
        currentBaseDir: "C:\\Users\\Alice\\.t3",
        targetBaseDir: "C:\\Users\\Alice\\.t3\\sub",
        platform: "win32",
      }),
    ).toEqual({ ok: false, reason: "nested-inside-current" });

    expect(
      validateDataDirectoryTarget({
        currentBaseDir: "C:\\Users\\Alice\\.t3",
        targetBaseDir: "C:\\Users\\Alice",
        platform: "win32",
      }),
    ).toEqual({ ok: false, reason: "contains-current" });

    expect(
      validateDataDirectoryTarget({
        currentBaseDir: "C:\\Users\\Alice\\.t3",
        targetBaseDir: "D:\\",
        platform: "win32",
      }),
    ).toEqual({ ok: false, reason: "root-directory" });

    expect(
      validateDataDirectoryTarget({
        currentBaseDir: "/home/alice/.quixotic",
        targetBaseDir: "/mnt/data/quixotic/",
        platform: "linux",
      }),
    ).toEqual({ ok: true, normalizedTarget: "/mnt/data/quixotic" });

    expect(normalizeComparablePath("D:\\Data\\", "win32")).toBe("d:/data");
  });
});
