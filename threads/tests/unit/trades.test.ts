import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { buildTrades, buildTradesForCoin, roePct, worthPosting, type FillInput } from "../../src/services/trades/aggregate.js";
import { CARD_HEIGHT, CARD_WIDTH, formatDuration, formatPct, formatPrice, formatUsd, renderTradeCard, shortWallet } from "../../src/services/trades/card.js";
import { tradeFacts } from "../../src/services/trades/writer.js";
import { validateDraft } from "../../src/services/writer/validate.js";
import { isPerpCoin, isWalletAddress } from "../../src/hyperliquid/client.js";
import type { TradeRow } from "../../src/db/repos/trades.js";

let tid = 1;
const t0 = Date.parse("2026-09-20T08:00:00Z");
const fill = (p: Partial<FillInput> & Pick<FillInput, "side" | "px" | "sz" | "startPosition">, minute: number): FillInput => ({ tid: tid++, coin: "BTC", closedPnl: 0, fee: 0, hash: `0x${tid}`, time: new Date(t0 + minute * 60_000), ...p });

test("a long that is scaled in, partly closed and then closed is ONE trade with VWAP entry/exit and net PnL", () => {
  const trades = buildTradesForCoin([
    fill({ side: "B", px: 60_000, sz: 0.5, startPosition: 0, fee: 9 }, 0),
    fill({ side: "B", px: 61_000, sz: 0.5, startPosition: 0.5, fee: 9 }, 10),
    fill({ side: "A", px: 62_000, sz: 0.4, startPosition: 1, closedPnl: 600, fee: 7 }, 60),
    fill({ side: "A", px: 63_000, sz: 0.6, startPosition: 0.6, closedPnl: 1500, fee: 11 }, 120),
  ]);
  assert.equal(trades.length, 1);
  const t = trades[0]!;
  assert.deepEqual([t.direction, t.status, t.fillsCount], ["LONG", "CLOSED", 4]);
  assert.equal(t.entryPx, 60_500);
  assert.equal(t.exitPx, 62_600);
  assert.equal(t.maxSize, 1);
  assert.equal(t.closedPnl, 2100);
  assert.equal(t.fees, 36);
  assert.equal(t.netPnl, 2064);
  assert.ok(Math.abs(t.movePct! - 3.4711) < 0.001);
  assert.equal(t.closedAt!.getTime(), t0 + 120 * 60_000);
});

test("a flip closes one trade and opens the opposite one from the same fill; fees are split by size", () => {
  const trades = buildTradesForCoin([
    fill({ side: "A", px: 100, sz: 10, startPosition: 0, fee: 1 }, 0),
    fill({ side: "B", px: 90, sz: 15, startPosition: -10, closedPnl: 100, fee: 3 }, 30),
    fill({ side: "A", px: 95, sz: 5, startPosition: 5, closedPnl: 25, fee: 0.5 }, 45),
  ]);
  assert.equal(trades.length, 2);
  assert.deepEqual([trades[0]!.direction, trades[0]!.status, trades[0]!.netPnl], ["SHORT", "CLOSED", 97]); // 100 − (1 + 3·10/15)
  assert.ok(trades[0]!.movePct! > 9.9 && trades[0]!.movePct! < 10.1, "a short profits when the price falls");
  assert.deepEqual([trades[1]!.direction, trades[1]!.status, trades[1]!.entryPx, trades[1]!.netPnl], ["LONG", "CLOSED", 90, 23.5]); // 25 − (1 + 0.5)
});

test("positions opened before the window are ignored until flat; an unfinished position stays OPEN", () => {
  const trades = buildTradesForCoin([
    fill({ side: "A", px: 50, sz: 2, startPosition: 5, closedPnl: 40 }, 0), // entry unknown
    fill({ side: "A", px: 51, sz: 3, startPosition: 3, closedPnl: 70 }, 5),
    fill({ side: "B", px: 52, sz: 1, startPosition: 0 }, 10),
  ]);
  assert.equal(trades.length, 1);
  assert.deepEqual([trades[0]!.status, trades[0]!.entryPx, trades[0]!.exitPx], ["OPEN", 52, null]);
  const byCoin = buildTrades([fill({ side: "B", px: 1, sz: 1, startPosition: 0, coin: "SOL" }, 0), fill({ side: "B", px: 2, sz: 1, startPosition: 0, coin: "ETH" }, 1)]);
  assert.deepEqual(byCoin.map((t) => t.coin), ["SOL", "ETH"]);
});

test("ROE is net PnL over the margin; only closed winners above the owner's bar are worth a post", () => {
  assert.equal(roePct({ netPnl: 2064, maxSize: 1, entryPx: 60_500 }, 10), 34.12);
  assert.equal(roePct({ netPnl: 10, maxSize: 1, entryPx: 100 }, null), null);
  const bar = { minPnlUsd: 50, minRoePct: 5, requireBoth: false };
  assert.equal(worthPosting({ status: "CLOSED", netPnl: 2064, roePct: 34.1, movePct: 3.4 }, bar).ok, true);
  assert.equal(worthPosting({ status: "CLOSED", netPnl: -5, roePct: -1, movePct: -0.1 }, bar).ok, false, "losing trades are never posted");
  assert.equal(worthPosting({ status: "OPEN", netPnl: 500, roePct: 40, movePct: 4 }, bar).ok, false);
  assert.equal(worthPosting({ status: "CLOSED", netPnl: 12, roePct: 1.2, movePct: 0.4 }, bar).ok, false);
  assert.equal(worthPosting({ status: "CLOSED", netPnl: 12, roePct: 9, movePct: 0.9 }, bar).ok, true, "either threshold is enough by default");
  assert.equal(worthPosting({ status: "CLOSED", netPnl: 12, roePct: 9, movePct: 0.9 }, { ...bar, requireBoth: true }).ok, false);
});

