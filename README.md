# png-squeeze-01 entry

Lossless PNG re-encoder for the make.fun bounty
[Squeeze screenshots into the smallest PNG](https://make.fun/bounty/png-squeeze-01-run-20261127).

`main.ts` (Node 22, built-in modules only) reads each stored screenshot PNG from
`/input/<id>/image.png` and writes the same image, pixel-exact, to
`/output/<id>/image.png` in as few bytes as it can:

- decodes to RGBA with its own PNG reader;
- reduces the colour type when the pixels allow it (palette with per-entry
  alpha, grey, grey+alpha, RGB with a tRNS key, RGBA);
- tries fixed and per-row adaptive PNG filters (minimum-sum, fewest distinct
  byte pairs, lowest entropy, and brute-force per-row choice by deflated size);
- screens every candidate with zlib and writes the winner under the best of
  several zlib settings, or an optimal-parse deflate (hash-chain matching,
  shortest-path parsing, block-split dynamic Huffman) for large streams when
  it beats zlib.

Deterministic: the same input always produces the same bytes.
