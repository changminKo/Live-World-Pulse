/** 구계약 norm 파일 읽기 보정 (재리뷰 Med3 — 2026-08-19).
 *
 *  배경: 2026-08-19 전의 GDACS 어댑터는 `todate`를 그대로 `validTo`로 썼다. 그런데
 *  GDACS `todate`는 **경보 해제 시각이 아니라 관측 데이터가 끝난 시각**이라, 미해제
 *  경보도 validTo가 과거로 박힌다. 그 계약으로 쓰인 norm 슬롯(90일 lifecycle 안에
 *  남아 있는 파일들)을 Phase 2 replay가 그대로 읽으면 `sliceInterval(validFrom ≤ T <
 *  validTo)`에서 **당시 활성이었던 경보가 전부 탈락**한다 (실측: latest 422건 중 활성 0건).
 *
 *  방침: 옛 파일을 재작성하지 않는다 (norm은 immutable + generation 계약이고, 90일이면
 *  자연 소멸한다). 대신 **읽는 쪽에서 보정**한다 — 아래 함수를 norm 파일 소비 경로에
 *  통과시키면 구계약 레코드가 신계약과 같은 의미가 된다.
 *
 *  판정 근거: 옛 어댑터는 `status`를 `iscurrent`에서 그대로 만들었다 (미해제 → 'active').
 *  따라서 `source === 'gdacs' && status === 'active' && validTo !== null`은 구계약에서만
 *  나올 수 있는 조합이다 (신계약은 미해제면 validTo = null). 이 조합만 validTo를 null로
 *  보고, 원본 값은 `payload.observedUntil`(신계약과 동일 자리)에 보존한다.
 *  신계약 레코드는 이 함수를 통과해도 형상이 바뀌지 않는다 (idempotent). */
import type { WeatherAlertRecord, WorldRecord } from './types';

/** 이 레코드가 구계약 GDACS 미해제 경보인가 (validTo에 todate가 박힌 상태) */
export function isLegacyGdacsInterval(record: WeatherAlertRecord): boolean {
  return record.source === 'gdacs' && record.status === 'active' && record.validTo !== null;
}

/** 구계약 GDACS interval 1건 보정 — 신계약이면 같은 참조를 그대로 반환 (불변·무복사) */
export function reconcileLegacyWeather(record: WeatherAlertRecord): WeatherAlertRecord {
  if (!isLegacyGdacsInterval(record)) return record;
  return {
    ...record,
    validTo: null,
    payload: {
      ...record.payload,
      observedUntil: record.payload.observedUntil ?? record.validTo,
    },
  };
}

/** norm 슬롯 본문(혼합 레이어 가능)의 읽기 보정 — weather 외 레코드는 손대지 않는다.
 *  Phase 2 replay·백필 등 **옛 norm 파일을 읽는 모든 경로**가 이 함수를 통과해야 한다. */
export function reconcileLegacyRecords(records: readonly WorldRecord[]): WorldRecord[] {
  return records.map((r) =>
    r.layer === 'weather' && r.kind === 'interval' ? reconcileLegacyWeather(r) : r,
  );
}
