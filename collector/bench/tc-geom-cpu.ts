/** 실 GDACS getgeometry 응답으로 트랙 슬롯의 CPU 지배 구간(JSON parse + buildTcGeometry)만 잰다.
 *  fetch(IO)는 Workers CPU에 계상되지 않으므로 제외 — 로컬:프로덕션 비율은 CLAUDE.md 규율대로 1.2~5배. */
import { readFileSync } from 'node:fs';
import { buildTcGeometry, gdacsGeometryUrl } from '../src/sources/gdacs';

/** 입력 = 실 getgeometry 응답 파일. 먼저 받아 둔다 (샌드박스 TLS 프록시 때문에 node fetch가
 *  막히는 환경이 있어 curl로 분리했다):
 *    curl -s "$(node -e "...gdacsGeometryUrl...")" -o .bench/tc-geom.json
 *  기본 경로 .bench/tc-geom.json, TC_GEOM_JSON으로 덮어쓸 수 있다.
 *  참고 URL(2026-08-20 활성 TC SAUDEL-26): gdacsGeometryUrl('TC', 1001305, 6) — 315KB·59feature */
const path = process.env.TC_GEOM_JSON ?? '.bench/tc-geom.json';
let text: string;
try {
  text = readFileSync(path, 'utf8');
} catch {
  process.stderr.write(
    `입력 없음: ${path}\n  curl -s "${gdacsGeometryUrl('TC', 1001305, 6)}" -o ${path}\n`,
  );
  process.exit(1);
}
const runs = 20;
const cpu0 = process.cpuUsage();
let points = 0;
for (let i = 0; i < runs; i += 1) {
  const parsed = JSON.parse(text) as unknown;
  const geom = buildTcGeometry(parsed);
  points += geom.track?.coordinates.length ?? 0;
}
const cpu = process.cpuUsage(cpu0);
const ms = (cpu.user + cpu.system) / 1000 / runs;
const one = buildTcGeometry(JSON.parse(text) as unknown);
process.stdout.write(
  JSON.stringify(
    {
      bytes: Buffer.byteLength(text),
      runs,
      cpuMsPerRun: +ms.toFixed(2),
      trackPoints: one.track?.coordinates.length ?? 0,
      conePoints: one.cone?.coordinates[0]?.length ?? 0,
      centroid: one.centroid,
      sanity: points,
    },
    null,
    2,
  ) + '\n',
);
