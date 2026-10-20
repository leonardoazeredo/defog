# Fog of World-written Sync tiles

`23e4lltkkoke` (tile id 117660) and `cd36lltksiwo` (tile id 117659) are two Sync tiles written by Fog of World, copied unchanged from
[CaviarChen/fog-machine](https://github.com/CaviarChen/fog-machine) at commit `7913bbe4c4279e64f9c5a4d23861edff39a65aa0`,
`editor/src/__tests__/data/`. Fog Machine is MIT licensed; its licence is `LICENSE-fog-machine.txt` (same commit).

They cover southern Hainan and hold 447 blocks between them, with the region codes `CN` and `@@`.
`bench/fog-writer.test.js` rebuilds each one from its parsed blocks and expects the same bytes, compressed and decompressed.

Nothing here comes from MemoLanes (GPL-3.0) or from anyone's own `Sync/` folder.
