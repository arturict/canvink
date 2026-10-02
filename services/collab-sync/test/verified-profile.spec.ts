import { describe, expect, it } from "vitest";
import { profileFromClaims } from "../src/auth/clerk";
import { stampVerifiedProfile } from "../src/room";

describe("verified presence profile", () => {
  it("reads name and picture claims and drops malformed ones", () => {
    expect(profileFromClaims({ name: "  Anna Keller ", picture: "https://img.clerk.com/a.png" }))
      .toEqual({ name: "Anna Keller", picture: "https://img.clerk.com/a.png" });
    expect(profileFromClaims({ name: 42, picture: "javascript:alert(1)" })).toEqual({});
    expect(profileFromClaims({})).toEqual({});
  });

  it("overwrites the name and picture a client claims with the verified ones", () => {
    const state = { page: "p1", user: { id: "u", name: "Test User", color: "#123456", img: "https://evil.example/x.png" } };
    expect(stampVerifiedProfile(state, { name: "Ben Rossi", picture: "https://img.clerk.com/b.png" })).toEqual({
      page: "p1",
      user: { id: "u", name: "Ben Rossi", color: "#123456", img: "https://img.clerk.com/b.png" },
    });
  });

  it("leaves presence unchanged for sockets without a verified profile", () => {
    const state = { user: { id: "u", name: "Gast", color: "#123456" } };
    expect(stampVerifiedProfile(state, {})).toBe(state);
  });
});
