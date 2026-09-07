import test from "node:test";
import assert from "node:assert/strict";
import { hashFromGray, hamming } from "../lib/sceneHash";

function gray(fn: (row: number, col: number) => number): Buffer {
  const b = Buffer.alloc(72);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 9; c++) b[r * 9 + c] = fn(r, c);
  return b;
}

test("dHash из серого 9×8: градиент вправо даёт все единицы, влево — нули", () => {
  const up = hashFromGray(gray((_, c) => c * 20));
  const down = hashFromGray(gray((_, c) => 200 - c * 20));
  assert.equal(up, (1n << 64n) - 1n);
  assert.equal(down, 0n);
  assert.equal(hamming(up!, down!), 64);
});

test("dHash: короткий буфер — null, лишние байты не мешают", () => {
  assert.equal(hashFromGray(Buffer.alloc(10)), null);
  const b = Buffer.concat([gray((_, c) => c * 20), Buffer.alloc(100)]);
  assert.equal(hashFromGray(b), (1n << 64n) - 1n);
});

test("dHash устойчив к общей яркости: тот же кадр темнее — та же сцена", () => {
  const a = hashFromGray(gray((r, c) => 100 + ((r * 7 + c * 13) % 50)));
  const b = hashFromGray(gray((r, c) => 60 + ((r * 7 + c * 13) % 50)));
  assert.equal(a, b);
});