test("wallet and coin guards: a 0x address only, perps only", () => {
  assert.equal(isWalletAddress("0x" + "ab12".repeat(10)), true);
  assert.equal(isWalletAddress("0x123"), false);
  assert.equal(isWalletAddress("not-a-wallet"), false);
  assert.deepEqual([isPerpCoin("BTC"), isPerpCoin("@107"), isPerpCoin("PURR/USDC")], [true, false, false]);
  assert.equal(shortWallet("0x" + "ab12".repeat(10)), "0xab12…ab12");
});

test("card formatters keep prices readable at any magnitude", () => {
  const nbsp = String.fromCharCode(160);
  assert.equal(formatPrice(63540.5), `63${nbsp}540.5`);
  assert.equal(formatPrice(61200), `61${nbsp}200`);
  assert.equal(formatPrice(212.4), "212.4");
  assert.equal(formatPrice(48.213), "48.213");
  assert.equal(formatPrice(0.004213), "0.004213");
  assert.equal(formatUsd(1240.5), `+$1${nbsp}241`);
  assert.equal(formatUsd(-12.345), "-$12.35");
  assert.deepEqual([formatPct(38.24), formatPct(-3.04), formatPct(412.6)], ["+38.2%", "-3.0%", "+413%"]);
  const l = { d: "д", h: "ч", m: "м" };
  assert.deepEqual([formatDuration(12 * 60_000, l), formatDuration(372 * 60_000, l), formatDuration(50 * 3_600_000, l)], ["12м", "6ч 12м", "2д 2ч"]);
});

test("the trade card renders to a JPEG of the advertised size, with and without a chart", async () => {
  const opened = new Date(t0);
  const closed = new Date(t0 + 6 * 3_600_000);
  const candles = Array.from({ length: 80 }, (_, i) => ({ t: t0 - 1_800_000 + i * 300_000, c: 61_000 + i * 30 + Math.sin(i) * 80 }));
  const base = { coin: "BTC", direction: "LONG" as const, leverage: 10, entryPx: 61_200, exitPx: 63_540.5, netPnl: 1240.5, roePct: 38.2, movePct: 3.82, openedAt: opened, closedAt: closed, size: 0.53 };
  const opts = { showUsd: true, showSize: false, wallet: null, handle: "gudov", language: "ru" as const, timezone: "Europe/Moscow" };
  for (const input of [{ ...base, candles }, { ...base, candles: [], roePct: null, leverage: null }]) {
    const image = await renderTradeCard(input, opts);
    assert.deepEqual([...image.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const meta = await sharp(image).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format], [CARD_WIDTH, CARD_HEIGHT, "jpeg"]);
    assert.ok(image.length > 20_000 && image.length < 5_000_000, `card size ${image.length}`);
  }
});

test("trade facts let the validator accept the owner's real numbers and reject invented ones", () => {
  const trade = { coin: "BTC", direction: "LONG", entry_px: 61_200, exit_px: 63_540.5, roe_pct: 38.2, move_pct: 3.82, leverage: 10, net_pnl: 1240.5, max_size: 0.53 } as unknown as TradeRow;
  const facts = tradeFacts(trade, { showUsd: true, showSize: false });
  const good = "Закрыл лонг по BTC: вход 61 200, выход 63 540, плечо x10. Вышло +38.2% на маржу, держал шесть часов. Забрал, что рынок дал, и не стал пересиживать.";
  assert.equal(validateDraft(good, facts, { maxChars: 500, allowedMultiples: [10] }).blocking, false);
  const leverageEn = validateDraft("Closed my BTC 10x long: in at 61,200, out at 63,540. That is +38.2% on margin, took what the market gave.", facts, { maxChars: 280, language: "en", allowedMultiples: [10] });
  assert.equal(leverageEn.blocking, false, leverageEn.violations.map((v) => v.message).join("; "));
  const invented = validateDraft("Закрыл лонг по BTC, забрал 5 400$ за пару часов, вход 61 200, выход 63 540 — всё по плану и без нервов.", facts, { maxChars: 500 });
  assert.ok(invented.violations.some((v) => v.code === "INVENTED_NUMBER"));
  const hidden = tradeFacts(trade, { showUsd: false, showSize: false });
  assert.ok(validateDraft("Закрыл лонг по BTC в плюс: +1 240$ чистыми, вход 61 200, выход 63 540, держал недолго и без суеты.", hidden, { maxChars: 500 }).violations.some((v) => v.code === "INVENTED_NUMBER"), "a hidden PnL must not leak into the text");
  assert.ok(validateDraft("Лонг BTC закрыт, дальше будет 50x, вход 61 200, выход 63 540 — повторяйте за мной, всё просто.", facts, { maxChars: 500, allowedMultiples: [10] }).violations.some((v) => v.code === "FORBIDDEN_PHRASE"));
});
