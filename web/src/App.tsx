import { Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import Landing from './routes/Landing';

// 지도 번들(maplibre+deck)은 /world 청크로 분리 — 랜딩에서 로드 금지 (PLAN §10)
const WorldPage = lazy(() => import('./world/WorldPage'));

function WorldFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-[var(--bg-0)]">
      <p className="mono text-[length:var(--text-sm)] text-[var(--text-lo)]">LOADING GLOBE…</p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/world"
          element={
            <Suspense fallback={<WorldFallback />}>
              <WorldPage />
            </Suspense>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
