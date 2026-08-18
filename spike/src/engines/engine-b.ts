import { createMaplibreEngine } from './engine-a';
import type { EngineFactory } from './types';

/**
 * 후보 B: A와 동일 + interleaved: true — 판정 대상 아님.
 * #9592(깊이/컬링) 버그 재현 증거 수집용 (금지 목록 실측 근거, DESIGN §0).
 */
const factory: EngineFactory = createMaplibreEngine(true);
export default factory;
