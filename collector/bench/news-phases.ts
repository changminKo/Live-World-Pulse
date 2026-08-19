/** news-process 단계별 CPU 분해 (사후 리뷰 High1 후속 — 프로덕션 tail 27ms 원인 규명).
 *  실행: npm run bench:news */
import { readFileSync, existsSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { buildNewsRecords, extractCsv, gdeltRawZipKey } from '../src/sources/gdelt';
import { mergeById, upsertNormSlot } from '../src/r2/norm';
import { latestLayerKey, putSnapshotIfNewer } from '../src/r2/latest';
import { NORM_SLOT_SEC, slotStartSec } from '../src/slots';
import { FakeR2, asBucket } from '../test/fake-r2';

const FX = process.env.LWP_FX_DIR ?? '';

function csvBody(): string {
  if (FX && existsSync(`${FX}/gdelt-export.CSV`)) return readFileSync(`${FX}/gdelt-export.CSV`, 'utf8');
  const row = (i: number): string => {
    const cols = new Array<string>(61).fill('');
    cols[31] = String(5 + (i % 20));
    cols[33] = String(1 + (i % 9));
    cols[52] = `City ${i % 240}, Region, Country`;
    cols[56] = (34 + (i % 240) * 0.21).toFixed(4);
    cols[57] = (128 + (i % 240) * 0.19).toFixed(4);
    cols[60] = `https://example.com/news/article-${i}-with-a-fairly-long-path-segment`;
    return cols.join('\t');
  };
  return Array.from({ length: 2_200 }, (_, i) => row(i)).join('\n');
}

function cpu(label: string, run: () => unknown): unknown {
  const c0 = process.cpuUsage();
  const out = run();
  const c1 = process.cpuUsage(c0);
  process.stdout.write(`${label.padEnd(22)} ${Math.round(((c1.user + c1.system) / 1000) * 10) / 10}ms\n`);
  return out;
}

async function cpuAsync(label: string, run: () => Promise<unknown>): Promise<unknown> {
  const c0 = process.cpuUsage();
  const out = await run();
  const c1 = process.cpuUsage(c0);
  process.stdout.write(`${label.padEnd(22)} ${Math.round(((c1.user + c1.system) / 1000) * 10) / 10}ms\n`);
  return out;
}

const csv = csvBody();
const zip = zipSync({ '20260819231500.export.CSV': strToU8(csv) }, { level: 1 });
const fileMs = Date.UTC(2026, 7, 19, 23, 15, 0);
process.stdout.write(`csv ${csv.length}B / zip ${zip.byteLength}B\n`);

// 워밍업 — 측정 대상 전 경로를 한 번씩 돌려 JIT 비용을 측정에서 분리한다
{
  const warm = new FakeR2();
  const t = extractCsv(new Uint8Array(zip));
  const b = buildNewsRecords(t ?? '', fileMs, fileMs);
  const s0 = slotStartSec(fileMs - 3_600_000, NORM_SLOT_SEC);
  await upsertNormSlot(asBucket(warm), 'news', s0, NORM_SLOT_SEC, b.records, mergeById, { dropped: 0 });
  await putSnapshotIfNewer(asBucket(warm), latestLayerKey('news'), new Date(fileMs - 3_600_000).toISOString(), b.records);
}

const text = cpu('extractCsv(unzip)', () => extractCsv(new Uint8Array(zip))) as string;
const built = cpu('buildNewsRecords', () => buildNewsRecords(text, fileMs, fileMs)) as {
  records: Parameters<typeof mergeById>[1];
  rows: number;
};
process.stdout.write(`records=${built.records.length} rows=${built.rows}\n`);

const fake = new FakeR2();
const slot = slotStartSec(fileMs, NORM_SLOT_SEC);
await cpuAsync('upsertNormSlot', () =>
  upsertNormSlot(asBucket(fake), 'news', slot, NORM_SLOT_SEC, built.records, mergeById, { dropped: 0 }),
);
await cpuAsync('putSnapshotIfNewer', () =>
  putSnapshotIfNewer(asBucket(fake), latestLayerKey('news'), new Date(fileMs).toISOString(), built.records),
);
await cpuAsync('rawZip get+decode', async () => {
  fake.seed(gdeltRawZipKey(fileMs), zip);
  const obj = await fake.get(gdeltRawZipKey(fileMs));
  return new Uint8Array((await obj!.arrayBuffer()) as ArrayBuffer);
});
await cpuAsync('chunk PUT(정규화 결과)', () =>
  fake.put('staging/news/chunk.json', JSON.stringify(built.records)),
);
