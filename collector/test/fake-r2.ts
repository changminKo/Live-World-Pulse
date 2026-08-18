/** 테스트용 fake R2 — 프로덕션 코드가 쓰는 표면(get/put/head/list/delete)만 구현.
 *  조건부 PUT 의미론: etagMatches(CAS), etagDoesNotMatch:'*'(create-if-absent)를
 *  실제 R2와 동일하게 판정 (조건 불충족 시 null 반환).
 *
 *  fidelity 한계 (재리뷰 Low — 알고 쓰는 차이):
 *  - etag: 실제 R2는 MD5 기반 unquoted `etag`와 quoted `httpEtag`를 구분하지만
 *    여기서는 quoted 순번 문자열 하나만 쓴다. 프로덕션 코드는 etag를 불투명
 *    토큰으로 same-value 비교만 하므로(onlyIf 왕복) 판정 결과는 동일.
 *  - list cursor: 실제 R2는 불투명 토큰, 여기서는 숫자 offset 문자열. 프로덕션
 *    코드는 cursor를 그대로 되돌려주기만 하므로 pagination 경로 판정은 동일.
 *  - 조건부 PUT 실패=null, create-if-absent, CAS, strong read-after-write 등
 *    사용 중인 핵심 의미론은 Cloudflare Workers R2 API 문서와 일치. */

interface Stored {
  body: Uint8Array;
  etag: string;
  size: number;
}

interface FakeConditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
}

function toBytes(value: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return new Uint8Array(value);
}

function objectOf(key: string, stored: Stored) {
  const bytes = stored.body;
  return {
    key,
    etag: stored.etag,
    size: stored.size,
    json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

export class FakeR2 {
  readonly store = new Map<string, Stored>();
  /** put 직전 훅 — 경합(다른 invocation의 선행 쓰기) 시뮬레이션용. seed()는 훅을 우회한다. */
  hooks: { beforePut?: (key: string) => void | Promise<void> } = {};
  /** list 페이지 크기 상한 — pagination 경로 강제용 (실 R2의 limit보다 작게 자를 수 있음) */
  maxPageSize = 1000;
  putCount = 0;
  private seq = 0;

  /** 훅·조건 없이 직접 주입 (경쟁자 쓰기·사전 상태 세팅) */
  seed(key: string, value: string | ArrayBuffer | Uint8Array, sizeOverride?: number): void {
    const body = toBytes(value);
    this.store.set(key, { body, etag: `"e${(this.seq += 1)}"`, size: sizeOverride ?? body.byteLength });
  }

  textOf(key: string): string | null {
    const stored = this.store.get(key);
    return stored ? new TextDecoder().decode(stored.body) : null;
  }

  jsonOf<T>(key: string): T | null {
    const text = this.textOf(key);
    return text === null ? null : (JSON.parse(text) as T);
  }

  async get(key: string) {
    const stored = this.store.get(key);
    return stored ? objectOf(key, stored) : null;
  }

  async head(key: string) {
    const stored = this.store.get(key);
    return stored ? { key, etag: stored.etag, size: stored.size } : null;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: { onlyIf?: FakeConditional },
  ) {
    await this.hooks.beforePut?.(key);
    const existing = this.store.get(key);
    const cond = options?.onlyIf;
    if (cond) {
      if (cond.etagMatches !== undefined && (!existing || existing.etag !== cond.etagMatches)) {
        return null;
      }
      if (cond.etagDoesNotMatch === '*' && existing) return null;
    }
    this.putCount += 1;
    const body = toBytes(value);
    const stored: Stored = { body, etag: `"e${(this.seq += 1)}"`, size: body.byteLength };
    this.store.set(key, stored);
    return objectOf(key, stored);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const prefix = options?.prefix ?? '';
    const limit = Math.min(options?.limit ?? 1000, this.maxPageSize);
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((k) => {
        const stored = this.store.get(k);
        if (!stored) throw new Error(`fake list race: ${k}`);
        return { key: k, size: stored.size, etag: stored.etag };
      }),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }

  keysWithPrefix(prefix: string): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export function asBucket(fake: FakeR2): R2Bucket {
  return fake as unknown as R2Bucket;
}
