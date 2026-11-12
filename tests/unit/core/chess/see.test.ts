import { describe, expect, it } from "vitest";
import { nullMoveFen, pieceSquares, see } from "@/core/chess/see";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";

const V = METHODOLOGY_V1.material;

/** methodology §5.11; positions verified legal with chess.js. */
describe("SEE: a deterministic least-valuable-attacker estimate", () => {
  it.each([
    ["S1 undefended piece", "3qk3/8/8/3N4/8/8/8/4K3 b - - 0 1", "d5", 3],
    ["S2 defended by a pawn (Qxd5 exd5 nets −6, so no capture)", "3qk3/8/8/3N4/4P3/8/8/4K3 b - - 0 1", "d5", 0],
    ["S3a multi-piece exchange with an x-ray rook behind the queen (nets −4)", "3r1k2/3q4/8/8/3R4/1N6/8/3R2K1 b - - 0 1", "d4", 0],
    ["S3b the same without the knight (Qxd4+ Rxd4 Rxd4 nets +1)", "3r1k2/3q4/8/8/3R4/8/8/3R2K1 b - - 0 1", "d4", 1],
    ["S4a pinned attacker: Nxd5 is illegal", "4k3/4n3/8/3B4/8/8/8/4RK2 b - - 0 1", "d5", 0],
    ["S4b pinned piece capturing its pinner along the pin line", "4k3/4r3/8/8/8/8/4R3/6K1 b - - 0 1", "e2", 5],
    ["S5 the king can't take a defended piece", "3rk3/8/8/8/8/8/3n4/4K3 w - - 0 1", "d2", 0],
    ["S5b the king takes an undefended piece", "4k3/8/8/8/8/8/3n4/4K3 w - - 0 1", "d2", 3],
    ["S6a en passant", "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2", "d5", 1],
    ["S6b en passant, then the recapture on the en passant square", "4k3/2p5/8/3pP3/8/8/8/4K3 w - d6 0 2", "d5", 0],
    ["S7 promotion while capturing (bxa8=Q+ Kxa8: +5 + 8 − 9)", "rkn5/1P6/8/8/8/8/8/4K3 w - - 0 1", "a8", 4],
    ["S8 captures limited by a double check (cxd6 is illegal)", "4k3/2p5/3N4/8/8/8/8/4R1K1 b - - 1 1", "d6", 0],
    ["no capture at all", "4k3/8/8/8/8/8/8/4K3 w - - 0 1", "e4", 0],
  ])("%s → %i, certain", (_name, fen, square, value) => {
    expect(see(fen, square, V)).toEqual({ value, certain: true });
  });

  it("equal-value capturers can give different results: the tie-break value is kept, flagged uncertain (1)", () => {
    // Rd3 and Rb5 both attack d5. Rd3xd5+ uncovers Bb1's check on h7, so ...exd5 is illegal: +3.
    // Rb5xd5 first allows ...exd5, then Rd3xd5+: −1, so no capture: 0. The tie-break (d3 before b5,
    // lower square first) happens to pick the better order.
    expect(see("8/7k/4p3/1R1n4/8/3R4/8/1B4K1 w - - 0 1", "d5", V)).toEqual({ value: 3, certain: false });
  });

  it("equal-value capturers can give different results: the tie-break value is kept, flagged uncertain (2)", () => {
    // Rd1 and Rf5 both attack d5. The tie-break plays Rd1xd5 first (d1 before f5): ...exd5, Rxd5+,
    // net −1, so 0. Rf5xd5+ first would uncover Bc2's check and win the knight (+3).
    expect(see("8/7k/4p3/3n1R2/8/8/2B5/3R2K1 w - - 0 1", "d5", V)).toEqual({ value: 0, certain: false });
  });

  it("two equal capturers with nothing behind them are certain", () => {
    // Two knights attack an undefended rook: either order gives +5.
    expect(see("4k3/8/8/3r4/8/2N1N3/8/4K3 w - - 0 1", "d5", V)).toEqual({ value: 5, certain: true });
  });

  it("is deterministic", () => {
    const fen = "3r1k2/3q4/8/8/3R4/1N6/8/3R2K1 b - - 0 1";
    expect(see(fen, "d4", V)).toEqual(see(fen, "d4", V));
  });

  it("rejects an invalid position", () => {
    expect(() => see("not a fen", "e4", V)).toThrow();
  });
});

describe("null-move position and piece squares", () => {
  it("switches the side to move and clears en passant", () => {
    expect(nullMoveFen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2")).toBe("4k3/8/8/3pP3/8/8/8/4K3 b - - 0 2");
  });

  it("is undefined when the side to move is in check", () => {
    expect(nullMoveFen("4k3/8/8/8/8/8/8/r3K3 w - - 0 1")).toBeUndefined();
  });

  it("lists the non-king pieces of one side", () => {
    expect(pieceSquares("4k3/8/8/3pP3/8/8/8/4K3 w - - 0 1", "w")).toEqual(["e5"]);
    expect(pieceSquares("rkn5/1P6/8/8/8/8/8/4K3 w - - 0 1", "b").sort()).toEqual(["a8", "c8"]);
  });
});
